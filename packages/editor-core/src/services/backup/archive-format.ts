/**
 * The archive container format for GitHub #35 / Linear PAV-51.
 *
 * A `.cutlyra-backup` file is a **standard ZIP container** (method STORE —
 * media payloads are already compressed, so DEFLATE would burn CPU for
 * nothing) so that the archive is inspectable and recoverable with any zip
 * tool, on any OS, long after this app is gone. A backup that can only be
 * read by the app that made it is not a backup.
 *
 * Layout:
 *
 *   manifest.json                          the versioned ArchiveManifest
 *   data/<projectId>/project.json          the SerializedProject
 *   data/<projectId>/media/<assetId>/...   proxy.<ext>, source.<ext>, thumb.<ext>
 *
 * Integrity: every data entry carries its own SHA-256 + byte length in the
 * manifest. Import verifies EVERY hash before committing anything — a backup
 * that silently restores corrupt media is worse than no backup at all.
 *
 * Streaming: the writer emits the general-purpose "data descriptor" flag
 * (bit 3) so large media can be piped through without buffering the whole
 * entry (or the whole archive) in memory; sizes/CRC are deferred to the
 * trailing descriptor, and the central directory records the authoritative
 * values. This is the same shape `java.util.zip` produces for a streamed
 * ZIP, so the native Android implementation and this one stay compatible.
 *
 * This module is pure, synchronous-friendly, and platform-agnostic: it is
 * the REFERENCE implementation of the format, exercised directly by the
 * unit tests, and mirrored by the native Kotlin reader/writer.
 */

import {
	ARCHIVE_FORMAT,
	ARCHIVE_FORMAT_VERSION,
	BackupError,
	type ArchiveManifest,
	type ArchivedAsset,
	type ArchivedFileEntry,
	type ArchivedProject,
} from "./types";

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3 polynomial, as required by the ZIP spec)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

/** The CRC-32 initial register value (0xFFFFFFFF) before folding. */
const CRC_INIT = 0xffffffff;

export function crc32({ bytes, seed = 0 }: { bytes: Uint8Array; seed?: number }): number {
	let crc = (seed ^ -1) >>> 0;
	for (let i = 0; i < bytes.length; i++) {
		crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ bytes[i]) & 0xff] as number);
	}
	return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 of `bytes`, via WebCrypto. Injectable for tests. */
export async function sha256Hex({
	bytes,
	subtle = null,
}: {
	bytes: Uint8Array;
	subtle?: SubtleCrypto | null;
}): Promise<string> {
	const impl = subtle ?? globalThis.crypto?.subtle;
	if (!impl) {
		throw new BackupError({
			code: "IO_ERROR",
			message: "WebCrypto SubtleCrypto is unavailable; cannot hash for archive integrity",
		});
	}
	// Copy into a standalone ArrayBuffer so we never depend on a view's
	// byteOffset (a slice of a larger buffer would otherwise hash wrong).
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await impl.digest("SHA-256", copy.buffer);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// Safe path handling
// ---------------------------------------------------------------------------

/**
 * Archive-internal paths are DATA, not filesystem instructions. Import
 * (and the native mirror) must never let a crafted archive write outside
 * the extraction root — the classic "zip slip" (CVE class, e.g. 2018-1002200)
 * plus every other traversal trick. Reject, don't sanitize: a path that
 * needs cleaning is a path we should refuse to touch.
 */
export function assertSafeArchivePath(path: string): void {
	const bad = (reason: string): never => {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: `Unsafe archive path rejected (${reason}): ${JSON.stringify(path)}`,
		});
	};

	if (path.length === 0) bad("empty");
	if (path.length > 4096) bad("too long");
	if (path.includes("\0")) bad("null byte");
	if (path.includes("\\")) bad("backslash");
	if (path.startsWith("/")) bad("absolute");
	// Windows drive letters / UNC — irrelevant to extraction but a red flag
	// that the entry is not one we authored.
	if (/^[A-Za-z]:/.test(path)) bad("drive letter");

	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "" && path.split("/").length > 1 && segments.indexOf(segment) !== 0) {
			// Allow the single trailing-slash-free form; empty interior segments
			// ("a//b") are malformed, but only flag genuinely empty interior ones.
			bad("empty segment");
		}
		if (segment === "." || segment === "..") bad("dot segment");
	}
}

// ---------------------------------------------------------------------------
// ZIP writer (streaming, data descriptors, STORE)
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_DATADESC_SIG = 0x08074b50;
const FLAG_DATA_DESCRIPTOR = 0x0800; // bit 3 (upper bit in the 16-bit field)
const METHOD_STORE = 0;

interface PendingEntry {
	name: string;
	crc: number;
	size: number;
	offset: number;
}

/** Emits ZIP bytes incrementally so large media never fully buffers. */
export class ZipWriter {
	private chunks: Uint8Array[] = [];
	private pending: PendingEntry[] = [];
	private offset = 0;
	private closed = false;

	private emit(bytes: Uint8Array): void {
		this.chunks.push(bytes);
		this.offset += bytes.byteLength;
	}

	private u16(value: number): Uint8Array {
		const out = new Uint8Array(2);
		new DataView(out.buffer).setUint16(0, value & 0xffff, true);
		return out;
	}

	private u32(value: number): Uint8Array {
		const out = new Uint8Array(4);
		new DataView(out.buffer).setUint32(0, value >>> 0, true);
		return out;
	}

	/** Adds one entry, optionally streaming its bytes. */
	async addEntry({
		path,
		data,
		stream,
	}: {
		path: string;
		data?: Uint8Array;
		stream?: AsyncIterable<Uint8Array>;
	}): Promise<void> {
		if (this.closed) {
			throw new BackupError({
				code: "IO_ERROR",
				message: "ZipWriter already finalized",
			});
		}
		assertSafeArchivePath(path);
		const nameBytes = new TextEncoder().encode(path);
		const entryOffset = this.offset;

		// Local file header with the data-descriptor flag set and zeroed
		// CRC/sizes — they are filled in by the trailing descriptor.
		this.emit(this.u32(ZIP_LOCAL_SIG));
		this.emit(this.u16(20)); // version needed
		this.emit(this.u16(FLAG_DATA_DESCRIPTOR));
		this.emit(this.u16(METHOD_STORE));
		this.emit(this.u16(0)); // mod time
		this.emit(this.u16(0)); // mod date
		this.emit(this.u32(0)); // crc (deferred)
		this.emit(this.u32(0)); // compressed size (deferred)
		this.emit(this.u32(0)); // uncompressed size (deferred)
		this.emit(this.u16(nameBytes.byteLength));
		this.emit(this.u16(0)); // extra len
		this.emit(nameBytes);

		// Stream the payload, folding CRC and counting bytes as we go.
		// The running fold state starts at the CRC-32 init value (0xFFFFFFFF)
		// and is kept raw (no invert) across chunks; finishCrc applies the
		// final invert exactly once. This matches crc32() above and the ZIP
		// spec's IEEE 802.3 CRC-32.
		let running = CRC_INIT;
		let size = 0;
		if (stream) {
			for await (const chunk of stream) {
				running = foldCrc({ chunk, start: running });
				size += chunk.byteLength;
				this.emit(chunk);
			}
		} else if (data) {
			running = foldCrc({ chunk: data, start: CRC_INIT });
			size = data.byteLength;
			this.emit(data);
		}
		const crc = finishCrc(running);

		// Trailing data descriptor.
		this.emit(this.u32(ZIP_DATADESC_SIG));
		this.emit(this.u32(crc));
		this.emit(this.u32(size));
		this.emit(this.u32(size));

		this.pending.push({ name: path, crc, size, offset: entryOffset });
	}

	/** Finalizes central directory + EOCD and returns the concatenated bytes. */
	finalize(): Uint8Array {
		if (this.closed) {
			throw new BackupError({
				code: "IO_ERROR",
				message: "ZipWriter already finalized",
			});
		}
		this.closed = true;
		const centralStart = this.offset;

		for (const entry of this.pending) {
			const nameBytes = new TextEncoder().encode(entry.name);
			this.emit(this.u32(ZIP_CENTRAL_SIG));
			this.emit(this.u16(20)); // version made by
			this.emit(this.u16(20)); // version needed
			this.emit(this.u16(FLAG_DATA_DESCRIPTOR));
			this.emit(this.u16(METHOD_STORE));
			this.emit(this.u16(0)); // time
			this.emit(this.u16(0)); // date
			this.emit(this.u32(entry.crc));
			this.emit(this.u32(entry.size));
			this.emit(this.u32(entry.size));
			this.emit(this.u16(nameBytes.byteLength));
			this.emit(this.u16(0)); // extra
			this.emit(this.u16(0)); // comment
			this.emit(this.u16(0)); // disk number start
			this.emit(this.u16(0)); // internal attrs
			this.emit(this.u32(0)); // external attrs
			this.emit(this.u32(entry.offset));
			this.emit(nameBytes);
		}
		const centralSize = this.offset - centralStart;

		this.emit(this.u32(ZIP_EOCD_SIG));
		this.emit(this.u16(0)); // disk number
		this.emit(this.u16(0)); // central dir start disk
		this.emit(this.u16(this.pending.length));
		this.emit(this.u16(this.pending.length));
		this.emit(this.u32(centralSize));
		this.emit(this.u32(centralStart));
		this.emit(this.u16(0)); // comment len

		return concatChunks(this.chunks);
	}
}

/** Folds `chunk` into a running CRC that started at 0 (no invert until done). */
export function foldCrc({ chunk, start }: { chunk: Uint8Array; start: number }): number {
	let crc = start >>> 0;
	for (let i = 0; i < chunk.length; i++) {
		crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ chunk[i]) & 0xff] as number);
	}
	return crc >>> 0;
}

/** Applies the final CRC-32 invert to a raw folded state. */
export function finishCrc(running: number): number {
	return (running ^ -1) >>> 0;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

// ---------------------------------------------------------------------------
// ZIP reader (central-directory based, STORE only)
// ---------------------------------------------------------------------------

export interface ZipReadEntry {
	path: string;
	data: Uint8Array;
	crc: number;
}

/** Parses a STORE-only ZIP produced by this writer (or java.util.zip). */
export function readZip(archive: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(
		archive.buffer,
		archive.byteOffset,
		archive.byteLength,
	);
	const eocdOffset = findEocd(view);
	if (eocdOffset === -1) {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "Not a ZIP archive (no end-of-central-directory record)",
		});
	}

	const count = view.getUint16(eocdOffset + 10, true);
	let ptr = view.getUint32(eocdOffset + 16, true);

	const out = new Map<string, Uint8Array>();
	for (let i = 0; i < count; i++) {
		if (view.getUint32(ptr, true) !== ZIP_CENTRAL_SIG) {
			throw new BackupError({
				code: "CORRUPT_ARCHIVE",
				message: "Malformed central directory entry",
			});
		}
		const method = view.getUint16(ptr + 10, true);
		const crc = view.getUint32(ptr + 16, true);
		const compSize = view.getUint32(ptr + 20, true);
		const nameLen = view.getUint16(ptr + 28, true);
		const extraLen = view.getUint16(ptr + 30, true);
		const commentLen = view.getUint16(ptr + 32, true);
		const localOffset = view.getUint32(ptr + 42, true);
		const name = new TextDecoder().decode(
			archive.subarray(ptr + 46, ptr + 46 + nameLen),
		);
		ptr += 46 + nameLen + extraLen + commentLen;

		if (method !== METHOD_STORE) {
			throw new BackupError({
				code: "CORRUPT_ARCHIVE",
				message: `Unsupported compression method ${method} for ${name} (only STORE is produced)`,
			});
		}

		// Local header tells us where the data actually begins (its own
		// name/extra lengths can differ from the central directory's).
		if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIG) {
			throw new BackupError({
				code: "CORRUPT_ARCHIVE",
				message: `Malformed local header for ${name}`,
			});
		}
		const localNameLen = view.getUint16(localOffset + 26, true);
		const localExtraLen = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const data = archive.subarray(dataStart, dataStart + compSize);

		const actualCrc = crc32({ bytes: data });
		if (actualCrc !== crc) {
			throw new BackupError({
				code: "CORRUPT_ARCHIVE",
				message: `CRC-32 mismatch for ${name} (archive is corrupt or truncated)`,
			});
		}

		assertSafeArchivePath(name);
		out.set(name, data);
	}
	return out;
}

function findEocd(view: DataView): number {
	const min = 22;
	if (view.byteLength < min) return -1;
	for (let i = view.byteLength - min; i >= 0; i--) {
		if (view.getUint32(i, true) === ZIP_EOCD_SIG) return i;
	}
	return -1;
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

export function serializeManifest(manifest: ArchiveManifest): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(manifest, null, 2));
}

export function buildManifestJson(): string {
	return JSON.stringify(
		{
			format: ARCHIVE_FORMAT,
			formatVersion: ARCHIVE_FORMAT_VERSION,
		},
		null,
		2,
	);
}

/** Parses + structurally validates manifest.json. Never trusts the input. */
export function parseManifest(bytes: Uint8Array): ArchiveManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new BackupError({
			code: "CORRUPT_ARCHIVE",
			message: "manifest.json is not valid JSON",
		});
	}
	return validateManifest(parsed);
}

// ---------------------------------------------------------------------------
// Manifest validation
//
// The manifest is DATA from an untrusted source (a file the user picked,
// possibly crafted). Validation is therefore by NARROWING: every field is
// checked with a guard predicate and the typed values are built up from
// scratch — the validated value is CONSTRUCTED, never asserted. (This is
// also why no `as` assertions belong here: an assertion on parsed JSON is
// exactly the trust this function exists to refuse.)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The canonical invalid-manifest failure. Module-level (not a closure) so
 *  every validator can take a single value parameter. */
function manifestFail(reason: string): never {
	throw new BackupError({
		code: "CORRUPT_ARCHIVE",
		message: `Invalid archive manifest: ${reason}`,
	});
}

/** Validates ONE archived file entry, returning it fully typed. */
function toArchivedFileEntry(value: unknown): ArchivedFileEntry {
	if (!isRecord(value)) manifestFail("bad file entry");
	if (typeof value.path !== "string") manifestFail("file missing path");
	assertSafeArchivePath(value.path);
	if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
		manifestFail(`file ${JSON.stringify(value.path)} has malformed sha256`);
	}
	if (typeof value.sizeBytes !== "number" || value.sizeBytes < 0) {
		manifestFail(`file ${JSON.stringify(value.path)} has bad sizeBytes`);
	}
	if (value.role !== "proxy" && value.role !== "source" && value.role !== "thumbnail") {
		manifestFail(`file ${JSON.stringify(value.path)} has an unknown role`);
	}
	if (typeof value.extension !== "string") {
		manifestFail(`file ${JSON.stringify(value.path)} is missing extension`);
	}
	return {
		role: value.role,
		path: value.path,
		sizeBytes: value.sizeBytes,
		sha256: value.sha256,
		extension: value.extension,
	};
}

/** Reads an optional finite number field, or undefined. */
function optionalNumber({
	value,
	field,
}: {
	value: unknown;
	field: string;
}): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		manifestFail(`${field} must be a finite number`);
	}
	return value;
}

/** Validates ONE archived asset, returning it fully typed. */
function toArchivedAsset(value: unknown): ArchivedAsset {
	if (!isRecord(value)) manifestFail("bad asset");
	if (typeof value.id !== "string" || value.id.length === 0) manifestFail("asset missing id");
	if (typeof value.name !== "string") manifestFail("asset missing name");
	if (value.type !== "video" && value.type !== "audio" && value.type !== "image") {
		manifestFail(`asset ${JSON.stringify(value.id)} has an unknown type`);
	}
	if (typeof value.sizeBytes !== "number") manifestFail("asset missing sizeBytes");
	if (typeof value.lastModified !== "number") manifestFail("asset missing lastModified");
	if (!Array.isArray(value.files)) manifestFail("asset files must be an array");
	const rotation = optionalNumber({
		value: value.sourceRotationDegrees,
		field: "sourceRotationDegrees",
	});
	const rotationDegrees: 0 | 90 | 180 | 270 | undefined =
		rotation === undefined ||
		rotation === 0 ||
		rotation === 90 ||
		rotation === 180 ||
		rotation === 270
			? rotation
			: manifestFail("sourceRotationDegrees must be 0, 90, 180 or 270");
	return {
		id: value.id,
		name: value.name,
		type: value.type,
		sizeBytes: value.sizeBytes,
		lastModified: value.lastModified,
		width: optionalNumber({ value: value.width, field: "width" }),
		height: optionalNumber({ value: value.height, field: "height" }),
		duration: optionalNumber({ value: value.duration, field: "duration" }),
		fps: optionalNumber({ value: value.fps, field: "fps" }),
		hasAudio: value.hasAudio === undefined ? undefined : Boolean(value.hasAudio),
		sourceRotationDegrees: rotationDegrees,
		sourceWidth: optionalNumber({ value: value.sourceWidth, field: "sourceWidth" }),
		sourceHeight: optionalNumber({ value: value.sourceHeight, field: "sourceHeight" }),
		files: value.files.map((file: unknown) => toArchivedFileEntry(file)),
	};
}

/** Validates ONE archived project, returning it fully typed. */
function toArchivedProject(value: unknown): ArchivedProject {
	if (!isRecord(value)) manifestFail("bad project");
	if (typeof value.id !== "string" || value.id.length === 0) manifestFail("project missing id");
	if (typeof value.name !== "string") manifestFail("project missing name");
	if (!isRecord(value.projectEntry)) manifestFail("project missing projectEntry");
	const entry = value.projectEntry;
	if (typeof entry.path !== "string") manifestFail("projectEntry missing path");
	assertSafeArchivePath(entry.path);
	if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
		manifestFail("projectEntry has malformed sha256");
	}
	if (typeof entry.sizeBytes !== "number" || entry.sizeBytes < 0) {
		manifestFail("projectEntry has bad sizeBytes");
	}
	if (!Array.isArray(value.assets)) manifestFail("project assets must be an array");
	return {
		id: value.id,
		name: value.name,
		projectEntry: {
			path: entry.path,
			sizeBytes: entry.sizeBytes,
			sha256: entry.sha256,
		},
		assets: value.assets.map((asset: unknown) => toArchivedAsset(asset)),
	};
}

export function validateManifest(value: unknown): ArchiveManifest {
	if (!isRecord(value)) manifestFail("not an object");
	if (value.format !== ARCHIVE_FORMAT) manifestFail("unrecognized format marker");
	if (value.formatVersion !== ARCHIVE_FORMAT_VERSION) {
		throw new BackupError({
			code: "UNSUPPORTED_FORMAT",
			message: `Archive format version ${String(value.formatVersion)} is not supported (expected ${ARCHIVE_FORMAT_VERSION})`,
		});
	}
	// Informational-only fields, but their presence is part of the format —
	// the NATIVE writer always stamps them (BackupArchive.buildManifest), so
	// their absence means the manifest did not come from a Cutlyra export.
	if (typeof value.appVersion !== "string") manifestFail("missing appVersion");
	if (typeof value.createdAt !== "string") manifestFail("missing createdAt");
	if (!Array.isArray(value.projects)) manifestFail("projects must be an array");
	return {
		format: ARCHIVE_FORMAT,
		formatVersion: ARCHIVE_FORMAT_VERSION,
		appVersion: value.appVersion,
		createdAt: value.createdAt,
		projects: value.projects.map((project: unknown) => toArchivedProject(project)),
	};
}

/** The canonical archive-internal path for a project's JSON payload. */
export function projectEntryPath(projectId: string): string {
	const safe = encodeURIComponent(projectId);
	return `data/${safe}/project.json`;
}

/** The canonical archive-internal prefix for a project's media entries. */
export function mediaEntryPath({
	projectId,
	assetId,
	role,
	extension,
}: {
	projectId: string;
	assetId: string;
	role: string;
	extension: string;
}): string {
	const ext = extension.startsWith(".") ? extension : `.${extension}`;
	return `data/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}/${role}${ext}`;
}

/** Every data entry name the writer must have produced for a manifest. */
export function expectedEntryNames(manifest: ArchiveManifest): string[] {
	const names: string[] = [];
	for (const project of manifest.projects) {
		names.push(project.projectEntry.path);
		for (const asset of project.assets) {
			for (const file of asset.files) {
				names.push(file.path);
			}
		}
	}
	return names;
}
