/**
 * GitHub #35 / Linear PAV-51 — project backup archives.
 *
 * An archive is a standard ZIP container (STORE method — media is already
 * compressed, so DEFLATE would burn CPU for nothing) with this layout:
 *
 *   manifest.json                     — the versioned manifest below
 *   data/project-<projectId>.json     — the SerializedProject record
 *   data/media/<assetId>.<ext>        — one entry per archived media file
 *
 * Every byte that goes into the archive is fingerprinted: each file entry
 * carries its SHA-256 in the manifest, and the import path verifies every
 * hash before a single byte is committed to app storage. A truncated,
 * tampered or corrupt archive is rejected whole — a backup that restores
 * silently-corrupt media is worse than no backup at all.
 *
 * SCOPE (deliberate): one project per archive. Multi-project bundles add
 * partial-failure semantics ("3 of 7 projects restored") that make the
 * interrupted-operation story much harder to reason about; per-project
 * archives compose fine at the UI layer ("backup all" = export each).
 */

/** Container format version. Bump on ANY breaking manifest change. */
export const ARCHIVE_FORMAT = "cutlyra-backup" as const;
export const ARCHIVE_FORMAT_VERSION = 1 as const;

/** The manifest file's name inside the container. */
export const MANIFEST_ENTRY_NAME = "manifest.json" as const;

/** A media file role inside the archive. */
export type ArchivedFileRole = "proxy" | "source" | "thumbnail";

/**
 * One archived media file. `path` is a CONTAINER-INTERNAL path (always
 * under `data/`), never a filesystem path — the importer never trusts it
 * as one (see `assertSafeArchivePath`).
 */
export interface ArchivedFileEntry {
	role: ArchivedFileRole;
	path: string;
	sizeBytes: number;
	/** Lowercase hex SHA-256 of the entry's uncompressed bytes. */
	sha256: string;
	/** Extension (with dot) used to rebuild the restored file's name. */
	extension: string;
}

/**
 * One archived media asset: its persisted metadata plus the file entries
 * that back it. `files` may be a subset of the three roles (a project that
 * never generated a thumbnail simply has no thumbnail entry; a legacy
 * asset whose source was cleaned up has no source entry) — the restore is
 * degraded-but-honest in exactly the same way the export pipeline already
 * falls back (see MediaAssetData.sourceNativeRelativePath's doc comment).
 */
export interface ArchivedAsset {
	id: string;
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
	files: ArchivedFileEntry[];
}

export interface ArchivedProject {
	id: string;
	name: string;
	/** Container-internal path of the SerializedProject JSON. */
	projectEntry: { path: string; sizeBytes: number; sha256: string };
	assets: ArchivedAsset[];
}

/** manifest.json — the versioned archive manifest. */
export interface ArchiveManifest {
	format: typeof ARCHIVE_FORMAT;
	formatVersion: typeof ARCHIVE_FORMAT_VERSION;
	/** App version that produced the archive (informational). */
	appVersion: string;
	createdAt: string;
	projects: ArchivedProject[];
}

/**
 * Backup failures the UI must be able to tell apart:
 *  - corrupt: the archive failed structural/hash validation (never partial-commit)
 *  - unsupported: a newer/unknown formatVersion
 *  - cancelled: the user backed out of the picker (not an error condition)
 *  - insufficient-storage: estimated restore size exceeds available quota
 *  - io: read/write failure at the storage layer
 */
export type BackupErrorCode =
	| "CORRUPT_ARCHIVE"
	| "UNSUPPORTED_FORMAT"
	| "USER_CANCELLED"
	| "INSUFFICIENT_STORAGE"
	| "IO_ERROR"
	// From the native bridge (mirrors NativeBridgeErrorCode): the platform
	// refused or cannot perform the operation — meaningfully different from a
	// corrupt archive or a full disk.
	| "PERMISSION_DENIED"
	| "UNSUPPORTED";

export class BackupError extends Error {
	readonly code: BackupErrorCode;
	constructor({ code, message }: { code: BackupErrorCode; message: string }) {
		super(message);
		this.name = "BackupError";
		this.code = code;
	}
}

/** Progress stages for a streaming export (web path) / event stream. */
export type BackupStage =
	| "preparing"
	| "hashing"
	| "writing"
	| "done"
	| "error";

export interface BackupProgress {
	stage: BackupStage;
	/** 0..1. Always 1 for "done"/"error". */
	fraction: number;
	error?: string;
}

/**
 * What the platform adapter must provide to the backup service. On Android
 * the media BYTES live in native custody (`noBackupFilesDir/media/...`,
 * see MediaImporter) and must never cross the bridge (plan §2.2: "no video
 * bytes on the bridge — ever"), so the native side assembles and verifies
 * the container itself; this interface is what the JS orchestration needs
 * from either platform.
 */
export interface BackupPlatformAdapter {
	/**
	 * Suggests a destination for a new archive (SAF create-document on
	 * Android, a download on web). Resolves with a platform handle or null
	 * when the user cancelled.
	 */
	pickArchiveDestination(params: {
		suggestedName: string;
	}): Promise<string | null>;
	/**
	 * Lets the user choose an existing archive (SAF open-document on
	 * Android, a file input on web). Resolves with a platform handle or
	 * null when the user cancelled.
	 */
	pickArchiveSource(): Promise<string | null>;
}
