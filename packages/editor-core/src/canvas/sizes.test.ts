import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CANVAS_SIZE,
	getAdoptedCanvasSizeForFirstVisualElement,
	getAdoptedCanvasSizeForImportedMedia,
} from "./sizes";

const base = {
	currentSize: { ...DEFAULT_CANVAS_SIZE },
	currentMode: "preset" as const,
	hadVisualMediaBefore: false,
};

describe("getAdoptedCanvasSizeForImportedMedia (first-import aspect adoption)", () => {
	it("adopts a portrait canvas for a portrait phone video", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("keeps the exact aspect for a 4K portrait source, normalized to the 1080 class", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 2160, height: 3840 }],
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("returns null for a landscape 16:9 video (canvas already the default shape)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 3840, height: 2160 }],
			}),
		).toBeNull();
	});

	it("never upscales a small source's shape past its own pixels", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "video", width: 640, height: 480 }],
			}),
		).toEqual({ width: 640, height: 480 });
	});

	it("caps the long side at 1920 for extreme aspect ratios", () => {
		const adopted = getAdoptedCanvasSizeForImportedMedia({
			...base,
			importedAssets: [{ type: "video", width: 4320, height: 1080 }],
		});
		expect(adopted).not.toBeNull();
		expect(Math.max(adopted!.width, adopted!.height)).toBeLessThanOrEqual(1920);
		// aspect preserved within even-rounding tolerance
		expect(adopted!.width / adopted!.height).toBeCloseTo(4, 1);
	});

	it("produces even dimensions (encoder requirement)", () => {
		const adopted = getAdoptedCanvasSizeForImportedMedia({
			...base,
			importedAssets: [{ type: "video", width: 1079, height: 1921 }],
		});
		expect(adopted).not.toBeNull();
		expect(adopted!.width % 2).toBe(0);
		expect(adopted!.height % 2).toBe(0);
	});

	it("respects an existing visual asset (aspect already established)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				hadVisualMediaBefore: true,
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("respects an explicit user canvas choice (non-default size)", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				currentSize: { width: 1080, height: 1080 },
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("respects custom mode", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				currentMode: "custom",
				importedAssets: [{ type: "video", width: 1080, height: 1920 }],
			}),
		).toBeNull();
	});

	it("ignores audio assets and assets without dimensions", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [
					{ type: "audio" },
					{ type: "video", width: 0, height: 0 },
				],
			}),
		).toBeNull();
	});

	it("adopts from an image import too", () => {
		expect(
			getAdoptedCanvasSizeForImportedMedia({
				...base,
				importedAssets: [{ type: "image", width: 3000, height: 3000 }],
			}),
		).toEqual({ width: 1080, height: 1080 });
	});
});

describe("getAdoptedCanvasSizeForFirstVisualElement (GitHub #30 / Linear PAV-81)", () => {
	const portrait = { type: "video", width: 1080, height: 1920 };
	const landscape = { type: "video", width: 1920, height: 1080 };
	const first = {
		currentSize: { ...DEFAULT_CANVAS_SIZE },
		currentMode: "preset" as const,
		isFirstVisualElement: true,
	};

	it("adopts a portrait canvas for a portrait clip in a factory-default project", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({ ...first, asset: portrait }),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("leaves a factory-default landscape canvas alone for a landscape clip", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({ ...first, asset: landscape }),
		).toBeNull();
	});

	it("preserves an explicit 1:1 choice", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				currentSize: { width: 1080, height: 1080 },
				asset: portrait,
			}),
		).toBeNull();
	});

	it("preserves an explicit 9:16 choice", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				currentSize: { width: 1080, height: 1920 },
				asset: { type: "video", width: 720, height: 1280 },
			}),
		).toBeNull();
	});

	it("preserves an explicit 16:9 choice even when its size differs from the default", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				currentSize: { width: 1280, height: 720 },
				asset: portrait,
			}),
		).toBeNull();
	});

	it("preserves an explicit custom resolution", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				currentSize: { width: 1440, height: 1080 },
				currentMode: "custom",
				asset: portrait,
			}),
		).toBeNull();
	});

	it("does not adopt again once a visual element exists (multiple imports)", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				isFirstVisualElement: false,
				asset: portrait,
			}),
		).toBeNull();
	});

	it("sizes from the SOURCE dims, not the mobile preview proxy's", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				asset: {
					type: "video",
					width: 540,
					height: 960,
					sourceWidth: 1080,
					sourceHeight: 1920,
				},
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	it("ignores an asset with no usable dimensions", () => {
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				...first,
				asset: { type: "video", width: 0, height: 0 },
			}),
		).toBeNull();
	});
});
