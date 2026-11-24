/**
 * Save/reopen for animated GIF assets.
 *
 * A native-custody GIF stores its decoded frames as PNGs in media custody and
 * its timing in `MediaAssetData.gif`. The persisted metadata row is an
 * explicit field-by-field object, so a field it forgets is silently lost on
 * reopen — the asset would come back as a still. These tests drive the REAL
 * `StorageService.saveMediaAsset`/`loadMediaAsset` with the two platform
 * adapters (IndexedDB metadata, OPFS files) replaced by in-memory Maps, which
 * is exactly what the backup suite does for the same reason.
 */

import { describe, expect, mock, test } from "bun:test";

const metadataStore = new Map<string, unknown>();
const fileStore = new Map<string, File>();

class FakeIndexedDBAdapter {
	dbName: string;
	storeName: string;
	constructor(options: { dbName: string; storeName: string }) {
		this.dbName = options.dbName;
		this.storeName = options.storeName;
	}
	private scope(key: string): string {
		return `${this.dbName}::${this.storeName}::${key}`;
	}
	async set({ key, value }: { key: string; value: unknown }): Promise<void> {
		metadataStore.set(this.scope(key), structuredClone(value));
	}
	async get(key: string): Promise<unknown> {
		return metadataStore.get(this.scope(key)) ?? null;
	}
	async remove(key: string): Promise<void> {
		metadataStore.delete(this.scope(key));
	}
	async list(): Promise<string[]> {
		return [];
	}
	async clear(): Promise<void> {
		metadataStore.clear();
	}
}

class FakeOPFSAdapter {
	directoryName: string;
	constructor(directoryName = "media") {
		this.directoryName = directoryName;
	}
	private scope(key: string): string {
		return `${this.directoryName}::${key}`;
	}
	async set({ key, value }: { key: string; value: File }): Promise<void> {
		fileStore.set(this.scope(key), value);
	}
	async get(key: string): Promise<File | null> {
		return fileStore.get(this.scope(key)) ?? null;
	}
	async remove(key: string): Promise<void> {
		fileStore.delete(this.scope(key));
	}
	async list(): Promise<string[]> {
		return [];
	}
	async clear(): Promise<void> {
		fileStore.clear();
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

const { StorageService } = await import("@/services/storage/service");
const { selectGifFrameIndex } = await import("@/media/gif-asset");
type StorageServiceType = InstanceType<typeof StorageService>;
type MediaAsset = Parameters<StorageServiceType["saveMediaAsset"]>[0]["mediaAsset"];

const GIF = {
	width: 320,
	height: 240,
	loopCount: 0,
	frameDelaysMs: [200, 300, 500],
	frames: [
		{ relativePath: "gif/gif-asset/frame-000.png", delayMs: 200 },
		{ relativePath: "gif/gif-asset/frame-001.png", delayMs: 300 },
		{ relativePath: "gif/gif-asset/frame-002.png", delayMs: 500 },
	],
};

function makeGifAsset(): MediaAsset {
	return {
		id: "gif-asset",
		name: "loop.gif",
		type: "image",
		// Native-custody stub: the bytes live on the device filesystem.
		file: new File([], "loop.gif", { type: "image/gif" }),
		url: "webview:///sandbox/Media/loop.gif",
		width: GIF.width,
		height: GIF.height,
		duration: 1,
		hasAudio: false,
		nativeRelativePath: "Media/loop.gif",
		gif: GIF,
	};
}

describe("GIF media metadata survives save/reopen", () => {
	test("loadMediaAsset returns the persisted gif timing and frame paths", async () => {
		const storage = new StorageService();
		await storage.saveMediaAsset({ projectId: "p1", mediaAsset: makeGifAsset() });

		const reopened = await storage.loadMediaAsset({ projectId: "p1", id: "gif-asset" });

		expect(reopened?.gif).toEqual(GIF);
	});

	test("the reopened asset still resolves the same animated frame", async () => {
		const storage = new StorageService();
		await storage.saveMediaAsset({ projectId: "p1", mediaAsset: makeGifAsset() });
		const reopened = await storage.loadMediaAsset({ projectId: "p1", id: "gif-asset" });
		const gif = reopened?.gif;
		if (!gif) throw new Error("gif metadata was lost on reopen");

		expect(gif.loopCount).toBe(0);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0 })).toBe(0);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.25 })).toBe(1);
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 0.75 })).toBe(2);
		// Endless GIF -> wraps instead of freezing on the last frame.
		expect(selectGifFrameIndex({ metadata: gif, localTimeSec: 1.1 })).toBe(0);
		// Trimming 0.25 s in starts the clip on the green frame.
		expect(
			selectGifFrameIndex({ metadata: gif, localTimeSec: 0, trimStartSec: 0.25 }),
		).toBe(1);
	});

	test("an asset without gif metadata reopens without a fabricated gif", async () => {
		const storage = new StorageService();
		const plain: MediaAsset = { ...makeGifAsset(), id: "still", gif: undefined };
		await storage.saveMediaAsset({ projectId: "p1", mediaAsset: plain });

		const reopened = await storage.loadMediaAsset({ projectId: "p1", id: "still" });

		expect(reopened?.gif).toBeUndefined();
	});
});
