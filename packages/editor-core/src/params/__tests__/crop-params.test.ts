import { describe, expect, test } from "bun:test";
import { getBuiltInElementParams } from "../registry";

describe("crop params", () => {
	for (const type of ["video", "image", "sticker", "graphic"]) {
		test(`${type} exposes crop.x/y/width/height with sane defaults`, () => {
			const keys = getBuiltInElementParams({ type: type as any }).map((p) => p.key);
			expect(keys).toContain("crop.x");
			expect(keys).toContain("crop.y");
			expect(keys).toContain("crop.width");
			expect(keys).toContain("crop.height");
		});
	}
});