/**
 * The platform-agnostic backup orchestration for GitHub #35 / Linear PAV-51.
 *
 * This file owns everything about a backup that is NOT byte plumbing:
 *   - assembling the manifest from a project's persisted records,
 *   - verifying SHA-256 integrity before anything is committed,
 *   - remapping a duplicate project ID on restore,
 *   - ordering writes so an interrupted restore never leaves a half-project,
 *   - refusing to start when storage is insufficient.
 *
 * The BYTE plumbing — where media bytes actually live — is injected via
 * `BackupIO`, because it is genuinely platform-dependent:
 *
 *   - WEB: bytes live in OPFS (`media-files-<projectId>`), readable directly.
 *   - ANDROID/iOS: bytes live in NATIVE CUSTODY (`noBackupFilesDir/media/…`)
 *     behind the bridge, which never carries video bytes (plan §2.2). There,
 *     the native side assembles the archive itself; the JS here builds the
 *     RECIPE (project JSON + media descriptors) and hands it over, then
 *     receives the authoritative manifest back.
 *
 * So this module is the REFERENCE implementation of the backup semantics,
 * exercised end-to-end by the unit tests with an in-memory `BackupIO`. The
 * native Kotlin implementation mirrors the same manifest/integrity/ordering
 * contract; the emulator end-to-end test proves the native path round-trips.
 *
 * Ordering guarantees on restore (interrupted-operation recovery):
 *   1. media records + files are written first (tracked for rollback),
 *   2. the PROJECT record is written LAST.
 * A crash or failure mid-restore therefore leaves no visible half-project:
 * worst case is orphaned media metadata, which the rollback path deletes on
 * a caught error and which a re-import simply overwrites on a hard crash.
 */

import type { SerializedProject, MediaAssetData } from "@/services/storage/types";
import type { StorageService } from "@/services/storage/service";
import {
	ARCHIVE_FORMAT_VERSION,
	BackupError,
	type ArchiveManifest,
	type ArchivedAsset,
	type ArchivedFileEntry,
	type ArchivedFileRole,
	type BackupProgress,
	type ArchivedProject,
} from "./types";
import {
	ZipWriter,
	mediaEntryPath,
	parseManifest,
	projectEntryPath,
	readZip,
	serializeManifest,
	sha256Hex,
	validateManifest,
} from "./archive-format";

/** Where media bytes come from / go to, per platform. See header comment. */
export interface BackupIO {
	/**
	 * Reads the bytes for one media role of an asset, or null when that role
	 * does not exist (no thumbnail generated, legacy asset with no source,
	 * web-fallback proxy-only import, ...). `undefined` vs null matters not —
	 * both mean "absent from the archive".
	 */
	readMediaBytes(params: {
		projectId: string;
		assetId: string;
		role: ArchivedFileRole;
	}): Promise<Uint8Array | null>;
}

export interface ExportResult {
	manifest: ArchiveManifest;
	archive: Uint8Array;
	/** Total uncompressed bytes across all data entries (pre-quota check). */
	totalBytes: number;
}

/** App version stamped into the manifest (informational only). */
export interface BackupContext {
	storage: StorageService;
	io: BackupIO;
	appVersion: string;
	/** Reports progress during long exports/imports; optional. */
	onProgress?: (progress: BackupProgress) => void;
}

const ROLES: ArchivedFileRole[] = ["proxy", "source", "thumbnail"];

function reportProgress({
	ctx,
	stage,
	fraction,
}: {
	ctx: BackupContext;
	stage: BackupProgress["stage"];
	fraction: number;
}): void {
	ctx.onProgress?.({ stage, fraction });
}

function extensionFor({ role, name }: { role: ArchivedFileRole; name: string }): string {
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) return name.slice(dot);
	// Fall back to a role-appropriate default when the asset name has no
	// usable extension (e.g. "Untitled" or a UUID-keyed stub).
	return role === "thumbnail" ? ".jpg" : ".bin";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Builds a complete archive for one project: SerializedProject JSON + every
 * available media file, each fingerprinted with SHA-256 into the manifest.
 */
export async function exportProjectArchive({
	projectId,
	ctx,
}: {
	projectId: string;
	ctx: BackupContext;
}): Promise<ExportResult> {
	const serialized = await ctx.storage.getSerializedProject({ id: projectId });
	if (!serialized) {
		throw new BackupError({
			code: "IO_ERROR",
			message: `Cannot back up: project ${projectId} does not exist`,
		});
	}
	const mediaData = await ctx.storage.listMediaAssetData({ projectId });

	reportProgress({ ctx, stage: "preparing", fraction: 0 });

	const projectJson = new TextEncoder().encode(JSON.stringify(serialized, null, 2));
	const archivedAssets: ArchivedAsset[] = [];
	const writer = new ZipWriter();

	let totalBytes = 0;
	let processed = 0;
	const work = mediaData.length + 1; // +1 for the project JSON

	// Project JSON entry.
	const projectPath = projectEntryPath(projectId);
	const projectSha = await sha256Hex({ bytes: projectJson });
	totalBytes += projectJson.byteLength;
	writer.addEntry({ path: projectPath, data: projectJson });
	processed++;
	reportProgress({ ctx, stage: "hashing", fraction: processed / work });

	for (const asset of mediaData) {
		const files: ArchivedFileEntry[] = [];
		for (const role of ROLES) {
			const bytes = await ctx.io.readMediaBytes({ projectId, assetId: asset.id, role });
			if (!bytes) continue;
			const extension = extensionFor({ role, name: asset.name });
			const path = mediaEntryPath({
				projectId,
				assetId: asset.id,
				role,
				extension,
			});
			const sha = await sha256Hex({ bytes });
			totalBytes += bytes.byteLength;
			writer.addEntry({ path, data: bytes });
			files.push({
				role,
				path,
				sizeBytes: bytes.byteLength,
				sha256: sha,
				extension,
			});
			processed++;
			reportProgress({ ctx, stage: "hashing", fraction: processed / work });
		}
		archivedAssets.push({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			sizeBytes: asset.size,
			lastModified: asset.lastModified,
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			hasAudio: asset.hasAudio,
			sourceRotationDegrees: asset.sourceRotationDegrees,
			sourceWidth: asset.sourceWidth,
			sourceHeight: asset.sourceHeight,
			files,
		});
	}

	const archivedProject: ArchivedProject = {
		id: projectId,
		name: serialized.metadata.name,
		projectEntry: {
			path: projectPath,
			sizeBytes: projectJson.byteLength,
			sha256: projectSha,
		},
		assets: archivedAssets,
	};

	const manifest: ArchiveManifest = {
		format: "cutlyra-backup",
		formatVersion: ARCHIVE_FORMAT_VERSION,
		appVersion: ctx.appVersion,
		createdAt: new Date().toISOString(),
		projects: [archivedProject],
	};

	// Manifest is written LAST so its hashes reflect everything already
	// added; the reader only needs the central directory, so order inside
	// the container is irrelevant to parsing.
	writer.addEntry({ path: "manifest.json", data: serializeManifest(manifest) });

	reportProgress({ ctx, stage: "writing", fraction: 0.9 });
	const archive = writer.finalize();
	reportProgress({ ctx, stage: "done", fraction: 1 });

	return { manifest, archive, totalBytes };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface RestoreResult {
	/** The project ID under which the archive was restored (may differ from
	 *  the archived ID when it was remapped to avoid a collision). */
	projectId: string;
	/** True when the archived ID already existed and was remapped. */
	remapped: boolean;
	assetCount: number;
}

/**
 * Restores a project from an archive. Verification is ALL-OR-NOTHING: every
 * entry's SHA-256 is checked before the first write. On a duplicate project
 * ID the archive is restored under a fresh ID (never overwriting an existing
 * project). The project record is committed last so an interruption cannot
 * surface a half-restored project in the project list.
 */
export async function restoreProjectArchive({
	archive,
	ctx,
	forceNewId = false,
}: {
	archive: Uint8Array;
	ctx: BackupContext;
	forceNewId?: boolean;
}): Promise<RestoreResult> {
	reportProgress({ ctx, stage: "preparing", fraction: 0 });

	const entries = readZip(archive);
	const manifestBytes = entries.get("manifest.json");
	if (!manifestBytes) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "Archive is missing manifest.json",
		});
	}
	const manifest: ArchiveManifest = parseManifest(manifestBytes);

	if (manifest.projects.length !== 1) {
		throw new BackupError({
			code: "UNSUPPORTED_FORMAT",
			message: `Expected exactly one project per archive, found ${manifest.projects.length}`,
		});
	}
	const archived = manifest.projects[0];

	// ---- Integrity verification: hash EVERYTHING before writing ANYTHING. ----
	reportProgress({ ctx, stage: "hashing", fraction: 0 });
	const projectBytes = await verifyEntry({
		entries,
		path: archived.projectEntry.path,
		expectedSha: archived.projectEntry.sha256,
		expectedSize: archived.projectEntry.sizeBytes,
	});

	const verified: {
		asset: ArchivedAsset;
		role: ArchivedFileRole;
		path: string;
		bytes: Uint8Array;
		extension: string;
	}[] = [];
	for (const asset of archived.assets) {
		for (const file of asset.files) {
			const bytes = await verifyEntry({
				entries,
				path: file.path,
				expectedSha: file.sha256,
				expectedSize: file.sizeBytes,
			});
			verified.push({ asset, role: file.role, path: file.path, bytes, extension: file.extension });
		}
	}
	reportProgress({ ctx, stage: "hashing", fraction: 1 });

	// ---- Parse + validate the project record itself. ----
	let serialized: SerializedProject;
	try {
		serialized = parseProjectRecord({
			json: new TextDecoder().decode(projectBytes),
			origin: "project.json in the archive",
		});
	} catch (error) {
		if (error instanceof BackupError) throw error;
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "project.json in the archive could not be read",
		});
	}

	// ---- Duplicate-ID remapping (never clobber an existing project). ----
	const archivedId = serialized.metadata.id;
	let targetId = archivedId;
	let remapped = false;
	if (forceNewId || (await ctx.storage.projectExists({ id: archivedId }))) {
		targetId = `${archivedId}-restored-${Date.now().toString(36)}`;
		remapped = true;
	}
	serialized = { ...serialized, metadata: { ...serialized.metadata, id: targetId } };

	// ---- Commit: media first (tracked), project LAST. ----
	reportProgress({ ctx, stage: "writing", fraction: 0 });
	const writtenAssetIds: string[] = [];
	try {
		const byAsset = new Map<string, typeof verified>();
		for (const item of verified) {
			const list = byAsset.get(item.asset.id) ?? [];
			list.push(item);
			byAsset.set(item.asset.id, list);
		}

		let committed = 0;
		const total = byAsset.size || 1;
		for (const [assetId, items] of byAsset) {
			const proxy = items.find((i) => i.role === "proxy");
			const source = items.find((i) => i.role === "source");
			const thumb = items.find((i) => i.role === "thumbnail");
			const first = items[0].asset;

			const primary = proxy ?? source ?? thumb;
			// Native-custody platforms replace these with fresh native paths
			// during their own extraction; the web path has no native custody,
			// so the archived relative paths are preserved as-is.
			const data: MediaAssetData = {
				id: assetId,
				name: first.name,
				type: first.type,
				size: first.sizeBytes,
				lastModified: first.lastModified,
				width: first.width,
				height: first.height,
				duration: first.duration,
				fps: first.fps,
				hasAudio: first.hasAudio,
				sourceRotationDegrees: first.sourceRotationDegrees,
				sourceWidth: first.sourceWidth,
				sourceHeight: first.sourceHeight,
			};

			if (primary) {
				const file = bytesToFile({ bytes: primary.bytes, name: first.name, type: first.type });
				await ctx.storage.putMediaAssetFile({ projectId: targetId, assetId, file });
			}
			await ctx.storage.putMediaAssetData({ projectId: targetId, data });
			writtenAssetIds.push(assetId);
			committed++;
			reportProgress({ ctx, stage: "writing", fraction: committed / total });
		}

		await ctx.storage.putSerializedProject({ project: serialized });
	} catch (error) {
		// Interrupted/failed restore: roll back the media records we already
		// wrote so no orphaned half-project or dangling media remains. The
		// project record was never written, so the project list is untouched.
		for (const assetId of writtenAssetIds) {
			try {
				await ctx.storage.deleteMediaAsset({ projectId: targetId, id: assetId });
			} catch {
				// Preserve the original error; best-effort cleanup only.
			}
		}
		if (error instanceof BackupError) throw error;
		throw new BackupError({
			code: "IO_ERROR",
			message: `Restore failed and was rolled back: ${errorDetails(error)}`,
		});
	}

	reportProgress({ ctx, stage: "done", fraction: 1 });
	return { projectId: targetId, remapped, assetCount: byAssetSize(verified) };
}

function byAssetSize(verified: { asset: { id: string } }[]): number {
	return new Set(verified.map((v) => v.asset.id)).size;
}

/** Full SHA-256 + size verification of one declared entry. Throws
 *  CORRUPT_ARCHIVE on any mismatch. Used by BOTH the restore commit path
 *  and the standalone `verifyArchiveIntegrity` pre-flight. */
async function verifyEntry({
	entries,
	path,
	expectedSha,
	expectedSize,
}: {
	entries: Map<string, Uint8Array>;
	path: string;
	expectedSha: string;
	expectedSize: number;
}): Promise<Uint8Array> {
	const bytes = entries.get(path);
	if (!bytes) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `Archive is missing declared entry ${path}`,
		});
	}
	if (bytes.byteLength !== expectedSize) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `Size mismatch for ${path}: manifest says ${expectedSize}, archive holds ${bytes.byteLength}`,
		});
	}
	const actual = await sha256Hex({ bytes });
	if (actual !== expectedSha) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `SHA-256 mismatch for ${path}: archive is corrupt or tampered`,
		});
	}
	return bytes;
}

/**
 * Standalone pre-flight: parses the manifest and verifies EVERY declared
 * entry's SHA-256 without restoring anything. The UI calls this first so a
 * corrupt archive is rejected with a clear message BEFORE the user commits
 * to a restore (and before the capacity/rollback machinery runs).
 */
export async function verifyArchiveIntegrity({
	archive,
}: {
	archive: Uint8Array;
}): Promise<ArchiveManifest> {
	const entries = readZip(archive);
	const manifestBytes = entries.get("manifest.json");
	if (!manifestBytes) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "Archive is missing manifest.json",
		});
	}
	const manifest = validateManifest(
		JSON.parse(new TextDecoder().decode(manifestBytes)),
	);

	for (const project of manifest.projects) {
		await verifyEntry({
			entries,
			path: project.projectEntry.path,
			expectedSha: project.projectEntry.sha256,
			expectedSize: project.projectEntry.sizeBytes,
		});
		for (const asset of project.assets) {
			for (const file of asset.files) {
				await verifyEntry({
					entries,
					path: file.path,
					expectedSha: file.sha256,
					expectedSize: file.sizeBytes,
				});
			}
		}
	}
	return manifest;
}

// ---------------------------------------------------------------------------
// Storage sufficiency guard
// ---------------------------------------------------------------------------

/**
 * Refuses to START a restore when the archive cannot possibly fit, so the
 * user gets an honest "not enough space" up front rather than a mid-write
 * failure that rolls back (GitHub #35 acceptance: insufficient-storage case).
 */
export async function ensureCapacityForArchive({
	archive,
	ctx,
}: {
	archive: Uint8Array;
	ctx: BackupContext;
}): Promise<void> {
	// Rough lower bound: the compressed archive size is a floor for the
	// uncompressed payload (media is STORE, so ~equal; project JSON inflates
	// slightly). Use the archive length as the required-bytes estimate.
	const check = await ctx.storage.canStoreFile({ size: archive.byteLength });
	if (!check.canStore) {
		throw new BackupError({
			code: "INSUFFICIENT_STORAGE",
			message: `Not enough storage to restore this archive (need ~${archive.byteLength} bytes)`,
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A one-line description of ANY thrown value without asserting `instanceof
 *  Error` (assertions on caught values are exactly what the lint rule
 *  exists to prevent — a caught value can be anything). */
function errorDetails(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : JSON.stringify(error);
}

/** The structural minimum of a SerializedProject for restore purposes: an
 *  object whose `metadata.id` is a non-empty string. This is a TYPE PREDICATE
 *  built from `in`-narrowing (never an assertion on parsed JSON — `JSON.parse`
 *  yields `any` and asserting it is exactly the trust the CORRUPT_ARCHIVE
 *  check exists to refuse). Everything beyond the ID is passed through as the
 *  exporting build wrote it, same as the app's own load path. */
function isProjectRecord(value: unknown): value is SerializedProject {
	if (typeof value !== "object" || value === null) return false;
	if (!("metadata" in value)) return false;
	const metadata = value.metadata;
	if (typeof metadata !== "object" || metadata === null) return false;
	if (!("id" in metadata)) return false;
	return typeof metadata.id === "string" && metadata.id.length > 0;
}

/** Parses project JSON from an archive, rejecting anything that is not a
 *  project record. Shared by the web restore and the native import paths. */
function parseProjectRecord({
	json,
	origin,
}: {
	json: string;
	origin: string;
}): SerializedProject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `${origin} is not valid JSON`,
		});
	}
	if (!isProjectRecord(parsed)) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `${origin} is missing metadata.id`,
		});
	}
	return parsed;
}

function bytesToFile({
	bytes,
	name,
	type,
}: {
	bytes: Uint8Array;
	name: string;
	type: string;
}): File {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new File([copy], name, { type: mimeFor({ type, name }) });
}

function mimeFor({ type, name }: { type: string; name: string }): string {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	if (type === "image") return ext === "svg" ? "image/svg+xml" : `image/${ext || "png"}`;
	if (type === "audio") return `audio/${ext || "mpeg"}`;
	return `video/${ext || "mp4"}`;
}

// ---------------------------------------------------------------------------
// Native-custody recipe path (Android / iOS)
//
// On native platforms the media BYTES live behind the bridge in native
// custody and must never cross it (plan §2.2). So JS does NOT assemble the
// archive there — it hands native a RECIPE (the SerializedProject JSON plus
// a descriptor for every media file, each carrying its custody-relative
// path). Native reads the real bytes, hashes them, streams them into the
// container at the SAF destination, and returns the authoritative manifest
// (with the SHA-256 values native computed) for JS to persist.
// ---------------------------------------------------------------------------

export interface NativeMediaDescriptor {
	assetId: string;
	/** Custody-root-relative path (Media/native/<id>.mp4). Native resolves
	 *  it against `getMediaRoot()`. Null when that role does not exist. */
	proxyPath: string | null;
	sourcePath: string | null;
	thumbnailPath: string | null;
	name: string;
	type: "video" | "audio" | "image";
	sizeBytes: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	sourceRotationDegrees?: 0 | 90 | 180 | 270;
	sourceWidth?: number;
	sourceHeight?: number;
}

/** Builds the JSON-only recipe for a native archive export. */
export async function buildExportRecipe({
	projectId,
	storage,
}: {
	projectId: string;
	storage: StorageService;
}): Promise<{ projectJson: string; projectName: string; media: NativeMediaDescriptor[] }> {
	const serialized = await storage.getSerializedProject({ id: projectId });
	if (!serialized) {
		throw new BackupError({
			code: "IO_ERROR",
			message: `Cannot back up: project ${projectId} does not exist`,
		});
	}
	const mediaData = await storage.listMediaAssetData({ projectId });
	const media: NativeMediaDescriptor[] = mediaData.map((asset) => ({
		assetId: asset.id,
		proxyPath: asset.nativeRelativePath ?? null,
		sourcePath: asset.sourceNativeRelativePath ?? null,
		thumbnailPath: asset.thumbnailNativeRelativePath ?? null,
		name: asset.name,
		type: asset.type,
		sizeBytes: asset.size,
		lastModified: asset.lastModified,
		width: asset.width,
		height: asset.height,
		duration: asset.duration,
		fps: asset.fps,
		hasAudio: asset.hasAudio,
		sourceRotationDegrees: asset.sourceRotationDegrees,
		sourceWidth: asset.sourceWidth,
		sourceHeight: asset.sourceHeight,
	}));
	return {
		projectJson: JSON.stringify(serialized, null, 2),
		projectName: serialized.metadata.name,
		media,
	};
}

/** One media file's bytes as native restored them into custody. `newPath`
 *  is the FRESH custody-relative path native wrote (never the archived one,
 *  so a restore never overwrites an existing file). */
export interface RestoredMediaFile {
	assetId: string;
	role: "proxy" | "source" | "thumbnail";
	newPath: string;
	sha256: string;
}

/** Applies a native-verified import: writes the project record (remapping a
 *  duplicate ID) and the media metadata records pointing at the FRESH native
 *  paths native already committed. Returns the final project ID + remap flag.
 *  Byte verification already happened NATIVE-side (native refuses to return
 *  a recipe for an archive whose SHA-256s don't match), so this only has to
 *  get the records right and keep the ID collision-free. */
export async function applyNativeImport({
	projectJson,
	archivedAssets,
	restoredFiles,
	storage,
	forceNewId = false,
}: {
	projectJson: string;
	archivedAssets: ArchivedAsset[];
	restoredFiles: RestoredMediaFile[];
	storage: StorageService;
	forceNewId?: boolean;
}): Promise<RestoreResult> {
	let serialized: SerializedProject;
	try {
		serialized = parseProjectRecord({ json: projectJson, origin: "project.json from native import" });
	} catch (error) {
		if (error instanceof BackupError) throw error;
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "project.json from native import could not be read",
		});
	}

	const archivedId = serialized.metadata.id;
	let targetId = archivedId;
	let remapped = false;
	if (forceNewId || (await storage.projectExists({ id: archivedId }))) {
		targetId = `${archivedId}-restored-${Date.now().toString(36)}`;
		remapped = true;
	}
	serialized = { ...serialized, metadata: { ...serialized.metadata, id: targetId } };

	// Group the restored files by asset so each asset's metadata points at
	// the right per-role paths.
	const byAsset = new Map<string, RestoredMediaFile[]>();
	for (const file of restoredFiles) {
		const list = byAsset.get(file.assetId) ?? [];
		list.push(file);
		byAsset.set(file.assetId, list);
	}

	const writtenAssetIds: string[] = [];
	try {
		for (const [assetId, files] of byAsset) {
			const archived = archivedAssets.find((a) => a.id === assetId);
			const proxy = files.find((f) => f.role === "proxy");
			const source = files.find((f) => f.role === "source");
			const thumb = files.find((f) => f.role === "thumbnail");
			// Native-custody restore: the bytes are already in native custody at
			// the fresh paths above — OPFS only gets the ZERO-BYTE STUB (the same
			// shape `media/native-import.ts` creates on import). Without it,
			// `loadMediaAsset` finds no file record and the restored asset is
			// invisible (file && metadata must both exist).
			await storage.putMediaAssetFile({
				projectId: targetId,
				assetId,
				file: new File([], archived?.name ?? assetId, {
					type: mimeFor({
					type: archived?.type ?? "video",
					name: archived?.name ?? "x.mp4",
				}),
				}),
			});
			await storage.putMediaAssetData({
				projectId: targetId,
				data: {
					id: assetId,
					name: archived?.name ?? "",
					type: archived?.type ?? "video",
					size: archived?.sizeBytes ?? 0,
					lastModified: archived?.lastModified ?? 0,
					width: archived?.width,
					height: archived?.height,
					duration: archived?.duration,
					fps: archived?.fps,
					hasAudio: archived?.hasAudio,
					sourceRotationDegrees: archived?.sourceRotationDegrees,
					sourceWidth: archived?.sourceWidth,
					sourceHeight: archived?.sourceHeight,
					nativeRelativePath: proxy?.newPath,
					sourceNativeRelativePath: source?.newPath,
					thumbnailNativeRelativePath: thumb?.newPath,
				},
			});
			writtenAssetIds.push(assetId);
		}
		await storage.putSerializedProject({ project: serialized });
	} catch (error) {
		for (const assetId of writtenAssetIds) {
			try {
				await storage.deleteMediaAsset({ projectId: targetId, id: assetId });
			} catch {
				// Preserve the original error; best-effort cleanup only.
			}
		}
		if (error instanceof BackupError) throw error;
		throw new BackupError({
			code: "IO_ERROR",
			message: `Restore failed and was rolled back: ${errorDetails(error)}`,
		});
	}

	return { projectId: targetId, remapped, assetCount: byAsset.size };
}
