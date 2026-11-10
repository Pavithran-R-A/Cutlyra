/**
 * GitHub #50 — clip rotate/mirror must survive SAVE/REOPEN, not just the session
 * that set them, and the reopened project must still export the same transform.
 *
 * Drives the REAL `storageService.saveProject()` / `storageService.loadProject()`
 * pair (scene serialization + migration hook); only the IndexedDB backend is
 * replaced with an in-memory Map, because IndexedDB is a platform surface.
 *
 * Same harness as canvas-settings-roundtrip.test.ts: the wasm stub is preloaded
 * repo-wide via bunfig.toml.
 */

import { describe, expect, it, mock } from "bun:test";
import type { TProject } from "@/project/types";
import type { VideoElement } from "@/timeline/types";

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
const fixture = await import("@/edl/__tests__/fixture");
const { generateUUID } = await import("@/utils/id");

function transformClip(overrides: Record<string, number> = {}): VideoElement {
	return {
		id: "clip-rotated",
		type: "video",
		name: "rotated.mp4",
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
			...overrides,
		},
		animations: undefined,
	};
}

function makeProject(element: VideoElement): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	scene.tracks.main.elements = [element];
	return {
		metadata: {
			id: generateUUID(),
			name: "transform round-trip",
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

function exportTransform(project: TProject) {
	const edl = buildEdl({
		project,
		scene: project.scenes[0],
		mediaAssets: fixture.buildFixtureMediaAssets(),
		output: fixture.FIXTURE_OUTPUT,
		resolveAsset: fixture.fixtureAssetResolver,
	});
	const clip = edl.tracks[0].clips.find((c) => c.clipId === "clip-rotated");
	if (!clip) throw new Error("clip-rotated missing from EDL");
	return clip.transform;
}

describe("clip rotate/mirror survives save/reopen (#50)", () => {
	it("persists rotation and mirror params through the real save/load pair", async () => {
		const project = makeProject(
			transformClip({ "transform.rotate": -90, "transform.scaleX": -1.25, "transform.scaleY": 0.5 }),
		);
		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({ id: project.metadata.id });

		expect(loaded).not.toBeNull();
		const element = loaded!.project.scenes[0].tracks.main.elements[0];
		expect(element.params["transform.rotate"]).toBe(-90);
		// Mirror is a signed magnitude, not a boolean: it must not collapse to -1.
		expect(element.params["transform.scaleX"]).toBe(-1.25);
		expect(element.params["transform.scaleY"]).toBe(0.5);
		expect(element.params.framing).toBe("fit");
	});

	it("exports the same transform after reopening as before saving", async () => {
		const project = makeProject(transformClip({ "transform.rotate": 90, "transform.scaleY": -1 }));
		const beforeSave = exportTransform(project);

		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({ id: project.metadata.id });
		const afterReopen = exportTransform(loaded!.project);

		expect(afterReopen).toEqual(beforeSave);
		expect(afterReopen.rotateDegrees).toBe(90);
		expect(afterReopen.scaleY).toBe(-1);
		expect(afterReopen.scaleX).toBe(1);
	});

	it("keeps an untouched clip at identity after a round trip", async () => {
		const project = makeProject(transformClip());
		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({ id: project.metadata.id });

		expect(exportTransform(loaded!.project)).toEqual({
			positionX: 0,
			positionY: 0,
			scaleX: 1,
			scaleY: 1,
			rotateDegrees: 0,
		});
	});
});
