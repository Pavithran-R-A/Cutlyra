import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { storageService } from "@/services/storage/service";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { ReplaceClipMediaCommand } from "@/commands/timeline/element/replace-clip-media";
import type { MediaAsset } from "@/media/types";
import type { ElementRef } from "@/timeline";
import type { SerializedProject, MediaAssetData } from "@/services/storage/types";

// Reuse the in-memory persistence fakes from backup-service.test.ts by
// duplicating the minimal mock.module setup required for StorageService.
const projectStore = new Map<string, unknown>();
const mediaMetaStore = new Map<string, unknown>();
const mediaFileStore = new Map<string, File>();

class FakeIndexedDBAdapter {
	dbName: string;
	storeName: string;
	constructor(options: { dbName: string; storeName: string }) {
		this.dbName = options.dbName;
		this.storeName = options.storeName;
	}
	private scope(key: string): string {
		return `${this.dbName}::${key}`;
	}
	async set({ key, value }: { key: string; value: unknown }): Promise<void> {
		const cloned = structuredClone(value);
		if (this.storeName === "projects") projectStore.set(key, cloned);
		else mediaMetaStore.set(this.scope(key), cloned);
	}
	async get(key: string): Promise<unknown> {
		if (this.storeName === "projects") {
			const v = projectStore.get(key);
			return v === undefined ? null : structuredClone(v);
		}
		const v = mediaMetaStore.get(this.scope(key));
		return v === undefined ? null : structuredClone(v);
	}
	async getAll(): Promise<unknown[]> {
		const prefix = `${this.dbName}::`;
		const out: unknown[] = [];
		for (const [k, v] of mediaMetaStore) {
			if (k.startsWith(prefix)) out.push(structuredClone(v));
		}
		return out;
	}
	async list(): Promise<string[]> {
		if (this.storeName === "projects") return [...projectStore.keys()];
		const prefix = `${this.dbName}::`;
		return [...mediaMetaStore.keys()]
			.filter((k) => k.startsWith(prefix))
			.map((k) => k.slice(prefix.length));
	}
	async remove(key: string): Promise<void> {
		if (this.storeName === "projects") projectStore.delete(key);
		else mediaMetaStore.delete(this.scope(key));
	}
	async clear(): Promise<void> {
		if (this.storeName === "projects") projectStore.clear();
		else {
			const prefix = `${this.dbName}::`;
			for (const k of [...mediaMetaStore.keys()]) {
				if (k.startsWith(prefix)) mediaMetaStore.delete(k);
			}
		}
	}
}

class FakeOPFSAdapter {
	dirName: string;
	constructor(dirName: string) {
		this.dirName = dirName;
	}
	private scope(key: string): string {
		return `${this.dirName}::${key}`;
	}
	async set({ key, value }: { key: string; value: File }): Promise<void> {
		mediaFileStore.set(this.scope(key), value);
	}
	async get(key: string): Promise<File | null> {
		return mediaFileStore.get(this.scope(key)) ?? null;
	}
	async remove(key: string): Promise<void> {
		mediaFileStore.delete(this.scope(key));
	}
	async list(): Promise<string[]> {
		const prefix = `${this.dirName}::`;
		return [...mediaFileStore.keys()]
			.filter((k) => k.startsWith(prefix))
			.map((k) => k.slice(prefix.length));
	}
	async clear(): Promise<void> {
		const prefix = `${this.dirName}::`;
		for (const k of [...mediaFileStore.keys()]) {
			if (k.startsWith(prefix)) mediaFileStore.delete(k);
		}
	}
}

mock.module("@/services/storage/indexeddb-adapter", () => ({
	IndexedDBAdapter: FakeIndexedDBAdapter,
	deleteDatabase: async () => {},
}));
mock.module("@/services/storage/opfs-adapter", () => ({ OPFSAdapter: FakeOPFSAdapter }));
mock.module("@/services/storage/migrations", () => ({
	migrations: [],
	runStorageMigrations: async () => {},
	CURRENT_PROJECT_VERSION: 31,
}));
mock.module("@/services/storage/quota", () => ({
	readStorageQuotaStatus: async () => ({
		quotaBytes: 10 * 1024 * 1024 * 1024,
		usageBytes: 0,
		headroomBytes: 10 * 1024 * 1024 * 1024,
		availableBytes: 10 * 1024 * 1024 * 1024,
	}),
	evaluateStorageCapacity: ({ requiredBytes }: { requiredBytes: number }) => ({
		canStore: requiredBytes <= 10 * 1024 * 1024 * 1024,
		reason: requiredBytes > 10 * 1024 * 1024 * 1024 ? "insufficient-space" : "enough-space",
		availableBytes: 10 * 1024 * 1024 * 1024,
	}),
	isStorageQuotaExceededError: () => false,
	StorageQuotaExceededError: class extends Error {},
	formatStorageBytes: ({ bytes }: { bytes: number }) => `${bytes} B`,
}));

const { StorageService } = await import("@/services/storage/service");
const backup = await import("@/services/backup/backup-service");
const { mediaTime } = await import("@/wasm");

const TPS = TICKS_PER_SECOND;
function t(seconds: number) {
	return mediaTime({ ticks: Math.round(seconds * TPS) });
}

function assetData(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`),
		duration: 10,
		width: 1080,
		height: 1920,
		hasAudio: true,
	} as MediaAsset;
}

const SCENE_ID = "scene-backup-durability";

function bootstrapEditor() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = { ...buildDefaultScene({ name: "Main scene", isMain: true }), id: SCENE_ID };
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: SCENE_ID });
	const original = assetData("asset-original");
	const replacement = assetData("asset-replacement");
	editor.media.setAssets({ assets: [original, replacement] });
	return { editor, projectId: editor.project.getActive().metadata.id, mainTrackId: scene.tracks.main.id };
}

function insertVideo({
	editor,
	trackId,
	mediaId,
}: {
	editor: EditorCore;
	trackId: string;
	mediaId: string;
}): ElementRef {
	const command = new InsertElementCommand({
		element: buildElementFromMedia({
			mediaId,
			mediaType: "video",
			name: `${mediaId}.mp4`,
			duration: t(4),
			startTime: ZERO_MEDIA_TIME,
		}),
		placement: { mode: "explicit", trackId },
	});
	editor.command.execute({ command });
	return { trackId, elementId: command.getElementId() };
}

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSerializedProject(id: string): SerializedProject {
	return {
		metadata: {
			id,
			name: "Test project",
			thumbnail: undefined,
			duration: mediaTime({ ticks: 0 }),
			createdAt: "2026-10-20T00:00:00.000Z",
			updatedAt: "2026-10-21T00:00:00.000Z",
		},
		scenes: [
			{
				id: "scene-1",
				name: "Main scene",
				isMain: true,
				tracks: {			main: {
												id: "main",
												name: "Main",
												type: "video",
												muted: false,
												hidden: false,
												elements: [
													{
														id: "el-1",
														name: "clip",
														type: "video",
														mediaId: "asset-replacement",
														duration: mediaTime({ ticks: 0 }),
														startTime: mediaTime({ ticks: 0 }),
														trimStart: mediaTime({ ticks: 0 }),
														trimEnd: mediaTime({ ticks: 0 }),
														params: {},
													},
												],
											},
					overlay: [],				audio: [],
			},
			bookmarks: [],
			createdAt: "2026-10-20T00:00:00.000Z",
			updatedAt: "2026-10-21T00:00:00.000Z",
		},
		],
		currentSceneId: "scene-1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

describe("backup durability boundaries", () => {
	let saveMediaSpy: ReturnType<typeof spyOn<typeof storageService, "saveMediaAsset">>;

	beforeEach(() => {
		projectStore.clear();
		mediaMetaStore.clear();
		mediaFileStore.clear();
		saveMediaSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(async () => undefined);
		ReplaceClipMediaCommand.resetPendingOperations();
	});

	afterEach(async () => {
		await ReplaceClipMediaCommand.flushPendingOperations();
		saveMediaSpy.mockRestore();
		EditorCore.reset();
	});

	it("backup waits for a pending replacement media write before exporting", async () => {
		const { editor, projectId } = bootstrapEditor();
		const ref = insertVideo({ editor, trackId: editor.scenes.getActiveScene().tracks.main.id, mediaId: "asset-original" });
		void ref;
		// Use a fresh asset to force a pending save.
		const mainTrackId = editor.scenes.getActiveScene().tracks.main.id;
		const r = insertVideo({ editor, trackId: mainTrackId, mediaId: "asset-original" });
		const d = deferred();
		saveMediaSpy.mockImplementation(() => d.promise);
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId,
				ref: r,
				asset: assetData("asset-fresh"),
			}),
		});

		const storage = new StorageService();
		const serialized = makeSerializedProject(projectId);
		serialized.scenes = [
			{
				id: "scene-1",
				name: "Main scene",
				isMain: true,
				tracks: {main: {
												id: "main",
												name: "Main",
												type: "video",
												muted: false,
												hidden: false,
												elements: [
													{
														id: "el-fresh",
								name: "clip",
								type: "video",
								mediaId: "asset-fresh",
								duration: mediaTime({ ticks: 0 }),
								startTime: mediaTime({ ticks: 0 }),
								trimStart: mediaTime({ ticks: 0 }),
								trimEnd: mediaTime({ ticks: 0 }),
								params: {},
							},
						],
					},
					overlay: [],
					audio: [],
				},
				bookmarks: [],
				createdAt: "2026-10-20T00:00:00.000Z",
				updatedAt: "2026-10-21T00:00:00.000Z",
			},
		];
		await storage.putSerializedProject({ project: serialized });
		await storage.putMediaAssetData({ projectId, data: { id: "asset-fresh", name: "clip.mp4", type: "video", size: 5, lastModified: 1, width: 1, height: 1, duration: 1, fps: 30, hasAudio: true } as MediaAssetData });
		await storage.putMediaAssetFile({ projectId, assetId: "asset-fresh", file: new File([new Uint8Array([1, 2, 3, 4, 5])], "clip.mp4") });

		const io = {
			async readMediaBytes({ assetId, role }: { assetId: string; role: string }) {
				if (role !== "proxy") return null;
				const file = await storage.loadMediaAsset({ projectId, id: assetId });
				if (!file?.file) return null;
				return new Uint8Array(await file.file.arrayBuffer());
			},
		};
		const exportPromise = backup.exportProjectArchive({ projectId, ctx: { storage, io, appVersion: "test" } });

		// Resolve the pending media write; export should then succeed.
		d.resolve();
		await d.promise.catch(() => undefined);
		const result = await exportPromise;
		expect(result.manifest.projects).toHaveLength(1);
	});

	it("backup fails closed when a pending replacement media write fails", async () => {
		const { editor, projectId } = bootstrapEditor();
		const mainTrackId = editor.scenes.getActiveScene().tracks.main.id;
		const r = insertVideo({ editor, trackId: mainTrackId, mediaId: "asset-original" });
		const d = deferred();
		saveMediaSpy.mockImplementation(() => d.promise);
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId,
				ref: r,
				asset: assetData("asset-fresh"),
			}),
		});

		const storage = new StorageService();
		await storage.putSerializedProject({ project: makeSerializedProject(projectId) });

		const io = { async readMediaBytes() { return new Uint8Array([1, 2, 3]); } };
		const exportPromise = backup.exportProjectArchive({ projectId, ctx: { storage, io, appVersion: "test" } });

		d.reject(new Error("media write failed"));
		await d.promise.catch(() => undefined);
		await expect(exportPromise).rejects.toMatchObject({ code: "IO_ERROR" });
	});

	it("web archive includes all required replacement media", async () => {
		const storage = new StorageService();
		const projectId = "proj-media";
		await storage.putSerializedProject({ project: makeSerializedProject(projectId) });
		await storage.putMediaAssetData({ projectId, data: { id: "asset-replacement", name: "clip.mp4", type: "video", size: 5, lastModified: 1, width: 1, height: 1, duration: 1, fps: 30, hasAudio: true } as MediaAssetData });
		await storage.putMediaAssetFile({ projectId, assetId: "asset-replacement", file: new File([new Uint8Array([1, 2, 3, 4, 5])], "clip.mp4") });

		const io = {
			async readMediaBytes({ assetId, role }: { assetId: string; role: string }) {
				if (role !== "proxy") return null;
				const file = await storage.loadMediaAsset({ projectId, id: assetId });
				if (!file?.file) return null;
				return new Uint8Array(await file.file.arrayBuffer());
			},
		};
		const result = await backup.exportProjectArchive({ projectId, ctx: { storage, io, appVersion: "test" } });
		expect(result.manifest.projects[0].assets.map((a) => a.id)).toContain("asset-replacement");
	});

	it("buildExportRecipe uses the correct media identity", async () => {
		const storage = new StorageService();
		const projectId = "proj-recipe";
		await storage.putSerializedProject({ project: makeSerializedProject(projectId) });
		await storage.putMediaAssetData({ projectId, data: { id: "asset-replacement", name: "clip.mp4", type: "video", size: 5, lastModified: 1, width: 1, height: 1, duration: 1, fps: 30, hasAudio: true } as MediaAssetData });

		const recipe = await backup.buildExportRecipe({ projectId, storage });
		expect(recipe.media.map((m) => m.assetId)).toContain("asset-replacement");
	});

	it("throws when referenced media metadata is missing", async () => {
		const storage = new StorageService();
		const projectId = "proj-missing";
		await storage.putSerializedProject({ project: makeSerializedProject(projectId) });
		// No media data seeded.
		const io = { async readMediaBytes() { return null; } };
		await expect(
			backup.exportProjectArchive({ projectId, ctx: { storage, io, appVersion: "test" } }),
		).rejects.toMatchObject({ code: "IO_ERROR" });
	});
});
