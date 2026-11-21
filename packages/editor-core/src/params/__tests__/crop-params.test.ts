import { describe, expect, test } from "bun:test";
import type { ElementType } from "@/timeline/types";
import { getBuiltInElementParams } from "../registry";

describe("crop params", () => {
	const croppable: ElementType[] = ["video", "image", "sticker", "graphic"];

	for (const type of croppable) {
		test(`${type} exposes crop.x/y/width/height with sane defaults`, () => {
			const keys = getBuiltInElementParams({ type }).map((p) => p.key);
			expect(keys).toContain("crop.x");
			expect(keys).toContain("crop.y");
			expect(keys).toContain("crop.width");
			expect(keys).toContain("crop.height");
		});
	}
});
