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
 * These tests drive the REAL `InsertElementCommand.execute()` — real
 * placement, real track bookkeeping — against a stubbed `EditorCore`, so the
 * regression is pinned at the seam that actually misbehaved rather than only
 * at the pure decision function.
 *
 * Save/reopen is covered in
 * `services/storage/__tests__/canvas-settings-roundtrip.test.ts` and
 * preview/export parity in `edl/__tests__/canvas-adoption-parity.test.ts`
 * (both read the single `project.settings.canvasSize` field this command
 * writes).
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { buildDefaultScene } from "@/timeline/scenes";
import type {
	AudioElement,
	AudioTrack,
	CreateVideoElement,
	SceneTracks,
} from "@/timeline";
import type { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

type Settings = {
	canvasSize: { width: number; height: number };
	canvasSizeMode: "preset" | "custom";
	originalCanvasSize: { width: number; height: number } | null;
};

type Harness = {
	settings: Settings;
	updates: Settings[];
	tracks: SceneTracks;
	assets: Array<{
		id: string;
		type: "video" | "image";
		width: number;
		height: number;
		sourceWidth?: number;
		sourceHeight?: number;
		fps?: number;
	}>;
};

/** Resolved once; the `@/core` module mock is re-pointed per harness. */
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

function buildHarness({
	canvasSize = { ...DEFAULT_CANVAS_SIZE },
	mode = "preset" as const,
	withAudioElement = false,
}: {
	canvasSize?: { width: number; height: number };
	mode?: "preset" | "custom";
	withAudioElement?: boolean;
}): Harness {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
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

	const h: Harness = {
		settings: {
			canvasSize,
			canvasSizeMode: mode,
			originalCanvasSize: null,
		},
		updates: [],
		tracks: scene.tracks,
		assets: [],
	};

	const editor = {
		scenes: { getActiveScene: () => ({ tracks: h.tracks }) },
		media: { getAssets: () => h.assets },
		project: {
			getActive: () => ({ settings: h.settings }),
			updateSettings: ({ settings }: { settings: Partial<Settings> }) => {
				h.settings = { ...h.settings, ...settings };
				h.updates.push(h.settings);
			},
		},
		timeline: {
			updateTracks: (tracks: SceneTracks) => {
				h.tracks = tracks;
			},
		},
	};

	mock.module("@/core", () => ({
		EditorCore: {
			getInstance: () => editor,
			reset: () => {},
		},
	}));

	return h;
}

/** Fresh harness per case; the module mock is re-pointed each time. */
function fresh({
	options = {},
	assets = [],
}: {
	options?: Parameters<typeof buildHarness>[0];
	assets?: Harness["assets"];
} = {}): Harness {
	const h = buildHarness(options);
	h.assets = assets;
	return h;
}

function runInsert({ mediaId }: { mediaId: string }): void {
	const command = new commandCtor({
		element: videoElement({ mediaId }),
		placement: { mode: "auto" },
	});
	command.execute();
}

function canvasWrites(h: Harness): string {
	return h.updates
		.map((u) => `${u.canvasSize.width}x${u.canvasSize.height}`)
		.join(",");
}

// The command module is only CONSTRUCTED inside tests, after every harness
// has re-pointed the `@/core` mock (Bun's mock.module patches live bindings).
describe("InsertElementCommand canvas adoption (GitHub #30)", () => {
	it("adopts a portrait canvas for the first clip in a factory-default project", () => {
		const h = fresh({ assets: [{ id: "a", type: "video", width: 1080, height: 1920 }] });
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
	});

	it("leaves a factory-default landscape canvas untouched for a landscape clip", () => {
		const h = fresh({ assets: [{ id: "a", type: "video", width: 1920, height: 1080 }] });
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1920, height: 1080 });
		expect(canvasWrites(h)).toBe(""); // no settings write at all
	});

	// --- the Stage-6 device failure, one case per offered aspect ratio ---
	it("preserves an explicit 1:1 choice (the exact device reproduction)", () => {
		const h = fresh({
			options: { canvasSize: { width: 1080, height: 1080 } },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit 9:16 choice", () => {
		const h = fresh({
			options: { canvasSize: { width: 1080, height: 1920 } },
			assets: [{ id: "a", type: "video", width: 720, height: 1280 }],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit 16:9 choice whose size differs from the default", () => {
		const h = fresh({
			options: { canvasSize: { width: 1280, height: 720 } },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1280, height: 720 });
		expect(canvasWrites(h)).toBe("");
	});

	it("preserves an explicit custom resolution", () => {
		const h = fresh({
			options: {
				canvasSize: { width: 1440, height: 1080 },
				mode: "custom",
			},
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1440, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("adopts once, then never again for later imports (multiple imports)", () => {
		const h = fresh({
			assets: [
				{ id: "a", type: "video", width: 1080, height: 1920 },
				{ id: "b", type: "video", width: 3000, height: 3000 },
			],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
		const writesAfterFirst = h.updates.length;

		runInsert({ mediaId: "b" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(h.updates.length).toBe(writesAfterFirst);
	});

	it("still adopts when an AUDIO clip was inserted first (visual-terms rule)", () => {
		const h = fresh({
			options: { withAudioElement: true },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		runInsert({ mediaId: "a" });
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
	});

	it("does not touch the canvas when the insert itself fails (failed import rollback)", () => {
		// An explicit placement at a track that does not exist aborts the
		// command before any settings write — the canvas must stay as the
		// user left it, exactly as a failed import leaves the project alone.
		const h = fresh({
			options: { canvasSize: { width: 1080, height: 1080 } },
			assets: [{ id: "a", type: "video", width: 1080, height: 1920 }],
		});
		const command = new commandCtor({
			element: videoElement({ mediaId: "a" }),
			placement: { mode: "explicit", trackId: "does-not-exist" },
		});
		command.execute();
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1080 });
		expect(canvasWrites(h)).toBe("");
	});

	it("sizes from SOURCE dims, not the mobile preview proxy's", () => {
		const h = fresh({
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
		expect(h.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
	});
});
