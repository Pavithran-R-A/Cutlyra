/**
 * Masks must survive SAVE/REOPEN, and the reopened project must still produce
 * the same EDL mask (and pass `validateEdl`). Drives the real
 * `storageService.saveProject()` / `loadProject()` pair; only the IndexedDB
 * backend is replaced with an in-memory Map.
 */

import { describe, expect, it, mock } from "bun:test";
import type { TProject } from "@/project/types";
import type { VideoElement } from "@/timeline/types";
import type { Mask } from "@/masks/types";

const backingStore = new Map<string, unknown>();

class FakeIndexedDBAdapter {
	constructor(_options: unknown) {}

	async set({ key, value }: { key: string; value: unknown }): Promise<void> {
		backingStore.set(key, structuredClone(value));
	}

	async get(key: string): Promise<unknown> {
		const stored = backingStore.get(key);
		return stored === undefined ? undefined : structuredClone(stored);
	}

	async list(): Promise<string[]> {
		return [...backingStore.keys()];
	}
}

mock.module("../indexeddb-adapter", () => ({
	IndexedDBAdapter: FakeIndexedDBAdapter,
}));
mock.module("@/services/storage/migrations", () => ({
	migrations: [],
	runStorageMigrations: async () => {},
}));

const { StorageService } = await import("@/services/storage/service");
const storageService = new StorageService();
const { mediaTime, ZERO_MEDIA_TIME } = await import("@/wasm");
const { DEFAULT_CANVAS_SIZE } = await import("@/canvas/sizes");
const { buildDefaultScene } = await import("@/timeline/scenes");
const { buildEdl } = await import("@/edl/build");
const { validateEdl } = await import("@/edl/validate");
const fixture = await import("@/edl/__tests__/fixture");
const { generateUUID } = await import("@/utils/id");

const baseParams = {
	feather: 18,
	inverted: true,
	strokeColor: "#ffffff",
	strokeWidth: 0,
	strokeAlign: "center" as const,
};

const masks: Mask[] = [
	{
		id: "mask-rect",
		type: "rectangle",
		params: {
			...baseParams,
			centerX: 0.1,
			centerY: -0.05,
			width: 0.6,
			height: 0.4,
			rotation: 32,
			scale: 1,
		},
	},
	{
		id: "mask-ellipse",
		type: "ellipse",
		params: {
			...baseParams,
			centerX: 0,
			centerY: 0,
			width: 0.5,
			height: 0.5,
			rotation: 0,
			scale: 1,
		},
	},
	{
		id: "mask-linear",
		type: "split",
		params: { ...baseParams, centerX: 0, centerY: 0.2, rotation: 45 },
	},
];

function maskClip(mask: Mask): VideoElement {
	return {
		id: `clip-${mask.id}`,
		type: "video",
		name: "masked.mp4",
		mediaId: "asset-video-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 2 * 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
			volume: 0,
			muted: false,
			framing: "fit",
		},
		masks: [mask],
		animations: undefined,
	};
}

function makeProject(element: VideoElement): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	scene.tracks.main.elements = [element];
	return {
		metadata: {
			id: generateUUID(),
			name: "mask round-trip",
			duration: mediaTime({ ticks: 2 * 120_000 }),
			createdAt: new Date("2026-11-10T00:00:00.000Z"),
			updatedAt: new Date("2026-11-10T00:00:00.000Z"),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { ...DEFAULT_CANVAS_SIZE },
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

function exportMask(project: TProject) {
	const edl = buildEdl({
		project,
		scene: project.scenes[0],
		mediaAssets: fixture.buildFixtureMediaAssets(),
		output: fixture.FIXTURE_OUTPUT,
		resolveAsset: fixture.fixtureAssetResolver,
	});
	return { edl, clip: edl.tracks[0].clips[0] };
}

describe("masks survive save/reopen and reach the EDL intact", () => {
	for (const mask of masks) {
		it(`${mask.type}: persists, exports and validates`, async () => {
			const project = makeProject(maskClip(mask));
			await storageService.saveProject({ project });
			const loaded = await storageService.loadProject({ id: project.metadata.id });
			expect(loaded).not.toBeNull();

			const loadedMask = loaded!.project.scenes[0].tracks.main.elements[0].masks?.[0];
			expect(loadedMask).toEqual(mask);

			const { edl, clip } = exportMask(loaded!.project);
			expect(clip.masks).toHaveLength(1);
			expect(clip.masks[0]).toEqual({
				maskId: mask.id,
				type: mask.type,
				params: mask.params as unknown as Record<string, unknown>,
			});
			const validation = validateEdl({ edl });
			expect(validation.errors).toEqual([]);
		});
	}
});
