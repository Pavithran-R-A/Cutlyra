import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type CaseRow = { id: string; status: "PASS" | "FAIL" | "VERIFY" | "BLOCKED" };
type Inventory = {
	build?: { product_commit?: string };
	historical_baseline?: { generated?: string; build?: { product_commit?: string }; summary_as_recorded_2026_11_03?: unknown };
	summary: { pass: number; fail: number; blocked: number; verify: number; total: number; note?: string };
	cases: CaseRow[];
};

const inventoryPath = join(process.cwd(), "docs/qa/beta-case-inventory.json");

describe("docs/qa/beta-case-inventory.json integrity", () => {
	test("summary counts match the case rows", async () => {
		const raw = await readFile(inventoryPath, "utf8");
		const inventory = JSON.parse(raw) as Inventory;
		const computed = inventory.cases.reduce(
			(acc, row) => {
				if (row.status === "PASS") acc.pass += 1;
				else if (row.status === "FAIL") acc.fail += 1;
				else if (row.status === "VERIFY") acc.verify += 1;
				else if (row.status === "BLOCKED") acc.blocked += 1;
				acc.total += 1;
				return acc;
			},
			{ pass: 0, fail: 0, verify: 0, blocked: 0, total: 0 },
		);
		expect({
			pass: inventory.summary.pass,
			fail: inventory.summary.fail,
			verify: inventory.summary.verify,
			blocked: inventory.summary.blocked,
			total: inventory.summary.total,
		}).toEqual(computed);
		expect(inventory.summary.total).toBe(inventory.cases.length);
	});

	test("case IDs are unique", async () => {
		const raw = await readFile(inventoryPath, "utf8");
		const inventory = JSON.parse(raw) as Inventory;
		const ids = inventory.cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("statuses are valid", async () => {
		const raw = await readFile(inventoryPath, "utf8");
		const inventory = JSON.parse(raw) as Inventory;
		for (const row of inventory.cases) {
			expect(["PASS", "FAIL", "VERIFY", "BLOCKED"]).toContain(row.status);
		}
	});

	test("assessed build is current and historical baseline snapshot is preserved", async () => {
		const raw = await readFile(inventoryPath, "utf8");
		const inventory = JSON.parse(raw) as Inventory;
		expect(inventory.build?.product_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(inventory.historical_baseline?.generated).toBeTruthy();
		expect(inventory.historical_baseline?.build?.product_commit).toBeTruthy();
		expect(inventory.historical_baseline?.summary_as_recorded_2026_11_03).toBeTruthy();
	});
});
