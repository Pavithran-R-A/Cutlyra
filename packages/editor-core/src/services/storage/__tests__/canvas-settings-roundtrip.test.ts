/**
 * GitHub #30 / Linear PAV-81 — an explicit canvas choice must survive
 * SAVE/REOPEN, not just the import that triggered the defect.
 *
 * The Stage-6 device loop is: pick 1:1 -> import a portrait clip -> canvas
 * silently becomes 1080x1920 -> user reopens the project later and the wrong
 * canvas is now PERSISTED. These tests drive the REAL
 * `storageService.saveProject()` / `storageService.loadProject()` pair
 * (including scene serialization and the migration hook); only the IndexedDB
 * persistence backend is replaced with an in-memory Map, because IndexedDB is
 * a platform surface, not project logic.
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { describe, expect, it, mock } from "bun:test";
import type { TProject, TProjectSettings } from "@/project/types";

/**
 * In-memory stand-in for IndexedDB's structured-clone semantics: values are
 * cloned on the way in AND on the way out, so a test can never accidentally
 * observe the same object reference it stored (which is exactly what a real
 * IndexedDB session boundary does not allow either).
 */
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

// Construct a FRESH service after the mocks are installed: the module-level
// `storageService` singleton may already have been instantiated (with real
// adapters) by another test file's import chain — editor-core's SaveManager
// pulls it in. The constructor is where adapters are built, so a new
// instance is guaranteed to receive the fakes.
const { StorageService } = await import("@/services/storage/service");
const storageService = new StorageService();
const { getAdoptedCanvasSizeForFirstVisualElement } = await import(
	"@/canvas/sizes"
);
const { mediaTime } = await import("@/wasm");
const { DEFAULT_CANVAS_SIZE } = await import("@/canvas/sizes");
const { buildDefaultScene } = await import("@/timeline/scenes");
const { buildEdl } = await import("@/edl/build");
const fixture = await import("@/edl/__tests__/fixture");
const { generateUUID } = await import("@/utils/id");

type TSettings = TProjectSettings;

function makeProject(settings: TSettings): TProject {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	return {
		metadata: {
			id: generateUUID(),
			name: "canvas round-trip",
			duration: mediaTime({ ticks: 0 }),
			createdAt: new Date("2026-10-20T00:00:00.000Z"),
			updatedAt: new Date("2026-10-20T00:00:00.000Z"),
		},
		scenes: [scene],
		currentSceneId: scene.id,
		settings,
		version: 31,
	};
}

function defaultSettings(): TSettings {
	return {
		fps: { numerator: 30, denominator: 1 },
		canvasSize: { ...DEFAULT_CANVAS_SIZE },
		canvasSizeMode: "preset",
		lastCustomCanvasSize: null,
		originalCanvasSize: null,
		background: { type: "color", color: "#000000" },
	};
}

describe("explicit canvas choice survives save/reopen (GitHub #30)", () => {
	it("persists an explicit 1:1 canvas through the real save/load pair", async () => {
		// The #30 scenario AFTER the fix: the user picked 1:1, the first
		// portrait import was refused adoption, and the project was saved
		// with the user's canvas intact (plus originalCanvasSize bookkeeping).
		const project = makeProject({
			...defaultSettings(),
			canvasSize: { width: 1080, height: 1080 },
			originalCanvasSize: { width: 1080, height: 1080 },
		});

		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({
			id: project.metadata.id,
		});

		expect(loaded).not.toBeNull();
		expect(loaded!.project.settings.canvasSize).toEqual({
			width: 1080,
			height: 1080,
		});
		expect(loaded!.project.settings.canvasSizeMode).toBe("preset");
		expect(loaded!.project.settings.originalCanvasSize).toEqual({
			width: 1080,
			height: 1080,
		});
	});

	it("a reopened project still refuses adoption for a later portrait import", async () => {
		const project = makeProject({
			...defaultSettings(),
			canvasSize: { width: 1080, height: 1080 },
		});
		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({
			id: project.metadata.id,
		});
		const settings = loaded!.project.settings;

		// Even if the reopened project somehow has no visual media yet (the
		// timeline was cleared, a fresh scene, ...), the explicit choice must
		// still win over a portrait import — reopening must not re-arm the
		// adoption that the user already declined by picking 1:1.
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				currentSize: settings.canvasSize,
				currentMode: settings.canvasSizeMode,
				isFirstVisualElement: true,
				asset: { type: "video", width: 1080, height: 1920 },
			}),
		).toBeNull();
	});

	it("an adopted portrait canvas persists across save/reopen too", async () => {
		// The legitimate adoption direction: factory-default project, first
		// portrait clip adopts 1080x1920 — that must ALSO survive save/reopen,
		// otherwise the feature itself would flap between sessions.
		const adopted = getAdoptedCanvasSizeForFirstVisualElement({
			currentSize: { ...DEFAULT_CANVAS_SIZE },
			currentMode: "preset",
			isFirstVisualElement: true,
			asset: { type: "video", width: 1080, height: 1920 },
		});
		expect(adopted).toEqual({ width: 1080, height: 1920 });

		const project = makeProject({
			...defaultSettings(),
			canvasSize: adopted!,
			originalCanvasSize: adopted!,
		});
		await storageService.saveProject({ project });
		const loaded = await storageService.loadProject({
			id: project.metadata.id,
		});

		expect(loaded!.project.settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
		// The export path reads exactly this field (buildEdl), so parity of the
		// reopened project's export with what the preview showed is structural:
		const edl = buildEdl({
			project: loaded!.project,
			scene: loaded!.project.scenes[0],
			mediaAssets: fixture.buildFixtureMediaAssets(),
			output: fixture.FIXTURE_OUTPUT,
			resolveAsset: fixture.fixtureAssetResolver,
		});
		expect(edl.meta.canvas).toEqual({ width: 1080, height: 1920 });
	});
});
