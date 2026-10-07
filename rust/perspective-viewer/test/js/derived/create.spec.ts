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

import { test, expect } from "../helpers.ts";
import type { Page } from "@playwright/test";
import { TABLE, hostedTables, restoreWorkspace, ready } from "./helpers.ts";

test.beforeEach(ready);

function stack(page: Page) {
    return page.locator("perspective-viewer").locator("#derived_stack");
}

async function panel(page: Page, extra: Record<string, unknown> = {}) {
    await restoreWorkspace(page, {
        panels: { one: { table: TABLE, plugin: "Debug", ...extra } },
        active: "one",
    });
}

async function create(page: Page) {
    await stack(page).locator(".derived_create").click();
}

async function boundTable(page: Page) {
    return await page.evaluate(async () => {
        const viewer = document.querySelector("perspective-viewer")!;
        // @ts-ignore
        return (await viewer.save()).table;
    });
}

test.describe("derive a table from the settings sidebar", () => {
    test("the group is absent with no pivots and no derivation", async ({
        page,
    }) => {
        await panel(page);
        await expect(stack(page)).toHaveCount(0);
    });

    test("the create button appears once group_by is set", async ({ page }) => {
        await panel(page, { group_by: ["Region"] });
        await expect(stack(page).locator(".derived_create")).toHaveCount(1);
    });

    test("the create button appears once split_by is set", async ({ page }) => {
        await panel(page, { split_by: ["Region"] });
        await expect(stack(page).locator(".derived_create")).toHaveCount(1);
    });

    test("the create button disappears when the pivots are cleared", async ({
        page,
    }) => {
        await panel(page, { group_by: ["Region"] });
        await expect(stack(page).locator(".derived_create")).toHaveCount(1);

        await page.evaluate(async () => {
            const viewer = document.querySelector("perspective-viewer")!;
            // @ts-ignore
            await viewer.restore({ group_by: [] });
            // @ts-ignore
            await viewer.flush();
        });

        await expect(stack(page)).toHaveCount(0);
    });

    test("the group renders below the inactive columns", async ({ page }) => {
        await panel(page, { group_by: ["Region"] });
        const order = await page.evaluate(() => {
            const root = document
                .querySelector("perspective-viewer")!
                .shadowRoot!.querySelector("#settings_panel")!;

            return Array.from(root.children).map((x) => x.id);
        });

        expect(order.at(-1)).toBe("derived_stack");
    });

    test("creates under a generated name and rebinds the panel", async ({
        page,
    }) => {
        await panel(page, { group_by: ["Region"] });
        await create(page);
        await expect(
            stack(page).locator(".derived_level.is-own .derived_label"),
        ).toHaveText("New Table 1");

        expect(await hostedTables(page)).toContain("New Table 1");
        expect(await boundTable(page)).toBe("New Table 1");
    });

    test("a second creation generates the next free name", async ({ page }) => {
        await panel(page, { group_by: ["Region"] });
        await create(page);
        await expect(
            stack(page).locator(".derived_level.is-own .derived_label"),
        ).toHaveText("New Table 1");

        await page.evaluate(async () => {
            const viewer = document.querySelector("perspective-viewer")!;
            // @ts-ignore
            await viewer.restore({ group_by: ["State"] });
            // @ts-ignore
            await viewer.flush();
        });

        await create(page);
        await expect(
            stack(page).locator(".derived_level.is-own .derived_label"),
        ).toHaveText("New Table 2");

        await expect(stack(page).locator(".derived_level")).toHaveCount(2);
        expect(await boundTable(page)).toBe("New Table 2");
    });

    test("the created table carries the group_by as key columns", async ({
        page,
    }) => {
        await panel(page, { group_by: ["Region"] });
        await create(page);
        await expect(
            stack(page).locator(".derived_level.is-own .derived_label"),
        ).toHaveText("New Table 1");

        const columns = await page.evaluate(async () => {
            const viewer = document.querySelector("perspective-viewer")!;
            // @ts-ignore
            const table = await viewer.getTable();
            return Object.keys(await table.schema());
        });

        expect(columns.join(" ")).toContain("Region (Group by 1)");
    });

    test("a derived panel with no pivots still shows its chain", async ({
        page,
    }) => {
        await restoreWorkspace(page, {
            panels: { one: { table: "Region Totals", plugin: "Debug" } },
            active: "one",
            derived_tables: {
                "Region Totals": { table: TABLE, group_by: ["Region"] },
            },
        });

        await expect(
            stack(page).locator(".derived_level.is-own .derived_label"),
        ).toHaveText("Region Totals");

        await expect(stack(page).locator(".derived_create")).toHaveCount(0);
    });
});
