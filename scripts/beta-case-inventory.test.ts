import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const VALID_STATUSES = new Set(["PASS", "FAIL", "VERIFY", "BLOCKED"]);

describe("docs/qa/beta-case-inventory.json integrity", () => {
	const inventoryPath = resolve(
		import.meta.dir,
		"..",
		"docs",
		"qa",
		"beta-case-inventory.json",
	);
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
		summary?: Record<string, number | string>;
		cases?: Array<{ id?: string; status?: string; [k: string]: unknown }>;
	};

	test("cases exist and each row has required fields and a valid status", () => {
		expect(Array.isArray(inventory.cases)).toBe(true);
		const cases = inventory.cases ?? [];
		expect(cases.length).toBeGreaterThan(0);
		for (const c of cases) {
			expect(typeof c.id).toBe("string");
			expect((c.id ?? "").length).toBeGreaterThan(0);
			expect(typeof c.area).toBe("string");
			expect(typeof c.case).toBe("string");
			expect(typeof c.evidence).toBe("string");
			expect(VALID_STATUSES.has(c.status ?? "")).toBe(true);
		}
	});

	test("case IDs are unique", () => {
		const cases = inventory.cases ?? [];
		const ids = cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("summary matches the case rows", () => {
		const cases = inventory.cases ?? [];
		const counts = { PASS: 0, FAIL: 0, VERIFY: 0, BLOCKED: 0 };
		for (const c of cases) {
			const s = c.status as keyof typeof counts;
			expect(VALID_STATUSES.has(s)).toBe(true);
			counts[s] += 1;
		}
		const summary = inventory.summary ?? {};
		expect(summary.total).toBe(cases.length);
		expect(summary.pass).toBe(counts.PASS);
		expect(summary.fail).toBe(counts.FAIL);
		expect(summary.verify).toBe(counts.VERIFY);
		expect(summary.blocked).toBe(counts.BLOCKED);
	});
});
