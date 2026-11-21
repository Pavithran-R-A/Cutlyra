import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browseCategory } from "@cutlyra/editor-core/stickers";

/**
 * The mobile shell bundles sticker assets from `apps/mobile/public`, so a
 * sticker that browses fine can still ship as an empty tile if its file is
 * missing or unloadable. These checks run against the directory the app
 * actually copies into its web bundle — not the provider's promise.
 */
const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");

type AssetCheck = { id: string; problem: string };

function svgProblems({ path }: { path: string }): string[] {
	const markup = readFileSync(path, "utf8");
	const problems: string[] = [];
	if (!/<svg[\s>]/i.test(markup)) problems.push("no <svg> root");
	if (!/viewBox=/i.test(markup) && !/width=/i.test(markup)) {
		problems.push("no viewBox/width (unsized image)");
	}
	if (!/<(path|rect|circle|ellipse|polygon|polyline|line|g|use)[\s>]/i.test(markup)) {
		problems.push("no drawable geometry");
	}
	// Offline-first: a bundled sticker that fetches a remote font/image is
	// blank on a plane, and a privacy problem in a local editor.
	if (/https?:\/\//i.test(markup.replace(/xmlns(:\w+)?="[^"]*"/gi, ""))) {
		problems.push("references a remote URL");
	}
	return problems;
}

describe("bundled sticker assets", () => {
	test("every flags sticker has a loadable bundled file", async () => {
		const items = (await browseCategory({ category: "flags" })).sections.flatMap(
			(section) => section.items,
		);
		expect(items.length).toBeGreaterThan(0);

		const problems: AssetCheck[] = [];
		for (const item of items) {
			const relative = item.previewUrl.replace(/^\//, "");
			const path = join(PUBLIC_DIR, relative);
			if (!existsSync(path)) {
				problems.push({ id: item.id, problem: `missing ${relative}` });
				continue;
			}
			for (const problem of svgProblems({ path })) {
				problems.push({ id: item.id, problem });
			}
		}
		expect(problems.slice(0, 10)).toEqual([]);
	});

	test("shapes are rendered locally, not fetched", async () => {
		const items = (await browseCategory({ category: "shapes" })).sections.flatMap(
			(section) => section.items,
		);
		expect(items.length).toBeGreaterThanOrEqual(12);
		for (const item of items) {
			expect(item.previewUrl.startsWith("data:image/svg+xml")).toBe(true);
		}
	});
});
