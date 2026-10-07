// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃ ██████ ██████ ██████       █      █      █      █      █ █▄  ▀███ █       ┃
// ┃ ▄▄▄▄▄█ █▄▄▄▄▄ ▄▄▄▄▄█  ▀▀▀▀▀█▀▀▀▀▀ █ ▀▀▀▀▀█ ████████▌▐███ ███▄  ▀█ █ ▀▀▀▀▀ ┃
// ┃ █▀▀▀▀▀ █▀▀▀▀▀ █▀██▀▀ ▄▄▄▄▄ █ ▄▄▄▄▄█ ▄▄▄▄▄█ ████████▌▐███ █████▄   █ ▄▄▄▄▄ ┃
// ┃ █      ██████ █  ▀█▄       █ ██████      █      ███▌▐███ ███████▄ █       ┃
// ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
// ┃ Copyright (c) 2017, the Perspective Authors.                              ┃
// ┃ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ ┃
// ┃ This file is part of the Perspective library, distributed under the terms ┃
// ┃ of the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

//! Reconcile the workspace's derived `Table`s with a restored
//! `derived_tables` map.

use std::collections::{BTreeMap, BTreeSet};

use perspective_js::utils::*;

use crate::config::DerivedTableConfig;
use crate::derived::topo_order;
use crate::tasks::build_derived;
use crate::workspace::Workspace;

/// Build every derivation in `configs` that is not already reusable,
/// parents-first, deferring any whose parent is not yet hosted.
pub async fn apply_derived_tables(
    workspace: &Workspace,
    configs: BTreeMap<String, DerivedTableConfig>,
) -> ApiResult<()> {
    let order = topo_order(&configs).map_err(ApiError::new)?;
    let reuse = workspace.derived_reusable(&order, &configs);
    let mut deferred = BTreeMap::new();
    for name in &order {
        let config = &configs[name];
        if reuse.contains(name) {
            continue;
        }

        if deferred.contains_key(&config.table) {
            deferred.insert(name.clone(), config.clone());
            continue;
        }

        if workspace.is_derived(name) {
            let consumers = workspace.derived_consumers(name);
            if consumers > 0 {
                return Err(ApiError::new(format!(
                    "Cannot redefine `{name}` while {consumers} panels or tables read it"
                )));
            }

            if let Some(stale) = workspace.take_derived(name) {
                stale.delete().await?;
            }
        }

        let Some(client) = workspace
            .resolve_client_for_table(&config.table, None)
            .await
        else {
            deferred.insert(name.clone(), config.clone());
            continue;
        };

        if !build_derived(&client, workspace, name, &config.table, &config.view_config).await? {
            deferred.insert(name.clone(), config.clone());
        }
    }

    workspace.set_derived_pending(deferred);
    Ok(())
}

/// Delete every registered derivation absent from `keep`, children first.
pub async fn prune_derived(workspace: &Workspace, keep: &BTreeSet<String>) -> ApiResult<()> {
    let mut doomed = workspace
        .derived_names()
        .into_iter()
        .filter(|name| !keep.contains(name))
        .collect::<Vec<_>>();

    doomed.sort_by_key(|name| std::cmp::Reverse(workspace.derived_ancestors(name).len()));
    for name in doomed {
        if workspace.derived_consumers(&name) > 0 {
            tracing::warn!("Keeping derived table \"{name}\", which is still read");
            continue;
        }

        if let Some(derived) = workspace.take_derived(&name)
            && let Err(err) = derived.delete().await
        {
            tracing::warn!("Failed to delete derived table \"{name}\": {err}");
        }
    }

    Ok(())
}

/// Retry the derivations whose parent was not hosted when they were restored.
pub async fn resume_derived(workspace: &Workspace) -> ApiResult<()> {
    let pending = workspace.derived_pending();
    if pending.is_empty() {
        return Ok(());
    }

    let mut configs = workspace.derived_configs();
    configs.extend(pending);
    apply_derived_tables(workspace, configs).await
}
