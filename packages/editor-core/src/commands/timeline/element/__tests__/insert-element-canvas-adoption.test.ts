/**
 * GitHub #30 / Linear PAV-81 — an explicit canvas choice must survive the
 * first imported clip.
 *
 * The device reproduction (Stage 6, POCO M4 Pro 5G, build b1cd6a2): new
 * project -> Aspect ratio -> 1:1 -> canvas 1080x1080 -> import a 1080x1920
 * clip -> canvas silently became 1080x1920. The import seam asked
 * `getAdoptedCanvasSizeForImportedMedia` (guarded); the TIMELINE INSERT
 * command called `normalizeAdoptedCanvasSize` directly and overwrote it.
 *
 * These tests drive the REAL `InsertElementCommand.execute()` against the REAL
 * `EditorCore` — real placement, real track bookkeeping, real project settings
 * command — so the regression is pinned at the seam that actually misbehaved.
 *
 * This file used to install `mock.module("@/core", …)`. Bun module mocks are
 * PROCESS-wide and `mock.restore()` does not undo them, so every test file that
 * ran afterwards received the stub and any suite using a real `EditorCore`
 * failed depending on discovery order. Driving the real engine removes both the
 * leak and the stub's drift from real project-manager behaviour; the "no canvas
 * write" assertions are kept by spying on `project.updateSettings` and still
 * calling through to the real implementation.
 *
 * Save/reopen is covered in
 * `services/storage/__tests__/canvas-settings-roundtrip.test.ts` and
 * preview/export parity in `edl/__tests__/canvas-adoption-parity.test.ts`
 * (both read the single `project.settings.canvasSize` field this command
 * writes).
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { AudioElement, AudioTrack, CreateVideoElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import type { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

type AssetSpec = {
	id: string;
	type: "video" | "image";
	width: number;
	height: number;
	sourceWidth?: number;
	sourceHeight?: number;
	fps?: number;
};

type Harness = {
	editor: EditorCore;
	/** Canvas sizes the command asked the project manager to adopt, in order. */
	canvasWrites: Array<{ width: number; height: number }>;
};

const commandCtor: typeof InsertElementCommand = (
	await import("@/commands/timeline/element/insert-element")
).InsertElementCommand;

/** A video element that `InsertElementCommand` will accept on the main track. */
function videoElement({ mediaId }: { mediaId: string }): CreateVideoElement {
	return {
		type: "video",
		mediaId,
		name: "clip.mp4",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function toMediaAsset(spec: AssetSpec): MediaAsset {
	return {
		id: spec.id,
		name: `${spec.id}.${spec.type === "image" ? "png" : "mp4"}`,
		type: spec.type,
		width: spec.width,
		height: spec.height,
		...(spec.sourceWidth !== undefined ? { sourceWidth: spec.sourceWidth } : {}),
		...(spec.sourceHeight !== undefined ? { sourceHeight: spec.sourceHeight } : {}),
		...(spec.fps !== undefined ? { fps: spec.fps } : {}),
		file: new File([], `${spec.id}.mp4`),
	};
}

function buildHarness({
	canvasSize = { ...DEFAULT_CANVAS_SIZE },
	mode = "preset",
	withAudioElement = false,
	assets = [],
}: {
	canvasSize?: { width: number; height: number };
	mode?: "preset" | "custom";
	withAudioElement?: boolean;
	assets?: AssetSpec[];
} = {}): Harness {
	EditorCore.reset();
	const editor = EditorCore.getInstance();

	const project = buildFixtureProject();
	project.settings.canvasSize = { ...canvasSize };
	project.settings.canvasSizeMode = mode;
	project.settings.originalCanvasSize = null;
	editor.project.setActiveProject({ project });

	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: "scene-canvas-adoption",
	};
	if (withAudioElement) {
		const audioElement: AudioElement = {
			id: "audio-1",
			name: "sound.mp3",
			type: "audio",
			sourceType: "library",
			sourceUrl: "https://example.test/sound.mp3",
			startTime: ZERO_MEDIA_TIME,
			duration: mediaTime({ ticks: 120_000 }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: {},
		};
		const audioTrack: AudioTrack = {
			id: "audio-track-1",
			name: "Audio 1",
			type: "audio",
			elements: [audioElement],
			muted: false,
		};
		scene.tracks.audio = [audioTrack];
	}
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	editor.media.setAssets({ assets: assets.map(toMediaAsset) });

	// Record adoption requests while still letting the real project manager
	// apply them (a spy that swallowed the call would make every assertion below
	// vacuous).
	const harness: Harness = { editor, canvasWrites: [] };
	const realUpdateSettings = editor.project.updateSettings.bind(editor.project);
	spyOn(editor.project, "updateSettings").mockImplementation(
		async (args: Parameters<typeof realUpdateSettings>[0]) => {
			const canvas = args?.settings?.canvasSize;
			if (canvas) harness.canvasWrites.push({ ...canvas });
			await realUpdateSettings(args);
		},
	);

	return harness;
}

afterEach(() => {
	EditorCore.reset();
});

function runInsert({ mediaId }: { mediaId: string }): void {
	const command = new commandCtor({
		element: videoElement({ mediaId }),
		placement: { mode: "auto" },
	});
	command.execute();
}

function canvasOf(h: Harness): { width: number; height: number } {
	return h.editor.project.getActive().settings.canvasSize;
}

function canvasWrites(h: Harness): string {
	return h.canvasWrites.map((write) => `${write.width}x${write.height}`).join(",");
}

describe("InsertElementCommand canvas adoption (GitHub #30)", () => {
	it("adopts a portrait canvas for the first clip in a factory-default project", () => {
		const h = buildHarness({ assets: [{ id: "a", type: "video", width: 1080, height: 1920 }] });
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
	});

	it("leaves a factory-default landscape canvas untouched for a landscape clip", () => {
		const h = buildHarness({ assets: [{ id: "a", type: "video", width: 1920, height: 1080 }] });
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1920, height: 1080 });
		expect(canvasWrites(h)).toBe(""); // no settings write at all
	});

	// --- the Stage-6 device failure, one case per offered aspect ratio ---
	it("preserves an explicit 1:1 choice (the exact device reproduction)", () => {
		const h = buildHarness({
			canvasSize: { width: 1080, height: 1080 },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit 9:16 choice", () => {
		const h = buildHarness({
			canvasSize: { width: 1080, height: 1920 },
			assets: [{ id: "a", type: "video", width: 720, height: 1280 }],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit 16:9 choice whose size differs from the default", () => {
		const h = buildHarness({
			canvasSize: { width: 1280, height: 720 },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1280, height: 720 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit custom resolution", () => {
		const h = buildHarness({
			canvasSize: { width: 1440, height: 1080 },
			mode: "custom",
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1440, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("adopts once, then never again for later imports (multiple imports)", () => {
		const h = buildHarness({
			assets: [
				{ id: "a", type: "video", width: 1080, height: 1920 },
				{ id: "b", type: "video", width: 3000, height: 3000 },
			],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
		const writesAfterFirst = h.canvasWrites.length;
		expect(writesAfterFirst).toBeGreaterThan(0);

		runInsert({ mediaId: "b" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
		expect(h.canvasWrites.length).toBe(writesAfterFirst);
	});

	it("still adopts when an AUDIO clip was inserted first (visual-terms rule)", () => {
		const h = buildHarness({
			withAudioElement: true,
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
	});

	it("does not touch the canvas when the insert itself fails (failed import rollback)", () => {
		// An explicit placement at a track that does not exist aborts the
		// command before any settings write — the canvas must stay as the
		// user left it, exactly as a failed import leaves the project alone.
		const h = buildHarness({
			canvasSize: { width: 1080, height: 1080 },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		const command = new commandCtor({
			element: videoElement({ mediaId: "a" }),
			placement: { mode: "explicit", trackId: "does-not-exist" },
		});
		command.execute();
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("sizes from SOURCE dims, not the mobile preview proxy's", () => {
		const h = buildHarness({
			assets: [
				{
					id: "a",
					type: "video",
					width: 540,
					height: 960,
					sourceWidth: 1080,
					sourceHeight: 1920,
				},
			],
		});
		runInsert({ mediaId: "a" });
		expect(canvasOf(h)).toEqual({ width: 1080, height: 1920 });
	});
});
