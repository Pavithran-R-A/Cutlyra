import { describe, expect, test } from "bun:test";
import { browseCategory, resolveStickerId } from "../index";
import { STICKER_CATEGORIES } from "../categories";
import type { StickerCategory, StickerItem } from "../types";

/**
 * Owner report: "Stickers appears empty / categories are unusable". These are
 * the invariants that make that impossible to ship again — every category the
 * panel offers must actually produce stickers, and every sticker must have a
 * preview URL that resolves (the tile is the entire affordance).
 *
 * The panel derives its chips from `STICKER_CATEGORIES`, so this walks the same
 * source of truth rather than a hand-written list that could drift from it.
 */
const panelCategories = (Object.keys(STICKER_CATEGORIES) as StickerCategory[]).filter(
	(category) => category !== "all",
);

async function itemsFor(category: StickerCategory): Promise<StickerItem[]> {
	const result = await browseCategory({ category });
	return result.sections.flatMap((section) => section.items);
}

describe("sticker library", () => {
	test("the panel offers at least two categories", () => {
		expect(panelCategories.length).toBeGreaterThanOrEqual(2);
	});

	for (const category of panelCategories) {
		test(`category "${category}" is not empty`, async () => {
			const items = await itemsFor(category);
			expect(items.length).toBeGreaterThan(0);
		});
	}

	test("flags cover the whole bundled country dataset", async () => {
		expect((await itemsFor("flags")).length).toBeGreaterThanOrEqual(250);
	});

	test("shapes is a real library, not four primitives", async () => {
		const items = await itemsFor("shapes");
		expect(items.length).toBeGreaterThanOrEqual(12);
		const ids = items.map((item) => item.id);
		// The stickers a user would reasonably look for in a shapes library.
		for (const expected of [
			"shapes:square",
			"shapes:circle",
			"shapes:triangle",
			"shapes:hexagon",
			"shapes:star",
			"shapes:heart",
			"shapes:arrow",
		]) {
			expect(ids).toContain(expected);
		}
	});

	for (const category of panelCategories) {
		test(`"${category}" items are unique, well-formed and resolvable`, async () => {
			const items = await itemsFor(category);
			const ids = items.map((item) => item.id);
			expect(new Set(ids).size).toBe(ids.length);

			for (const item of items) {
				expect(item.id.startsWith(`${item.provider}:`)).toBe(true);
				expect(item.name.length).toBeGreaterThan(0);
				expect(item.previewUrl.length).toBeGreaterThan(0);
				// What the grid renders is exactly what the canvas will load —
				// a mismatch here is the "thumbnail works, sticker is blank"
				// failure mode.
				expect(resolveStickerId({ stickerId: item.id })).toBe(item.previewUrl);
			}
		});
	}

	test("a shape sticker id from an older project still resolves", () => {
		// Projects saved before the curated library stored the raw graphic id.
		for (const legacyId of [
			"shapes:rectangle",
			"shapes:ellipse",
			"shapes:polygon",
			"shapes:star",
		]) {
			expect(resolveStickerId({ stickerId: legacyId }).length).toBeGreaterThan(0);
		}
	});
});
