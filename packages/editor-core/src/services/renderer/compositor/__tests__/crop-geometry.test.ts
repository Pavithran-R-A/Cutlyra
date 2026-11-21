import { describe, expect, test } from "bun:test";
import { canvasDouble } from "@/test-support/canvas-double";
import { ImageNode } from "../../nodes/image-node";
import type { ResolvedVisualSourceNodeState } from "../../nodes/visual-node";
import { buildFrameDescriptor, computeVisualTransform } from "../frame-descriptor";

/**
 * Preview crop geometry: the quad must shrink to the CROPPED source's framing
 * footprint (crop then fit/fill), while the texture stays full-size and the
 * shader samples the sub-rectangle. Native export mirrors this by putting
 * Media3's `Crop` before the framing `Presentation`.
 */
// `bun test` has no OffscreenCanvas, and the descriptor only reads the output
// size — see FrameCanvasSize.
const renderer = { width: 1000, height: 1000 };

function transform({
	crop,
	framing = "fit",
	sourceWidth = 1000,
	sourceHeight = 1000,
	scaleX = 1,
	scaleY = 1,
	rotate = 0,
	positionX = 0,
	positionY = 0,
}: {
	crop?: { x: number; y: number; width: number; height: number };
	framing?: "fit" | "fill";
	sourceWidth?: number;
	sourceHeight?: number;
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
	positionX?: number;
	positionY?: number;
}) {
	const resolved: ResolvedVisualSourceNodeState = {
		localTime: 0,
		opacity: 1,
		effectPasses: [],
		transform: {
			scaleX,
			scaleY,
			rotate,
			position: { x: positionX, y: positionY },
		},
		source: canvasDouble(),
		sourceWidth,
		sourceHeight,
	};
	return computeVisualTransform({
		renderer,
		crop,
		framing,
		sourceWidth,
		sourceHeight,
		resolved,
	});
}

describe("crop -> frame descriptor", () => {
	test("emits sourceRect and keeps the full-size texture", async () => {
		const crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
		const node = new ImageNode({
			url: "fixture.png",
			duration: 1000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 1000,
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			opacity: 1,
			crop,
		});
		node.resolved = {
			localTime: 0,
			opacity: 1,
			effectPasses: [],
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			source: canvasDouble(),
			sourceWidth: 1000,
			sourceHeight: 1000,
		};

		const { frame, textures } = await buildFrameDescriptor({
			node,
			renderer,
		});
		const layer = frame.items[0];
		if (layer.type !== "layer") throw new Error("expected a layer item");
		expect(layer.sourceRect).toEqual(crop);
		expect(layer.transform.width).toBeCloseTo(500);
		expect(textures).toHaveLength(1);
		expect(textures[0]).toMatchObject({ kind: "external", width: 1000, height: 1000 });
	});

	test("omits sourceRect for an uncropped clip", async () => {
		const node = new ImageNode({
			url: "fixture.png",
			duration: 1000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 1000,
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			opacity: 1,
		});
		node.resolved = {
			localTime: 0,
			opacity: 1,
			effectPasses: [],
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			source: canvasDouble(),
			sourceWidth: 1000,
			sourceHeight: 1000,
		};

		const { frame } = await buildFrameDescriptor({
			node,
			renderer,
		});
		const layer = frame.items[0];
		if (layer.type !== "layer") throw new Error("expected a layer item");
		expect("sourceRect" in layer).toBe(false);
	});
});

describe("video frame revisions reach the texture cache", () => {
	test("a pooled-canvas frame revision becomes the texture contentHash", async () => {
		const node = new ImageNode({
			url: "fixture.png",
			duration: 1000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 1000,
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			opacity: 1,
			crop: { x: 0, y: 0, width: 0.5, height: 1 },
		});
		node.resolved = {
			localTime: 0,
			opacity: 1,
			effectPasses: [],
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			source: canvasDouble(),
			sourceWidth: 1000,
			sourceHeight: 1000,
			sourceRevision: "video:120000:0.5",
		};

		const { textures } = await buildFrameDescriptor({
			node,
			renderer,
		});
		expect(textures[0]).toMatchObject({
			kind: "external",
			contentHash: "video:120000:0.5",
		});
	});

	test("an image source (no revision) emits no contentHash", async () => {
		const node = new ImageNode({
			url: "fixture.png",
			duration: 1000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 1000,
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			opacity: 1,
		});
		node.resolved = {
			localTime: 0,
			opacity: 1,
			effectPasses: [],
			transform: { scaleX: 1, scaleY: 1, rotate: 0, position: { x: 0, y: 0 } },
			source: canvasDouble(),
			sourceWidth: 1000,
			sourceHeight: 1000,
		};

		const { textures } = await buildFrameDescriptor({
			node,
			renderer,
		});
		expect(textures[0]).not.toHaveProperty("contentHash");
	});
});

describe("crop -> preview quad geometry", () => {
	test("uncropped geometry is unchanged", () => {
		expect(transform({})).toEqual({
			centerX: 500,
			centerY: 500,
			width: 1000,
			height: 1000,
			rotationDegrees: 0,
			flipX: false,
			flipY: false,
		});
	});

	test("a half-width crop fits the kept region, not the whole source", () => {
		const cropped = transform({ crop: { x: 0.5, y: 0, width: 0.5, height: 1 } });
		// 500x1000 kept region in a 1000x1000 canvas -> fit scale 1.
		expect(cropped.width).toBeCloseTo(500);
		expect(cropped.height).toBeCloseTo(1000);
		expect(cropped.centerX).toBeCloseTo(500);
	});

	test("a centred quarter crop zooms the kept pixels to the canvas", () => {
		const cropped = transform({ crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
		// 500x500 kept region, fit into 1000x1000 -> scale 2.
		expect(cropped.width).toBeCloseTo(1000);
		expect(cropped.height).toBeCloseTo(1000);
	});

	test("fill still covers the canvas after a crop changes the aspect", () => {
		const cropped = transform({
			crop: { x: 0, y: 0, width: 0.5, height: 1 },
			framing: "fill",
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		// 960x1080 kept (8:9) -> fill scale max(1000/960, 1000/1080).
		const scale = Math.max(1000 / 960, 1000 / 1080);
		expect(cropped.width).toBeCloseTo(960 * scale);
		expect(cropped.height).toBeCloseTo(1080 * scale);
	});

	test("transform scale, rotation and position compose with the crop", () => {
		const cropped = transform({
			crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
			scaleX: 0.5,
			scaleY: -0.5,
			rotate: 90,
			positionX: 40,
			positionY: -20,
		});
		// 500x500 kept, fit scale 2 -> 1000x1000, then scaled by 0.5.
		expect(cropped.width).toBeCloseTo(500);
		expect(cropped.height).toBeCloseTo(500);
		expect(cropped.rotationDegrees).toBe(90);
		expect(cropped.flipX).toBe(false);
		expect(cropped.flipY).toBe(true);
		expect(cropped.centerX).toBeCloseTo(540);
		expect(cropped.centerY).toBeCloseTo(480);
	});
});
