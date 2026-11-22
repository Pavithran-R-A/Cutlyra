/* eslint-disable @typescript-eslint/no-unsafe-type-assertion --
   The resolve context is a CanvasRenderer, which owns a GPU canvas; bun has
   no OffscreenCanvas, so these tests pass only the `width`/`height` the
   resolver reads. The assertions are the narrowest way to stand in for it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StickerNode } from "../nodes/sticker-node";
import { resolveRenderTree } from "../resolve";
import type { CanvasRenderer } from "../canvas-renderer";

/**
 * Regression: a sticker whose asset is missing (empty/renamed bundle, stale
 * `stickerId` from an old project, offline first paint) used to reject inside
 * `resolveStickerNode`, which rejected `resolveRenderTree` — i.e. one bad
 * sticker took down the whole preview frame and the export. It must instead
 * resolve to "not visible" so the rest of the scene keeps rendering and the
 * export completes without that sticker.
 */

const originalImage = globalThis.Image;

class FailingImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	set src(_value: string) {
		queueMicrotask(() => this.onerror?.());
	}
}

beforeAll(() => {
	// `loadStickerSource` constructs browser Images; bun has none.
	(globalThis as { Image: unknown }).Image = FailingImage;
});

afterAll(() => {
	(globalThis as { Image: unknown }).Image = originalImage;
});

function stickerNode({ stickerId }: { stickerId: string }): StickerNode {
	return new StickerNode({
		stickerId,
		duration: 120_000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 120_000,
		transform: {
			scaleX: 1,
			scaleY: 1,
			position: { x: 0, y: 0 },
			rotate: 0,
		},
		opacity: 1,
	});
}

describe("missing sticker assets", () => {
	test("a sticker that cannot load resolves as invisible instead of throwing", async () => {
		const node = stickerNode({ stickerId: "flags:zz" });
		const renderer = { width: 1080, height: 1920 } as CanvasRenderer;

		await expect(
			resolveRenderTree({ node, renderer, time: 0 }),
		).resolves.toBeUndefined();
		expect(node.resolved).toBeNull();
	});

	test("the failed load is not cached, so a later render can retry", async () => {
		const node = stickerNode({ stickerId: "flags:zz" });
		const renderer = { width: 1080, height: 1920 } as CanvasRenderer;

		await resolveRenderTree({ node, renderer, time: 0 });
		expect(node.resolved).toBeNull();

		// A repaired bundle: the same id must get a fresh load attempt rather
		// than replaying the cached rejection for the rest of the session.
		let attempts = 0;
		class CountingImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			naturalWidth = 200;
			naturalHeight = 200;
			set src(_value: string) {
				attempts += 1;
				queueMicrotask(() => this.onload?.());
			}
		}
		(globalThis as { Image: unknown }).Image = CountingImage;

		await resolveRenderTree({ node, renderer, time: 0 });
		expect(attempts).toBe(1);
		expect(node.resolved).not.toBeNull();
	});
});
