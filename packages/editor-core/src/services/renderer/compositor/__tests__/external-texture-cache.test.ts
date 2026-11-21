import { describe, expect, test } from "bun:test";
import {
	canvasDouble,
	offscreenCanvasDouble,
} from "@/test-support/canvas-double";
import { isExternalTextureCacheHit } from "../wasm-compositor";
import type { ExternalTextureDescriptor } from "../types";

/**
 * Video frames arrive in pooled canvases: mediabunny's `CanvasSink` may hand a
 * later frame back in the SAME canvas object an earlier one used. Treating
 * object identity as "same pixels" then keeps the previous frame on screen, so
 * the cache has to compare the descriptor's content revision as well.
 */
function external({
	source,
	contentHash,
}: {
	source: CanvasImageSource;
	contentHash?: string;
}): ExternalTextureDescriptor {
	return { kind: "external", id: "layer:source", source, width: 320, height: 240, contentHash };
}

const canvas = canvasDouble();
const otherCanvas = canvasDouble();

function previousEntry(texture: ExternalTextureDescriptor) {
	return {
		kind: "external" as const,
		source: texture.source,
		width: texture.width,
		height: texture.height,
		contentHash: texture.contentHash,
	};
}

describe("external texture cache", () => {
	test("an immutable source with no revision still hits by identity", () => {
		const texture = external({ source: canvas });
		expect(
			isExternalTextureCacheHit({ previous: previousEntry(texture), texture }),
		).toBe(true);
	});

	test("a new revision in the same canvas is a miss", () => {
		const first = external({ source: canvas, contentHash: "video:0" });
		const second = external({ source: canvas, contentHash: "video:1" });
		expect(
			isExternalTextureCacheHit({ previous: previousEntry(first), texture: second }),
		).toBe(false);
	});

	test("the same revision on the same canvas stays a hit", () => {
		const texture = external({ source: canvas, contentHash: "video:1" });
		expect(
			isExternalTextureCacheHit({ previous: previousEntry(texture), texture }),
		).toBe(true);
	});

	test("a different source object is always a miss", () => {
		const texture = external({ source: otherCanvas, contentHash: "video:1" });
		const previous = previousEntry(external({ source: canvas, contentHash: "video:1" }));
		expect(isExternalTextureCacheHit({ previous, texture })).toBe(false);
	});

	test("a size change is always a miss", () => {
		const texture = { ...external({ source: canvas }), width: 640 };
		expect(
			isExternalTextureCacheHit({ previous: previousEntry(external({ source: canvas })), texture }),
		).toBe(false);
	});

	test("no previous entry, or a rendered one, is a miss", () => {
		const texture = external({ source: canvas });
		expect(isExternalTextureCacheHit({ previous: undefined, texture })).toBe(false);
		expect(
			isExternalTextureCacheHit({
				previous: {
					kind: "rendered",
					canvas: offscreenCanvasDouble(),
					contentHash: "x",
					width: 320,
					height: 240,
				},
				texture,
			}),
		).toBe(false);
	});
});
