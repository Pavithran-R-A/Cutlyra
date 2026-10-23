/**
 * Backup/Restore orchestration for the app shell (GitHub #35 / Linear PAV-51).
 *
 * This is the LAYER BOUNDARY file: editor-core owns all backup *semantics*
 * (manifest, integrity, remapping, rollback — `services/backup/`), the
 * native-bridge owns byte-free *transport*, and this module chooses the
 * platform path and stitches them together:
 *
 *  - ANDROID/iOS: media bytes live in native custody and never cross the
 *    bridge (plan §2.2), so we hand native a JSON recipe, native streams the
 *    real bytes into the archive (or out of one on restore), and JS only
 *    persists the records afterwards.
 *  - WEB: bytes live in OPFS and are JS-readable, so the editor-core
 *    reference implementation builds/parses the whole archive in JS and the
 *    browser's download / file-input stands in for SAF.
 *
 * A single cancelled picker is NOT an error anywhere in this file: it
 * surfaces as `BackupError({code:"USER_CANCELLED"})` so the screen can say
 * "cancelled" rather than "failed".
 */
import { getNativeBridge } from "@cutlyra/native-bridge";
import { NativeBridgeError } from "@cutlyra/native-bridge";
import { storageService } from "@cutlyra/editor-core/services/storage/service";
import {
	applyNativeImport,
	buildExportRecipe,
	ensureCapacityForArchive,
	exportProjectArchive,
	restoreProjectArchive,
	verifyArchiveIntegrity,
	type BackupContext,
	type BackupIO,
	type RestoreResult,
} from "@cutlyra/editor-core/services/backup/backup-service";
import {
	BackupError,
	type ArchiveManifest,
	type BackupErrorCode,
	type BackupProgress,
} from "@cutlyra/editor-core/services/backup/types";
import { validateManifest } from "@cutlyra/editor-core/services/backup/archive-format";
import type { MediaAssetData } from "@cutlyra/editor-core/services/storage/types";

/** Informational only — stamped into the manifest so an archive can be traced
 *  to the build that produced it (format compatibility is governed by
 *  `formatVersion`, never by this). Keep in sync with package.json. */
const APP_VERSION = "0.1.0";

export interface BackupRunHandlers {
	/** Called for web-path progress (the native path resolves as one step). */
	onProgress?: (progress: BackupProgress) => void;
	/** Stage text for the native path ("Saving archive…"). */
	onStage?: (text: string) => void;
}

/** Filesystem-safe, human-readable archive file name. */
export function archiveFileName({ projectName, now = new Date() }: { projectName: string; now?: Date }): string {
	const slug =
		projectName
			.replace(/[\\/:*?"<>|]+/g, "-")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 60) || "project";
	const date = now.toISOString().slice(0, 10);
	return `${slug} backup ${date}.cutlyra-backup`;
}

/** Normalizes any bridge/backup failure into a BackupError the screen can
 *  render (code-aware). USER_CANCELLED flows through untouched. */
export function toBackupError(error: unknown): BackupError {
	if (error instanceof BackupError) return error;
	if (error instanceof NativeBridgeError) {
		const code: BackupErrorCode =
			error.code === "USER_CANCELLED" ||
			error.code === "CORRUPT_ARCHIVE" ||
			error.code === "INSUFFICIENT_STORAGE" ||
			error.code === "IO_ERROR" ||
			error.code === "UNSUPPORTED"
				? error.code
				: "IO_ERROR";
		return new BackupError({ code, message: error.message });
	}
	return new BackupError({
		code: "IO_ERROR",
		message: error instanceof Error ? error.message : String(error),
	});
}

// Note: there is deliberately no native-custody BackupIO stub here. On
// native platforms the BYTES never travel through JS at all (native builds
// the archive itself from a recipe), so a BackupContext is never constructed
// there — the native branch of runBackupProject/runRestoreProject above
// speaks to the bridge directly.

function makeWebIO(): BackupIO {
	return {
		async readMediaBytes({ projectId, assetId, role }) {
			const asset: MediaAssetData | null = (
				await storageService.listMediaAssetData({ projectId })
			).find((a) => a.id === assetId) ?? null;
			if (!asset) return null;
			// The web path only ever archives blob-backed OPFS files (there is
			// no native custody on web); thumbnails/sources mirror the proxy on
			// web-fallback imports where the proxy IS the source.
			const file = await new Promise<File | null>((resolve) => {
				void storageService
					.loadMediaAsset({ projectId, id: assetId })
					.then((a) => resolve(a?.file ?? null))
					.catch(() => resolve(null));
			});
			if (!file || file.size === 0) return null;
			if (role === "proxy") return new Uint8Array(await file.arrayBuffer());
			return null;
		},
	};
}

function webContext(handlers: BackupRunHandlers): BackupContext {
	return {
		storage: storageService,
		io: makeWebIO(),
		appVersion: APP_VERSION,
		onProgress: handlers.onProgress,
	};
}

/**
 * Exports one project as an archive. Native: SAF picker + native assembly.
 * Web: JS assembly + browser download. Resolves `{ saved: true }` on success;
 * throws `BackupError` (USER_CANCELLED when the picker was dismissed).
 */
/**
 * Injectable seams for [runBackupProject] (GitHub #37). Production callers
 * pass nothing: the real bridge is fetched and the real recipe builder runs.
 *
 * They exist so the SUCCESS path — which ownership evidence is forwarded to
 * `exportArchive` — is testable without `mock.module`. That matters because
 * bun's module doubles are process-global (CI runs every suite in one
 * process), and doubling `@cutlyra/editor-core/...` from a mobile test
 * silently breaks editor-core's own suites. Passing dependencies is
 * containment rather than contamination: nothing global changes.
 */
export interface BackupRunDeps {
	bridge?: Awaited<ReturnType<typeof getNativeBridge>>;
	buildRecipe?: typeof buildExportRecipe;
}

export async function runBackupProject({
	projectId,
	projectName,
	handlers = {},
	deps = {},
}: {
	projectId: string;
	projectName: string;
	handlers?: BackupRunHandlers;
	deps?: BackupRunDeps;
}): Promise<void> {
	const bridge = deps.bridge ?? (await getNativeBridge());

	if (bridge.platform === "web") {
		handlers.onStage?.("Building archive…");
		const result = await exportProjectArchive({
			projectId,
			ctx: webContext(handlers),
		});
		handlers.onStage?.("Saving file…");
		downloadBytes(result.archive, archiveFileName({ projectName }));
		return;
	}

	handlers.onStage?.("Choosing location…");
	const destination = await bridge.pickArchiveDestination({
		suggestedName: archiveFileName({ projectName }),
	});
	if (!destination) {
		throw new BackupError({ code: "USER_CANCELLED", message: "Backup cancelled" });
	}
	handlers.onStage?.("Saving archive…");

	// GitHub #37: the SAF document already EXISTS (created empty by the
	// picker) from the moment we hold its URI, so a failure before the native
	// write has to remove it again or the user is left with a 0-byte archive
	// sitting next to their real ones. Native owns cleanup for every failure
	// inside `exportArchive`; this catches the ones JS owns — building the
	// recipe — so the two paths never clean up the same file twice.
	let recipe: Awaited<ReturnType<typeof buildExportRecipe>>;
	try {
		recipe = await (deps.buildRecipe ?? buildExportRecipe)({ projectId, storage: storageService });
	} catch (error) {
		throw await discardUnwrittenDestination({ destination, error, bridge });
	}
	await bridge.exportArchive({
		destinationUri: destination.uri,
		sizeBytesAtPick: destination.sizeBytesAtPick,
		projectJson: recipe.projectJson,
		media: recipe.media.map((m) => ({
			assetId: m.assetId,
			proxyPath: m.proxyPath,
			sourcePath: m.sourcePath,
			thumbnailPath: m.thumbnailPath,
			name: m.name,
			type: m.type,
			sizeBytes: m.sizeBytes,
			lastModified: m.lastModified,
			width: m.width,
			height: m.height,
			duration: m.duration,
			fps: m.fps,
			hasAudio: m.hasAudio,
			sourceRotationDegrees: m.sourceRotationDegrees,
			sourceWidth: m.sourceWidth,
			sourceHeight: m.sourceHeight,
		})),
		appVersion: APP_VERSION,
	});
	handlers.onStage?.("Done");
}/**
 * GitHub #37 — what to say (and do) when a backup fails after the picker
 * already created its destination but before any bytes were written.
 *
 * Three cases, told apart by the size the provider reported at pick time:
 *
 *  - `0` (provably ours): ask native to delete it. Whether the delete lands is
 *    reported verbatim — "the file was removed" vs "the file is still there,
 *    delete it yourself" — never as a quiet success.
 *  - `> 0` (an existing file the user pointed at): we never opened it, so it
 *    is untouched and the original error stands alone.
 *  - unknown (`-1`): we cannot prove the file is ours, so nothing is deleted
 *    and the user is told an empty file may be left behind.
 *
 * A cleanup that itself throws still returns the ORIGINAL failure — cleanup
 * must never mask what went wrong, nor claim a clean result it didn't get.
 */
/** Resolved shape of the bridge instance (shared by the helpers below). */
type NativeBridge = Awaited<ReturnType<typeof getNativeBridge>>;
/** What `pickArchiveDestination` hands back when the user did not cancel. */
type ArchiveDestinationPick = NonNullable<Awaited<ReturnType<NativeBridge["pickArchiveDestination"]>>>;

export async function discardUnwrittenDestination({
	destination,
	error,
	bridge,
}: {
	destination: ArchiveDestinationPick;
	error: unknown;
	bridge: NativeBridge;
}): Promise<BackupError> {
	const cause = toBackupError(error);

	if (destination.sizeBytesAtPick > 0) {
		// An existing file we never wrote to: nothing was left behind.
		return cause;
	}

	if (destination.sizeBytesAtPick < 0) {
		return new BackupError({
			code: cause.code,
			message: `${cause.message} The storage location would not confirm whether it was a new empty file, so an empty file may remain there.`,
		});
	}

	try {
		const discard = await bridge.discardArchiveDestination({
			uri: destination.uri,
			sizeBytesAtPick: destination.sizeBytesAtPick,
		});
		return new BackupError({ code: cause.code, message: `${cause.message} ${discard.message}` });
	} catch {
		return new BackupError({
			code: cause.code,
			message: `${cause.message} The location could not be cleaned up, so an empty file may remain there.`,
		});
	}
}

/** Preview of what an archive contains (project name, created, counts) so
 * the restore screen can confirm before committing. */
export interface RestorePreview {
	projectName: string;
	createdAt: string;
	assetCount: number;
}

/**
 * Restores a project archive. Native: SAF picker → native verify/extract →
 * JS record commit (with duplicate-ID remap). Web: file input → full JS
 * verify + restore. Returns the restored project id + remap flag.
 */
export async function runRestoreProject({
	handlers = {},
	forceNewId = false,
}: {
	handlers?: BackupRunHandlers;
	forceNewId?: boolean;
}): Promise<RestoreResult> {
	const bridge = await getNativeBridge();

	if (bridge.platform === "web") {
		handlers.onStage?.("Choosing file…");
		const bytes = await pickArchiveBytes();
		if (!bytes) {
			throw new BackupError({ code: "USER_CANCELLED", message: "Restore cancelled" });
		}
		handlers.onStage?.("Verifying integrity…");
		await verifyArchiveIntegrity({ archive: bytes });
		handlers.onStage?.("Checking storage…");
		await ensureCapacityForArchive({ archive: bytes, ctx: webContext(handlers) });
		handlers.onStage?.("Restoring…");
		return await restoreProjectArchive({
			archive: bytes,
			ctx: webContext(handlers),
			forceNewId,
		});
	}

	handlers.onStage?.("Choosing archive…");
	const source = await bridge.pickArchiveSource();
	if (!source) {
		throw new BackupError({ code: "USER_CANCELLED", message: "Restore cancelled" });
	}
	handlers.onStage?.("Verifying and extracting…");
	const imported = await bridge.importArchive({ sourceUri: source.uri });

	// Defense in depth: native already verified every hash, but the manifest
	// crossing the bridge is still untrusted JSON — validate it structurally
	// (formatVersion, safe paths, sha256 shapes) before touching records.
	let manifest: ArchiveManifest;
	try {
		manifest = validateManifest(JSON.parse(imported.manifestJson));
	} catch (error) {
		if (error instanceof BackupError) throw error;
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "Imported manifest is malformed",
		});
	}
	const archived = manifest.projects[0];

	handlers.onStage?.("Restoring…");
	const result = await applyNativeImport({
		projectJson: imported.projectJson,
		archivedAssets: archived.assets,
		restoredFiles: imported.restoredFiles,
		storage: storageService,
		forceNewId,
	});
	handlers.onStage?.("Done");
	return result;
}

/** A human-readable message for any backup failure, keyed by code. */
export function describeBackupError(error: BackupError): string {
	switch (error.code) {
		case "USER_CANCELLED":
			return "Cancelled — nothing was changed.";
		case "CORRUPT_ARCHIVE":
			// Direction-neutral on purpose: this code also fires while BUILDING
			// an archive (a project whose JSON is unusable), not only on restore.
			return `This archive is damaged or incomplete and cannot be used. ${error.message}`;
		case "UNSUPPORTED_FORMAT":
			return `This archive was made by a newer version of Cutlyra and cannot be restored here. ${error.message}`;
		case "INSUFFICIENT_STORAGE":
			return `There is not enough free storage to restore this archive. ${error.message}`;
		case "IO_ERROR":
			return `The archive could not be read or written. ${error.message}`;
		case "PERMISSION_DENIED":
			return `Permission to read or write the archive was denied. ${error.message}`;
		case "UNSUPPORTED":
			return `This device's Cutlyra build does not support backups yet. ${error.message}`;
		default:
			return error.message;
	}
}

// ---------------------------------------------------------------------------
// Web-only primitives (browser download / file input)
// ---------------------------------------------------------------------------

function downloadBytes(bytes: Uint8Array, fileName: string): void {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const blob = new Blob([copy], { type: "application/octet-stream" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	// Revoke after the browser has had a chance to start the download.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function pickArchiveBytes(): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".cutlyra-backup,application/zip,application/octet-stream";
		input.style.display = "none";
		let settled = false;
		const finish = (value: Uint8Array | null) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(value);
		};
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return finish(null);
			void file.arrayBuffer().then((buffer) => finish(new Uint8Array(buffer)));
		};
		// A cancelled file dialog fires no event; window focus + grace period
		// is the portable cancel signal (same trick as the web-fallback
		// bridge's openFilePicker).
		window.addEventListener(
			"focus",
			() => setTimeout(() => finish(null), 300),
			{ once: true },
		);
		document.body.appendChild(input);
		input.click();
	});
}
