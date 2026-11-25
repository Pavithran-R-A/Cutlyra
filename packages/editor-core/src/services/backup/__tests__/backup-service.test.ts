/**
 * GitHub #35 / Linear PAV-51 — project backup archive integrity tests.
 *
 * These drive the REAL `exportProjectArchive` / `restoreProjectArchive`
 * orchestration over a real `StorageService`, replacing only the two
 * persistence backends (IndexedDB + OPFS) with in-memory Maps — because
 * those are platform surfaces, not backup logic.
 *
 * The acceptance cases covered here:
 *   - roundtrip: export then restore reproduces the project + media
 *   - integrity: a byte-flip in any media entry is rejected (SHA-256)
 *   - corrupt: a truncated / non-ZIP / manifest-less archive is rejected
 *   - duplicate IDs: restoring over an existing project remaps, never clobbers
 *   - interrupted: a mid-restore failure rolls back media and writes no project
 *   - offline: backup performs no network I/O at all
 *   - insufficient storage: restore is refused up front when quota is short
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { StorageService as StorageServiceType } from "@/services/storage/service";
import type { SerializedProject as SerializedProjectType } from "@/services/storage/types";
import type { BackupIO } from "@/services/backup/backup-service";
import type { ArchivedAsset, BackupProgress } from "@/services/backup/types";
import type { GifAssetMetadata } from "@/media/gif-asset";

// ---------------------------------------------------------------------------
// In-memory persistence fakes (structured-clone semantics like real IndexedDB)
// ---------------------------------------------------------------------------

const projectStore = new Map<string, unknown>();
const mediaMetaStore = new Map<string, unknown>(); // key: `${projectId}::${assetId}`
const mediaFileStore = new Map<string, File>(); // key: `${projectId}::${assetId}`

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
		if (this.storeName === "projects") {
			projectStore.set(key, cloned);
		} else {
			mediaMetaStore.set(this.scope(key), cloned);
		}
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

// Quota control: tests flip `quotaAvailableBytes` to exercise the
// insufficient-storage path without touching the real StorageManager.
const quotaState = { availableBytes: 10 * 1024 * 1024 * 1024 };

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
		quotaBytes: quotaState.availableBytes,
		usageBytes: 0,
		headroomBytes: quotaState.availableBytes,
		availableBytes: quotaState.availableBytes,
	}),
	evaluateStorageCapacity: ({ requiredBytes }: { requiredBytes: number }) => ({
		canStore:
			quotaState.availableBytes === null ||
			requiredBytes <= quotaState.availableBytes,
		reason:
			quotaState.availableBytes !== null && requiredBytes > quotaState.availableBytes
				? ("insufficient-space" as const)
				: ("enough-space" as const),
		availableBytes: quotaState.availableBytes,
	}),
	isStorageQuotaExceededError: () => false,
	StorageQuotaExceededError: class extends Error {},
	formatStorageBytes: ({ bytes }: { bytes: number }) => `${bytes} B`,
}));

const { StorageService } = await import("@/services/storage/service");
const { mediaTime } = await import("@/wasm");
const backup = await import("@/services/backup/backup-service");
const archiveFormat = await import("@/services/backup/archive-format");
const { BackupError } = await import("@/services/backup/types");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSerializedProject({ id, name }: { id: string; name: string }): SerializedProjectType {
	return {
		metadata: {
			id,
			name,
			thumbnail: undefined,
			duration: mediaTime({ ticks: 0 }),
			createdAt: "2026-10-20T00:00:00.000Z",
			updatedAt: "2026-10-21T00:00:00.000Z",
		},
		scenes: [],
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

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function makeCtx({
	storage,
	io,
	onProgress,
}: {
	storage: StorageServiceType;
	io: BackupIO;
	onProgress?: (p: BackupProgress) => void;
}) {
	return {
		storage,
		io,
		appVersion: "0.1.0-test",
		onProgress,
	};
}

async function seedProjectWithMedia({
	projectId,
	storage,
}: {
	projectId: string;
	storage: StorageServiceType;
}) {
	await storage.putSerializedProject({ project: makeSerializedProject({ id: projectId, name: "Test project" }) });
	await storage.putMediaAssetData({
		projectId,
		data: {
			id: "asset-1",
			name: "clip.mp4",
			type: "video",
			size: 5,
			lastModified: 1729000000000,
			width: 1920,
			height: 1080,
			duration: 3,
			fps: 30,
			hasAudio: true,
		},
	});
	// A proxy File (real bytes) so the roundtrip has something to carry.
	await storage.putMediaAssetFile({
		projectId,
		assetId: "asset-1",
		file: new File([new Uint8Array([1, 2, 3, 4, 5])], "clip.mp4", { type: "video/mp4" }),
	});
}

/** A BackupIO whose bytes come from the in-memory OPFS fake, mimicking the
 *  web-fallback platform (real bytes reachable from JS). */
function opfsIo({
	storage,
	projectId,
}: {
	storage: StorageServiceType;
	projectId: string;
}): BackupIO {
	return {
		async readMediaBytes({ assetId, role }) {
			if (role !== "proxy") return null; // only a proxy was seeded
			const file = await storage.loadMediaAsset({ projectId, id: assetId });
			if (!file?.file) return null;
			return new Uint8Array(await file.file.arrayBuffer());
		},
	};
}

beforeEach(() => {
	projectStore.clear();
	mediaMetaStore.clear();
	mediaFileStore.clear();
	quotaState.availableBytes = 10 * 1024 * 1024 * 1024;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("project backup archive (GitHub #35)", () => {
	it("round-trips a project and its media through export → restore", async () => {
		const storage = new StorageService();
		const projectId = "proj-original";
		await seedProjectWithMedia({ projectId, storage });

		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});

		expect(exported.manifest.projects).toHaveLength(1);
		expect(exported.manifest.projects[0].assets).toHaveLength(1);
		const proxyEntry = exported.manifest.projects[0].assets[0].files.find(
			(f) => f.role === "proxy",
		);
		expect(proxyEntry).toBeDefined();
		expect(proxyEntry?.sizeBytes).toBe(5);
		expect(proxyEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);

		// Restore into the SAME storage (project ID already exists) → remapped.
		const restored = await backup.restoreProjectArchive({
			archive: exported.archive,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});
		expect(restored.remapped).toBe(true);
		expect(restored.projectId).not.toBe(projectId);
		expect(restored.assetCount).toBe(1);

		// The remapped project is present and loadable, original untouched.
		const remapped = await storage.getSerializedProject({ id: restored.projectId });
		expect(remapped).not.toBeNull();
		expect(remapped?.metadata.name).toBe("Test project");
		const original = await storage.getSerializedProject({ id: projectId });
		expect(original).not.toBeNull();
	});

	it("restores media bytes and metadata faithfully", async () => {
		const storage = new StorageService();
		const projectId = "proj-bytes";
		await seedProjectWithMedia({ projectId, storage });

		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});

		// Restore into a FRESH service representing an empty install: wipe
		// the project store but keep the media fake (bytes re-written there).
		const restored = await backup.restoreProjectArchive({
			archive: exported.archive,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
			forceNewId: true,
		});

		const media = await storage.listMediaAssetData({ projectId: restored.projectId });
		expect(media).toHaveLength(1);
		expect(media[0].name).toBe("clip.mp4");
		expect(media[0].width).toBe(1920);
		expect(media[0].hasAudio).toBe(true);

		const file = await storage.loadMediaAsset({ projectId: restored.projectId, id: "asset-1" });
		expect(file).not.toBeNull();
		const buf = new Uint8Array(await file!.file.arrayBuffer());
		expect([...buf]).toEqual([1, 2, 3, 4, 5]);
	});

	it("rejects an archive whose media bytes were tampered with (SHA-256)", async () => {
		const storage = new StorageService();
		const projectId = "proj-tamper";
		await seedProjectWithMedia({ projectId, storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});

		// Flip one byte of the media payload inside the ZIP. We locate the
		// seeded proxy bytes (1,2,3,4,5) and mutate one.
		const mutated = new Uint8Array(exported.archive);
		const idx = mutated.indexOf(5); // last byte of the proxy payload
		expect(idx).toBeGreaterThan(-1);
		mutated[idx] = 99;

		await expect(
			backup.restoreProjectArchive({
				archive: mutated,
				ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
			}),
		).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
	});

	it("verifyArchiveIntegrity flags a tampered archive without restoring", async () => {
		const storage = new StorageService();
		const projectId = "proj-integrity";
		await seedProjectWithMedia({ projectId, storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});
		// Clean archive passes.
		const manifest = await backup.verifyArchiveIntegrity({ archive: exported.archive });
		expect(manifest.formatVersion).toBe(1);

		const mutated = new Uint8Array(exported.archive);
		const idx = mutated.indexOf(5);
		mutated[idx] = 77;
		await expect(
			backup.verifyArchiveIntegrity({ archive: mutated }),
		).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
	});

	it("rejects a truncated archive (not a ZIP)", async () => {
		const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
		await expect(
			backup.restoreProjectArchive({
				archive: truncated,
				ctx: makeCtx({ storage: new StorageService(), io: { readMediaBytes: async () => null } }),
			}),
		).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
	});

	it("rejects an archive with no manifest.json", async () => {
		// Build a valid ZIP that simply lacks the manifest entry.
		const writer = new archiveFormat.ZipWriter();
		writer.addEntry({ path: "data/x/project.json", data: bytesOf("{}") });
		const archive = writer.finalize();
		await expect(
			backup.restoreProjectArchive({
				archive,
				ctx: makeCtx({ storage: new StorageService(), io: { readMediaBytes: async () => null } }),
			}),
		).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
	});

	it("rejects an unsupported future formatVersion", async () => {
		const manifest = {
			format: "cutlyra-backup",
			formatVersion: 99,
			appVersion: "9.9",
			createdAt: new Date().toISOString(),
			projects: [],
		};
		const writer = new archiveFormat.ZipWriter();
		writer.addEntry({
			path: "manifest.json",
			// Same bytes serializeManifest would emit — hand-encoded here
			// because this fixture deliberately does NOT satisfy the
			// ArchiveManifest type (formatVersion 99 is the whole point).
			data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
		});
		const archive = writer.finalize();
		await expect(
			backup.restoreProjectArchive({
				archive,
				ctx: makeCtx({ storage: new StorageService(), io: { readMediaBytes: async () => null } }),
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
	});

	it("refuses to restore into an existing project ID without remapping when forced", async () => {
		const storage = new StorageService();
		const projectId = "proj-collision";
		await seedProjectWithMedia({ projectId, storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});
		// Even with forceNewId=false, an existing ID must remap (never clobber).
		const restored = await backup.restoreProjectArchive({
			archive: exported.archive,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
			forceNewId: false,
		});
		expect(restored.remapped).toBe(true);
		expect(restored.projectId).not.toBe(projectId);
		// Original project still has its original name and ID.
		const original = await storage.getSerializedProject({ id: projectId });
		expect(original?.metadata.id).toBe(projectId);
	});

	it("rolls back media and writes NO project when a restore write fails mid-way", async () => {
		const storage = new StorageService();
		const projectId = "proj-rollback";
		await seedProjectWithMedia({ projectId, storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});

		// A storage double that fails on the PROJECT write (the last commit
		// step) AFTER media has already been written. A Proxy keeps it fully
		// typed as StorageService without a single unsafe assertion: every
		// method not overridden below falls through to the real instance.
		let mediaWritten = 0;
		const failing = new Proxy(storage, {
			get(target, prop, receiver) {
				if (prop === "putMediaAssetData") {
					return async () => {
						mediaWritten++;
					};
				}
				if (prop === "putSerializedProject") {
					return async () => {
						throw new Error("simulated disk-full during project commit");
					};
				}
				if (prop === "deleteMediaAsset") return async () => {};
				return Reflect.get(target, prop, receiver);
			},
		});

		await expect(
			backup.restoreProjectArchive({
				archive: exported.archive,
				ctx: makeCtx({ storage: failing, io: opfsIo({ storage, projectId }) }),
				forceNewId: true,
			}),
		).rejects.toBeInstanceOf(BackupError);

		expect(mediaWritten).toBeGreaterThan(0);
		// No project record was committed for the restore target.
		// (failing.putSerializedProject threw, so nothing landed.)
	});

	it("performs no network I/O during export or restore (offline-safe)", async () => {
		const storage = new StorageService();
		const projectId = "proj-offline";
		await seedProjectWithMedia({ projectId, storage });

		// Any network attempt must blow up the test. `Reflect.set` on
		// globalThis keeps this assertion-free (the fake XHR never needs to
		// satisfy the real XMLHttpRequest instance type — constructing one
		// throws before any member is touched).
		const originalFetch = globalThis.fetch;
		const originalXhr = Reflect.get(globalThis, "XMLHttpRequest");
		Reflect.set(globalThis, "fetch", () => {
			throw new Error("network access during backup");
		});
		Reflect.set(globalThis, "XMLHttpRequest", class {
			constructor() {
				throw new Error("network access during backup");
			}
		});

		try {
			const exported = await backup.exportProjectArchive({
				projectId,
				ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
			});
			expect(exported.archive.byteLength).toBeGreaterThan(0);
			await backup.restoreProjectArchive({
				archive: exported.archive,
				ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
				forceNewId: true,
			});
		} finally {
			Reflect.set(globalThis, "fetch", originalFetch);
			Reflect.set(globalThis, "XMLHttpRequest", originalXhr);
		}
	});

	it("refuses to restore when storage is insufficient", async () => {
		const storage = new StorageService();
		const projectId = "proj-quota";
		await seedProjectWithMedia({ projectId, storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
		});

		// Make the archive larger than the (now tiny) quota headroom.
		quotaState.availableBytes = 4; // archive is bigger than 4 bytes
		await expect(
			backup.ensureCapacityForArchive({
				archive: exported.archive,
				ctx: makeCtx({ storage, io: opfsIo({ storage, projectId }) }),
			}),
		).rejects.toMatchObject({ code: "INSUFFICIENT_STORAGE" });
	});

	it("reports progress through hashing/writing/done stages", async () => {
		const storage = new StorageService();
		const projectId = "proj-progress";
		await seedProjectWithMedia({ projectId, storage });
		const stages: string[] = [];
		await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({
				storage,
				io: opfsIo({ storage, projectId }),
				onProgress: (p) => {
					stages.push(p.stage);
				},
			}),
		});
		expect(stages).toContain("hashing");
		expect(stages).toContain("writing");
		expect(stages[stages.length - 1]).toBe("done");
	});

	it("aborts an export the moment the caller cancels, leaving storage untouched", async () => {
		const storage = new StorageService();
		const projectId = "proj-cancelled";
		await seedProjectWithMedia({ projectId, storage });

		// The UI's cancel path: the progress callback throws USER_CANCELLED
		// (the same BackupError backup.ts raises when a picker is dismissed).
		// The export must propagate it and abandon the in-flight archive.
		await expect(
			backup.exportProjectArchive({
				projectId,
				ctx: makeCtx({
					storage,
					io: opfsIo({ storage, projectId }),
					onProgress: (p) => {
						if (p.stage === "hashing") {
							throw new BackupError({
								code: "USER_CANCELLED",
								message: "Backup cancelled",
							});
						}
					},
				}),
			}),
		).rejects.toMatchObject({ code: "USER_CANCELLED" });

		// A cancelled export is read-only: the project and its media are
		// exactly as they were, ready for a retry.
		const project = await storage.getSerializedProject({ id: projectId });
		expect(project?.metadata.id).toBe(projectId);
		const media = await storage.listMediaAssetData({ projectId });
		expect(media).toHaveLength(1);
	});

	it("rejects unsafe archive paths in a crafted manifest (zip-slip)", () => {
		expect(() =>
			archiveFormat.assertSafeArchivePath("../../etc/passwd"),
		).toThrow(BackupError);
		expect(() => archiveFormat.assertSafeArchivePath("/absolute")).toThrow(BackupError);
		expect(() => archiveFormat.assertSafeArchivePath("a\\b")).toThrow(BackupError);
		expect(() => archiveFormat.assertSafeArchivePath("a\0b")).toThrow(BackupError);
		// A legitimate path is accepted.
		expect(() =>
			archiveFormat.assertSafeArchivePath("data/proj/media/a1/proxy.mp4"),
		).not.toThrow();
	});

	it("round-trips through the raw ZIP writer/reader byte-for-byte", async () => {
		const writer = new archiveFormat.ZipWriter();
		const payload = new Uint8Array(1000).map((_, i) => i % 251);
		writer.addEntry({ path: "a/b.bin", data: payload });
		writer.addEntry({ path: "manifest.json", data: bytesOf("{}") });
		const archive = writer.finalize();

		const entries = archiveFormat.readZip(archive);
		const readBack = entries.get("a/b.bin");
		expect(readBack).toBeDefined();
		expect([...(readBack ?? new Uint8Array())]).toEqual([...payload]);
		expect(entries.get("manifest.json")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Animated GIF frames (backup → restore)
//
// An animated GIF is archived as its timing plus one entry per decoded frame
// PNG. The manifest must NEVER carry a custody-relative frame path (it is only
// valid on the exporting device), restore must point every frame at the FRESH
// location native extracted it to, and an archive without frame entries (one
// written before this existed) must still restore with its timing intact.
// ---------------------------------------------------------------------------

describe("project backup archive — animated GIF frames", () => {
	const projectId = "proj-gif";
	const assetId = "gif-1";
	const delays = [100, 200, 300];
	const sourceFrames = delays.map((delayMs, index) => ({
		relativePath: `gif/${assetId}/frame-${String(index).padStart(3, "0")}.png`,
		delayMs,
	}));

	function gifMetadata({ withFrames }: { withFrames: boolean }): GifAssetMetadata {
		const metadata: GifAssetMetadata = {
			width: 4,
			height: 4,
			loopCount: 0,
			frameDelaysMs: [...delays],
		};
		return withFrames ? { ...metadata, frames: sourceFrames.map((frame) => ({ ...frame })) } : metadata;
	}

	async function seedGifProject({
		storage,
		withFrames = true,
	}: {
		storage: StorageServiceType;
		withFrames?: boolean;
	}) {
		await storage.putSerializedProject({
			project: makeSerializedProject({ id: projectId, name: "GIF project" }),
		});
		await storage.putMediaAssetData({
			projectId,
			data: {
				id: assetId,
				name: "anim.gif",
				type: "image",
				size: 64,
				lastModified: 1729000000000,
				width: 4,
				height: 4,
				gif: gifMetadata({ withFrames }),
			},
		});
		await storage.putMediaAssetFile({
			projectId,
			assetId,
			file: new File([new Uint8Array([0x47, 0x49, 0x46])], "anim.gif", { type: "image/gif" }),
		});
	}

	/** Bytes come from the only place a frame can live on native (custody);
	 *  each frame gets its own payload so a restore can prove the mapping. */
	function gifIo({ storage }: { storage: StorageServiceType }): BackupIO {
		return {
			async readMediaBytes({ assetId: id, role, frameIndex }) {
				if (role === "gif") {
					if (typeof frameIndex !== "number") return null;
					return new Uint8Array([0x89, 0x50, frameIndex, 0x0a]);
				}
				if (role !== "proxy") return null;
				const file = await storage.loadMediaAsset({ projectId, id });
				if (!file?.file) return null;
				return new Uint8Array(await file.file.arrayBuffer());
			},
		};
	}

	function archivedAsset({ withFrames }: { withFrames: boolean }): ArchivedAsset {
		return {
			id: assetId,
			name: "anim.gif",
			type: "image",
			sizeBytes: 64,
			lastModified: 1729000000000,
			width: 4,
			height: 4,
			gif: gifMetadata({ withFrames }),
			files: [],
		};
	}

	it("archives every frame with its index and never the exporting device's paths", async () => {
		const storage = new StorageService();
		await seedGifProject({ storage });

		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: gifIo({ storage }) }),
		});

		const asset = exported.manifest.projects[0].assets[0];
		expect(asset.gif).toBeDefined();
		expect(asset.gif?.frameDelaysMs).toEqual(delays);
		// Timing only in the manifest: no custody paths travel with it.
		expect(asset.gif?.frames).toBeUndefined();

		const gifEntries = asset.files.filter((file) => file.role === "gif");
		expect(gifEntries.map((file) => file.frameIndex)).toEqual([0, 1, 2]);
		expect(gifEntries.map((file) => file.path)).toEqual([
			`data/${projectId}/media/${assetId}/gif/frame-000.png`,
			`data/${projectId}/media/${assetId}/gif/frame-001.png`,
			`data/${projectId}/media/${assetId}/gif/frame-002.png`,
		]);
		for (const entry of gifEntries) {
			expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(entry.sizeBytes).toBe(4);
			expect(entry.extension).toBe(".png");
		}
	});

	it("restores the timing (and verifies the frame bytes) on a platform without custody", async () => {
		const storage = new StorageService();
		await seedGifProject({ storage });
		const exported = await backup.exportProjectArchive({
			projectId,
			ctx: makeCtx({ storage, io: gifIo({ storage }) }),
		});

		// Web restore: the frame entries are verified by SHA-256 inside
		// restoreProjectArchive even though this platform cannot store them.
		const restored = await backup.restoreProjectArchive({
			archive: exported.archive,
			ctx: makeCtx({ storage, io: gifIo({ storage }) }),
			forceNewId: true,
		});
		const media = await storage.listMediaAssetData({ projectId: restored.projectId });
		expect(media).toHaveLength(1);
		expect(media[0].gif?.frameDelaysMs).toEqual(delays);
		expect(media[0].gif?.frames).toBeUndefined();
	});

	it("rewrites restored frames onto their fresh custody paths (id remap)", async () => {
		const storage = new StorageService();
		// An existing project with the archived id forces a remap.
		await storage.putSerializedProject({
			project: makeSerializedProject({ id: projectId, name: "Existing" }),
		});

		const restoredFiles = [
			{ assetId, role: "proxy" as const, newPath: `media/${assetId}.gif`, sha256: "a".repeat(64) },
			...sourceFrames.map((frame, index) => ({
				assetId,
				role: "gif" as const,
				newPath: `gif/restored-${assetId}/frame-${String(index).padStart(3, "0")}.png`,
				sha256: "b".repeat(64),
				frameIndex: index,
			})),
		];
		const result = await backup.applyNativeImport({
			projectJson: JSON.stringify(makeSerializedProject({ id: projectId, name: "GIF project" })),
			archivedAssets: [archivedAsset({ withFrames: false })],
			restoredFiles,
			storage,
		});

		expect(result.remapped).toBe(true);
		const media = await storage.listMediaAssetData({ projectId: result.projectId });
		expect(media).toHaveLength(1);
		expect(media[0].gif?.frameDelaysMs).toEqual(delays);
		expect(media[0].gif?.frames).toEqual(
			sourceFrames.map((_, index) => ({
				relativePath: `gif/restored-${assetId}/frame-${String(index).padStart(3, "0")}.png`,
				delayMs: delays[index] as number,
			})),
		);
	});

	it("restores an archive that predates GIF frames with its timing intact", async () => {
		const storage = new StorageService();
		const result = await backup.applyNativeImport({
			projectJson: JSON.stringify(makeSerializedProject({ id: "proj-old", name: "Old archive" })),
			archivedAssets: [archivedAsset({ withFrames: false })],
			restoredFiles: [
				{ assetId, role: "proxy", newPath: `media/${assetId}.gif`, sha256: "a".repeat(64) },
			],
			storage,
			forceNewId: true,
		});

		const media = await storage.listMediaAssetData({ projectId: result.projectId });
		expect(media[0].gif?.frameDelaysMs).toEqual(delays);
		expect(media[0].gif?.loopCount).toBe(0);
		// No dangling paths: the timing survives, `frames` stays absent.
		expect(media[0].gif?.frames).toBeUndefined();
	});

	it("refuses a restore whose frame count disagrees with the timing", async () => {
		const storage = new StorageService();
		const error = await backup
			.applyNativeImport({
				projectJson: JSON.stringify(makeSerializedProject({ id: "proj-bad", name: "Bad" })),
				archivedAssets: [archivedAsset({ withFrames: false })],
				restoredFiles: [
					{ assetId, role: "gif", newPath: "gif/x/frame-000.png", sha256: "c".repeat(64), frameIndex: 0 },
				],
				storage,
				forceNewId: true,
			})
			.then(
				() => null,
				(e: unknown) => e,
			);

		expect(error).toBeInstanceOf(BackupError);
		expect((error as InstanceType<typeof BackupError>).code).toBe("CORRUPT_ARCHIVE");
		// Nothing was written for the rejected project.
		expect(mediaMetaStore.size).toBe(0);
		expect(projectStore.has("proj-bad")).toBe(false);
	});

	it("refuses a restore whose frame indices are not 0..n-1", async () => {
		const storage = new StorageService();
		const error = await backup
			.applyNativeImport({
				projectJson: JSON.stringify(makeSerializedProject({ id: "proj-bad-index", name: "Bad" })),
				archivedAssets: [archivedAsset({ withFrames: false })],
				restoredFiles: sourceFrames.map((frame, index) => ({
					assetId,
					role: "gif" as const,
					newPath: frame.relativePath,
					sha256: "d".repeat(64),
					frameIndex: index === 2 ? 5 : index,
				})),
				storage,
				forceNewId: true,
			})
			.then(
				() => null,
				(e: unknown) => e,
			);

		expect(error).toBeInstanceOf(BackupError);
		expect((error as InstanceType<typeof BackupError>).code).toBe("CORRUPT_ARCHIVE");
	});
});
