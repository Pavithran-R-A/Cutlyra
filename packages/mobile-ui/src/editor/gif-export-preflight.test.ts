/**
 * GIF export preflight.
 *
 * The export sheet calls `assertGifFramesExportable` before handing the EDL to
 * the native encoder, because the exporter feeds the asset's decoded per-frame
 * PNGs in directly: a missing or corrupt frame used to surface only as a
 * generic Media3 "asset loader error" after encoding had started. These tests
 * pin the three outcomes that matter: every frame decoded (pass), a native
 * refusal (typed error carrying the native message verbatim), and a platform
 * without the preflight (reported as skipped, never as success).
 */

import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@cutlyra/editor-core";
import {
	GifExportPreflightError,
	assertGifFramesExportable,
	type GifExportPreflightBridge,
} from "./actions";

const GIF_FRAMES = [
	{ relativePath: "gif/asset/frame-000.png", delayMs: 90 },
	{ relativePath: "gif/asset/frame-001.png", delayMs: 210 },
	{ relativePath: "gif/asset/frame-002.png", delayMs: 400 },
];

function editorWithGif({ frames = GIF_FRAMES }: { frames?: typeof GIF_FRAMES } = {}): EditorCore {
	return {
		media: {
			getAssets: () => [
				{
					id: "gif-asset",
					name: "loop.gif",
					type: "image",
					width: 320,
					height: 240,
					gif: {
						width: 320,
						height: 240,
						loopCount: 0,
						frameDelaysMs: frames.map((frame) => frame.delayMs),
						frames,
					},
				},
				// A plain still must never be sent to the GIF preflight.
				{ id: "still", name: "still.png", type: "image" },
			],
		},
	} as unknown as EditorCore;
}

describe("assertGifFramesExportable", () => {
	it("sends every decoded frame of every GIF asset to the native preflight", async () => {
		const calls: Array<{ assetId: string; frames: { relativePath: string; delayMs: number }[] }> =
			[];
		const bridge: GifExportPreflightBridge = {
			async prepareGifExport(params) {
				calls.push(params);
				return {
					assetId: params.assetId,
					ready: true,
					frameCount: params.frames.length,
					width: 320,
					height: 240,
					totalDurationMs: 700,
				};
			},
		};

		const summary = await assertGifFramesExportable({ editor: editorWithGif(), bridge });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.assetId).toBe("gif-asset");
		expect(calls[0]?.frames).toEqual(GIF_FRAMES);
		expect(summary).toEqual({ checkedAssets: 1, checkedFrames: 3, skipped: false });
	});

	it("raises a typed error that keeps the native refusal text verbatim", async () => {
		const bridge: GifExportPreflightBridge = {
			async prepareGifExport() {
				throw Object.assign(
					new Error("Decoded GIF frame is unreadable: gif/asset/frame-001.png"),
					{ code: "GIF_FRAME_UNREADABLE" },
				);
			},
		};

		const error = await assertGifFramesExportable({ editor: editorWithGif(), bridge }).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(GifExportPreflightError);
		expect((error as GifExportPreflightError).assetName).toBe("loop.gif");
		expect((error as Error).message).toBe(
			'GIF "loop.gif" can\'t be exported: Decoded GIF frame is unreadable: gif/asset/frame-001.png',
		);
	});

	it("reports a platform without the preflight as skipped, not as a pass", async () => {
		const summary = await assertGifFramesExportable({ editor: editorWithGif(), bridge: {} });
		expect(summary).toEqual({ checkedAssets: 0, checkedFrames: 0, skipped: true });
	});

	it("does not touch the bridge when the project has no GIF assets", async () => {
		let called = false;
		const bridge: GifExportPreflightBridge = {
			async prepareGifExport() {
				called = true;
				return null;
			},
		};
		const summary = await assertGifFramesExportable({
			editor: editorWithGif({ frames: [] }),
			bridge,
		});
		expect(summary).toEqual({ checkedAssets: 0, checkedFrames: 0, skipped: false });
		expect(called).toBe(false);
	});
});
