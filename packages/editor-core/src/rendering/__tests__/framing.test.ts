import { describe, expect, it } from "bun:test";
import {
	DEFAULT_FRAMING,
	readFramingFromParams,
	resolveFramingScale,
} from "../framing";

describe("framing (#22)", () => {
	it("defaults to fit and reads fill", () => {
		expect(DEFAULT_FRAMING).toBe("fit");
		expect(readFramingFromParams({ params: undefined })).toBe("fit");
		expect(readFramingFromParams({ params: {} })).toBe("fit");
		expect(readFramingFromParams({ params: { framing: "fit" } })).toBe("fit");
		expect(readFramingFromParams({ params: { framing: "fill" } })).toBe("fill");
		expect(readFramingFromParams({ params: { framing: "weird" } })).toBe("fit");
	});

	it("uses contain scale for fit and cover scale for fill", () => {
		// Landscape source 16:9 in a portrait 9:16 canvas
		const canvas = { canvasWidth: 1080, canvasHeight: 1920 };
		const landscape = { sourceWidth: 1920, sourceHeight: 1080 };
		const fit = resolveFramingScale({ ...canvas, ...landscape, framing: "fit" });
		const fill = resolveFramingScale({ ...canvas, ...landscape, framing: "fill" });
		expect(fit).toBeCloseTo(1080 / 1920); // 0.5625, fits width, pillarboxes vertically
		expect(fill).toBeCloseTo(1920 / 1080); // ~1.777, covers height, crops horizontally
		expect(fill).toBeGreaterThan(fit);
		// Fit keeps whole frame inside canvas
		expect(landscape.sourceWidth * fit).toBeCloseTo(1080);
		expect(landscape.sourceHeight * fit).toBeLessThanOrEqual(1080);
		// Fill covers canvas
		expect(landscape.sourceWidth * fill).toBeGreaterThanOrEqual(1080);
		expect(landscape.sourceHeight * fill).toBeCloseTo(1920);
	});

	it("handles portrait source in landscape canvas", () => {
		const canvas = { canvasWidth: 1920, canvasHeight: 1080 };
		const portrait = { sourceWidth: 1080, sourceHeight: 1920 };
		const fit = resolveFramingScale({ ...canvas, ...portrait, framing: "fit" });
		const fill = resolveFramingScale({ ...canvas, ...portrait, framing: "fill" });
		expect(fit).toBeCloseTo(1080 / 1920);
		expect(fill).toBeCloseTo(1920 / 1080);
		expect(portrait.sourceHeight * fit).toBeCloseTo(1080);
		expect(portrait.sourceWidth * fill).toBeCloseTo(1920);
	});

	it("is identical for matching aspect ratios", () => {
		const args = { canvasWidth: 1080, canvasHeight: 1920, sourceWidth: 1080, sourceHeight: 1920 };
		expect(resolveFramingScale({ ...args, framing: "fit" })).toBe(1);
		expect(resolveFramingScale({ ...args, framing: "fill" })).toBe(1);
	});

	it("guards invalid source dimensions", () => {
		expect(resolveFramingScale({ canvasWidth: 1080, canvasHeight: 1920, sourceWidth: 0, sourceHeight: 1080, framing: "fill" })).toBe(1);
	});
});
