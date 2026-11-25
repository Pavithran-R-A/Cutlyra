/**
 * NativeBridge — the shared vocabulary. Plan §2.4 / M3.
 *
 * "Nothing crosses the JS↔native bridge except JSON control messages,
 * progress events, and URLs. No video bytes on the bridge — ever." (plan
 * §2.2). Every type below is a plain, JSON-serializable value for exactly
 * that reason — nothing here is a File, Blob, ArrayBuffer, or object URL.
 *
 * A DELIBERATE BOUNDARY, not an oversight: this file does NOT use editor-core
 * ticks (`meta.ticksPerSecond`, 120000-today). Ticks are an
 * `@cutlyra/editor-core` / EDL-v1 concept — see docs/EDL.md §6, "durationTicks
 * on an asset is the one place the seconds→ticks boundary is crossed ... goes
 * through the WASM helper, never a bare multiply." A native media probe
 * (`AVAsset`, `MediaMetadataRetriever`) has no idea what an editor tick is and
 * must not invent one. So a probed `MediaHandle` reports `durationMicros` —
 * an INTEGER, never a float, in an unambiguous native-precision unit — and
 * editor-core is the only place that turns it into `durationTicks` via the
 * WASM helper. `exportProject`, by contrast, takes a fully-built `Edl`
 * (imported from `@cutlyra/editor-core/edl`), which by then IS all ticks and
 * rationals — see plan §2.2's "Time values crossing the EDL bridge are
 * integer ticks + rational frame rates, never float seconds."
 */

import type { Edl, EdlRational } from "@cutlyra/editor-core/edl";

export type Platform = "ios" | "android" | "web";

/** One prerendered overlay image and the output span it covers. */
export interface ExportOverlayFrame {
	startTicks: number;
	endTicks: number;
	/** Base64 PNG (no `data:` prefix) at the export resolution. */
	pngBase64: string;
}

export type MediaKind = "video" | "audio" | "image";

/**
 * Per-item progress of the POST-pick load/copy step. On iOS this step can
 * be an iCloud original DOWNLOAD (minutes for a large video) — without
 * these events the UI froze at 0% and read as stuck; and a per-item
 * failure (e.g. iCloud + no network) was silently dropped, making an
 * all-failed batch indistinguishable from a user cancel (founder's
 * iPhone, 2026-08-19). "error" items are NOT in the resolved handle list.
 */
export interface PickProgress {
	index: number;
	total: number;
	stage: "loading" | "loaded" | "error";
	/** 0..1 within the item; iOS reports real download fractions, Android
	 *  emits stage markers (0 then 1). */
	fraction: number;
	error?: string;
}

/** One audible clip in the native preview-audio schedule. `path` is a RAW
 *  native filesystem path (the bridge reverses its own playback-URL
 *  conversion), seconds are plain doubles — this schedule never crosses the
 *  EDL tick boundary. */
export interface NativeAudioClip {
	path: string;
	startSec: number;
	durationSec: number;
	sourceOffsetSec: number;
	volume: number;
	rate: number;
}

export interface PickMediaOptions {
	kinds: MediaKind[];
	allowMultiple: boolean;
	/** Honor `capture="camera"` — plan M4 item 3: not honored by Android
	 * WebView by default, so the host must build the camera Intent itself. */
	source?: "library" | "camera";
	/** Fires during the post-pick load/copy of each selected item. */
	onProgress?: (progress: PickProgress) => void;
}

/**
 * What native custody hands back after an import. `uri` is a native handle
 * (an app-sandbox path or a persisted `content://`/`ph://`-style URI) — NEVER
 * a `blob:` URL, which `validateEdl({strict:true})` rejects outright because
 * it is meaningless outside the WebView (docs/EDL.md §6).
 */
export interface MediaHandle {
	id: string;
	uri: string;
	kind: MediaKind;
	fileName: string;
	sizeBytes: number;
	/** Integer microseconds. Never a float-seconds duration. */
	durationMicros: number;
	width: number;
	height: number;
	rotationDegrees: 0 | 90 | 180 | 270;
	hasAudio: boolean;
	codec: string;
	frameRate: EdlRational | null;
}

export interface ProxySpec {
	/** Target short edge, px. Plan Amendment 4 default: 540 (phone preview). */
	targetHeight: number;
	/** Short-GOP / near-all-intra structure for scrub-friendly random access. */
	shortGop: boolean;
}

export type ProxyStage = "queued" | "transcoding" | "done" | "error";

export interface ProxyProgress {
	assetId: string;
	stage: ProxyStage;
	/** 0..1. Always 1 when stage is "done" or "error". */
	fraction: number;
	/** Present only when stage is "done". Never a blob: URL — see MediaHandle. */
	proxyUri?: string;
	/** Present only when stage is "done" — the proxy's OWN dimensions after
	 * the native downscale (plan Amendment 4), which the webview's
	 * `VideoCache` needs to know to composite against the right size. */
	proxyWidth?: number;
	proxyHeight?: number;
	/** M4 item 5, "Thumbnail strip generation natively... served from the
	 * local server — do NOT decode filmstrip frames in JS." Native file
	 * paths (host converts via `Capacitor.convertFileSrc` before handing
	 * them to the webview, same as `proxyUri` — see
	 * `capacitor-bridge.ts`'s `toWebviewUri`), present only when stage is
	 * "done". Additive to the plan §2.4 sketch of this type; M3 landed
	 * `ProxyProgress` before M4 had a thumbnail-strip design to fold in. */
	thumbnailUris?: string[];
	error?: string;
}

export type ExportStage =
	| "preparing"
	| "encoding"
	| "muxing"
	| "done"
	| "error";

export interface ExportProgress {
	stage: ExportStage;
	fraction: number;
	outputUri?: string;
	error?: string;
}

/**
 * Plan M4 item 5: "Thumbnail strip generation natively ... do NOT decode
 * filmstrip frames in JS." Added in M4 — not part of M3's original
 * four-bridge sketch (plan §2.4), because M3 only knew about the four
 * bridges named in the brief. The filmstrip is genuinely a fifth native
 * capability, not an extension of `generateProxy`: a proxy is consumed by
 * `<video>`/`CanvasSink` during scrub/playback, while a thumbnail strip is
 * consumed by M7's timeline as static `<img>`-equivalent sources at
 * zoom-dependent density — two different consumers of two different native
 * outputs, both derived from the same source asset.
 */
export interface ThumbnailStripSpec {
	/** How many frames to extract, evenly spaced across the clip. */
	count: number;
	/** Max long edge of each thumbnail, px — a filmstrip thumbnail, not a
	 * full frame (plan M4 item 5). */
	maxEdgePx: number;
}

export interface ThumbnailStrip {
	assetId: string;
	/** Ordered, same length as `timestampsMicros`. Native handles — never
	 * `blob:` URLs, same discipline as `MediaHandle.uri`/`ProxyProgress
	 * .proxyUri`. */
	uris: string[];
	/** Integer microseconds, source-relative — same unit discipline as
	 * `MediaHandle.durationMicros`. */
	timestampsMicros: number[];
}

export interface TranscribeOptions {
	modelSize: "tiny" | "base";
	languageHint?: string;
}

/**
 * One word-level caption unit within a `TranscriptSegment`, added in plan
 * M10 (corpus `12`). Already run through the mandatory smoothing pass
 * (`caption-smoothing.ts`) by the time it reaches this type — nothing
 * downstream of `NativeBridge.transcribe()` ever sees raw, unsmoothed
 * whisper.cpp DTW output. Trailing punctuation is glued onto the word that
 * precedes it (see `caption-smoothing.ts`'s "snap punctuation to the
 * preceding word's end" rule) rather than appearing as its own entry.
 */
export interface TranscriptWord {
	/** May include a leading/trailing punctuation mark merged in during
	 * smoothing (e.g. "Americans," or "country."), but never a bare
	 * punctuation-only string on its own. */
	text: string;
	/** Integer microseconds, source-relative — same unit discipline as
	 * MediaHandle. Caller (editor-core) converts to ticks. */
	startMicros: number;
	endMicros: number;
	confidence: number | null;
}

export interface TranscriptSegment {
	/** Integer microseconds, source-relative — same unit discipline as
	 * MediaHandle. Caller (editor-core) converts to ticks. */
	startMicros: number;
	endMicros: number;
	text: string;
	confidence: number | null;
	/** Word-level timestamps for this segment (plan M10: "audio file in ->
	 * segments with word-level timestamps out"). Always present and always
	 * smoothed — see `TranscriptWord`'s own doc comment. Empty only if the
	 * native side genuinely produced zero decodable words for this segment
	 * span (e.g. a non-speech segment), never as a "not implemented" signal
	 * — that case throws `NativeBridgeError` from `transcribe()` itself. */
	words: TranscriptWord[];
}

export interface DeviceCapabilities {
	platform: Platform;
	osVersion: string;
	deviceModel: string;
	gpuBackend: "webgpu" | "webgl2" | "unknown";
	ramTierMb: number | null;
	codecs: { decode: string[]; encode: string[] };
	supportsNativeExport: boolean;
	supportsOnDeviceStt: boolean;
}

// ---------------------------------------------------------------------------
// Project backup archives (GitHub #35 / Linear PAV-51)
//
// On native platforms the archive's media BYTES live in native custody and
// must never cross the bridge (plan §2.2). So the wire contract here is
// entirely JSON: JS hands native a RECIPE (the SerializedProject JSON + a
// descriptor per media file with its custody-relative path), native streams
// the real bytes into a ZIP at a SAF destination while hashing them, and
// returns the authoritative manifest. Restore is the mirror. Every shape
// below is plain JSON for exactly the reason `MediaHandle` is.
// ---------------------------------------------------------------------------

/** Descriptor for one media file in the export recipe. `*Path` values are
 *  custody-ROOT-relative (e.g. `Media/<id>.mp4`), resolved by native against
 *  `getMediaRoot()`. Null when that role does not exist for the asset. */
export interface BackupMediaDescriptor {
	assetId: string;
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
	/** Animated-GIF timing. Frame FILES travel separately in `gifFrames`, so
	 *  the manifest never records the exporting device's custody paths. */
	gif?: {
		width: number;
		height: number;
		loopCount: number;
		frameDelaysMs: number[];
	};
	/** Custody-relative PNG paths of every decoded GIF frame, in frame order. */
	gifFrames?: string[];
	/** Freeze Frame provenance for a still generated by the Freeze action. */
	freezeFrame?: {
		sourceElementId: string;
		sourceMediaId: string;
		sourceTimestampMicros: number;
		holdDurationMicros: number;
		width: number;
		height: number;
		capturedAt: string;
	};
}

/**
 * One extracted Freeze Frame still, written into media custody by native.
 *
 * `relativePath` is custody-ROOT-relative (the durable identity across iOS
 * container rotations); `uri` is the converted playback URL for immediate
 * display. Both point at a real PNG on disk, so the still is an ordinary
 * media asset from here on: it persists, backs up, and exports like any other
 * image instead of being a transient bitmap.
 */
export interface FreezeFrameCapture {
	captured: true;
	relativePath: string;
	uri: string;
	width: number;
	height: number;
	/** The source instant the frame was extracted at (echoed for provenance). */
	timestampMicros: number;
}

/**
 * One generated reversed file. `uri` is a playback URI for the WebView;
 * `relativePath` is the durable custody-relative identity the media asset row
 * stores. `hasAudio` is false by construction — see `reverseVideo`.
 */
export interface ReverseVideoResult {
	assetId: string;
	relativePath: string;
	uri: string;
	width: number;
	height: number;
	/** Length of the generated file: exactly the clip's source span. */
	durationMs: number;
	frameCount: number;
	hasAudio: false;
	startMs: number;
	endMs: number;
}

/** One media file as native restored it into custody under a FRESH path. */
export interface RestoredMediaFile {
	assetId: string;
	role: "proxy" | "source" | "thumbnail" | "gif";
	newPath: string;
	sha256: string;
	/** `gif` role only: the frame's index in the archived frame order. */
	frameIndex?: number;
}

export const NATIVE_BRIDGE_ERROR_CODES = [
	"NOT_IMPLEMENTED",
	"PERMISSION_DENIED",
	"USER_CANCELLED",
	"UNSUPPORTED",
	"IO_ERROR",
	// Backup-archive integrity/ capacity failures (GitHub #35). A corrupt or
	// tampered archive, and a restore that cannot fit, are meaningfully
	// different from a generic I/O error and the UI must say so plainly.
	"CORRUPT_ARCHIVE",
	"INSUFFICIENT_STORAGE",
] as const;
export type NativeBridgeErrorCode = (typeof NATIVE_BRIDGE_ERROR_CODES)[number];

export class NativeBridgeError extends Error {
	readonly code: NativeBridgeErrorCode;
	constructor({
		code,
		message,
	}: {
		code: NativeBridgeErrorCode;
		message: string;
	}) {
		super(message);
		this.name = "NativeBridgeError";
		this.code = code;
	}
}

/**
 * The one interface every editor UI file is allowed to touch (plan §2.4).
 * `packages/native-bridge/src/index.ts` and its two implementations are the
 * ONLY files that may import `@capacitor/*` or `@tauri-apps/*` — enforced by
 * `scripts/invariants.sh`'s bridge-import gate and the
 * `no-restricted-imports` ESLint rule.
 *
 * Deliberate deviation from plan §2.4's illustrative sketch
 * (`generateProxy(handle, spec)`, `transcribe(handle, opts)`): this repo
 * enforces single-destructured-object-parameter style everywhere else
 * (`eslint/rules/prefer-object-params.mjs`, already how `buildEdl`/
 * `validateEdl` are shaped) — the sketch was illustrative, not frozen the way
 * EDL v1 is, so multi-param methods here are reshaped to match. Behavior is
 * unchanged.
 */
/** One decoded GIF frame, written into media custody by the native importer. */
export interface GifAssetFrame {
	/** Custody-root-relative PNG path. */
	relativePath: string;
	/** This frame's delay in milliseconds (already normalized). */
	delayMs: number;
}

/**
 * Result of decoding an animated GIF natively. Mirrors the shared JS decoder's
 * output (`GifAssetMetadata` + frame files) so the native and web import paths
 * produce the same project model: dimensions, normalized per-frame delays and
 * the Netscape loop count.
 */
export interface GifAssetDecodeResult {
	width: number;
	height: number;
	/** 0 = loop forever. */
	loopCount: number;
	totalDurationMs: number;
	frames: GifAssetFrame[];
}

/**
 * Result of the export preflight for one GIF asset: the decoder re-opened
 * every frame the EDL is about to reference and confirmed it yields real
 * pixels of a consistent size, so the exporter cannot fail halfway through on
 * a corrupt frame. `ready` is always true on resolve — failures reject with a
 * typed code instead of resolving `ready: false`.
 */
export interface GifExportPreflight {
	assetId: string;
	ready: true;
	frameCount: number;
	width: number;
	height: number;
	totalDurationMs: number;
}

export interface NativeBridge {
	readonly platform: Platform;
	/** Subscribe to Android hardware Back; returning false delegates to native exit. */
	onBackButton(params: { onBack: () => boolean }): Promise<{ remove: () => Promise<void> }>;
	/**
	 * Converts a `MediaHandle.uri` / `ProxyProgress.proxyUri` /
	 * `ProxyProgress.thumbnailUris[n]` (a native handle — an app-sandbox
	 * path on Capacitor, already webview-loadable on the web fallback) into
	 * a URL this platform's webview can actually load as `<video
	 * src>`/`fetch()`.
	 *
	 * Cutlyra M4 addition — not in the plan §2.4 sketch, which predates
	 * `pickMedia`/`generateProxy` having real implementations to reconcile
	 * against `EdlAssetResolution.sourceUri`'s "must be a real native
	 * handle, not a `blob:` URL" requirement (docs/EDL.md §6). Kept as an
	 * explicit bridge method — not folded into the handle itself — so
	 * `MediaHandle.uri` stays the SAME value on both sides of a
	 * `generateProxy({handle, ...})` call (native handed it out, native
	 * takes it back in); only the host layer building a `MediaAsset.url`
	 * for the webview needs the converted form.
	 */
	toPlaybackUri(nativeUri: string): string;
	/**
	 * The media-custody root directory (the parent of the native
	 * Media/Proxies/Thumbnails dirs), or null when the platform has no
	 * stable native filesystem (web fallback) or the running native build
	 * predates the method. Exists so the engine can persist
	 * container-RELATIVE media paths: iOS rotates the app data-container
	 * UUID on every app update/reinstall, so persisted ABSOLUTE paths die
	 * with the next install (found live 2026-08-19 — every saved project's
	 * playback broke after an Xcode reinstall).
	 */
	getMediaRoot(): Promise<string | null>;
	/**
	 * Decode an imported animated GIF into per-frame PNGs in media custody and
	 * return its timing metadata. Native-custody assets have no JS-readable
	 * bytes, so the shared decoder cannot run for them; absent on platforms/
	 * builds without the method (callers must treat that as unsupported rather
	 * than importing an animated GIF as a still).
	 */
	decodeGifAsset?(params: {
		uri: string;
		assetId: string;
	}): Promise<GifAssetDecodeResult | null>;
	/**
	 * Proves a GIF asset's decoded frame files are exportable BEFORE the native
	 * encoder starts: each frame is decoded and dimension-checked. Rejects with
	 * a `NativeBridgeError` carrying the native code (`GIF_FRAMES_MISSING`,
	 * `GIF_FRAME_UNREADABLE`, `GIF_FRAME_DIMENSION_MISMATCH`) and the offending
	 * path, so the export sheet shows the real reason instead of a generic
	 * Media3 failure. Absent on platforms/builds without it (the caller then
	 * lets the exporter report the failure itself).
	 */
	prepareGifExport?(params: {
		assetId: string;
		frames: { relativePath: string; delayMs: number }[];
	}): Promise<GifExportPreflight | null>;
	/**
	 * Persist a JS-generated audio clip (a bundled library sound) into the
	 * media custody root so it becomes a real, durable asset the native
	 * exporter can read. Returns the custody-ROOT-relative path of the
	 * written file, or null when this platform has no editable media
	 * custody (the web fallback — bundled sounds then stay preview-only,
	 * exactly as before).
	 *
	 * `base64` is the raw WAV bytes (no `data:` prefix). `assetId` is the
	 * caller's stable id for the sound — writing the same id again overwrites
	 * the same path with the same bytes, so retries and repeat inserts are
	 * idempotent.
	 */
	saveGeneratedAudio(params: {
		assetId: string;
		base64: string;
	}): Promise<{ relativePath: string } | null>;
	/** Dogfood audio bisector: a native-rendered 440Hz tone, NO webview
	 *  involved (2026-08-19 device-silence campaign). Resolves false when
	 *  the platform can't play one (web fallback / old native build). */
	playTestTone(): Promise<boolean>;
	/**
	 * Native preview-audio router (2026-08-20): the iOS device bisect proved
	 * WKWebView renders WebAudio silently while native audio works, so the
	 * engine hands its audible-clip schedule here and iOS mixes it natively
	 * (NativeAudioPreview.swift). `audioStart` rebuilds the whole schedule
	 * (also used for seeks); rejects/false on platforms without it
	 * (web, Android for now) — callers keep their WebAudio path there.
	 */
	audioStart(params: {
		clips: NativeAudioClip[];
		atSec: number;
	}): Promise<boolean>;
	audioStop(): Promise<void>;
	/** Measured RMS of the native mix output (autotest signal assertion). */
	audioLevel(): Promise<number>;
	pickMedia(opts: PickMediaOptions): Promise<MediaHandle[]>;
	// `AsyncGenerator`, not the plan sketch's `AsyncIterable`: every
	// implementation IS an async generator function, and callers (including
	// this package's own tests) need `.next()` on the returned object, which
	// `AsyncIterable` alone doesn't type.
	generateProxy(params: {
		handle: MediaHandle;
		spec: ProxySpec;
	}): AsyncGenerator<ProxyProgress>;
	exportProject(params: {
		edl: Edl;
		/** Text/caption overlays PRERENDERED by the preview's own drawing
		 *  code (`editor-core/export/overlay-frames.ts`), as full-frame
		 *  transparent PNGs with the time range each covers. When present
		 *  the native exporter composites these instead of re-rasterizing
		 *  text and captions itself — one implementation, so preview and
		 *  export cannot drift. Omitted (older callers, the standalone
		 *  verify harness) → the native CoreText path still applies. */
		overlayFrames?: ExportOverlayFrame[];
	}): AsyncGenerator<ExportProgress>;
	transcribe(params: {
		handle: MediaHandle;
		opts: TranscribeOptions;
	}): AsyncGenerator<TranscriptSegment>;
	/** M4 addition (see `ThumbnailStripSpec`'s doc comment) — a single
	 * resolve-when-done call, not a progress generator like `generateProxy`:
	 * a handful of JPEGs is fast enough that streaming progress isn't worth
	 * the complexity. */
	generateThumbnails(params: {
		handle: MediaHandle;
		spec: ThumbnailStripSpec;
	}): Promise<ThumbnailStrip>;
	capabilities(): Promise<DeviceCapabilities>;

	// -- Project backup (GitHub #35) ------------------------------------
	/**
	 * Launches a SAF `ACTION_CREATE_DOCUMENT` picker for a NEW archive at
	 * `suggestedName`. Resolves with a `content://` destination URI the
	 * caller passes to `exportArchive`, or null when the user cancelled.
	 * On web this is a no-op returning null (the JS path triggers a download
	 * directly — see `createWebFallbackBridge`).
	 *
	 * `sizeBytesAtPick` is the provider's size for that document read the
	 * instant the picker returned, BEFORE any of our bytes were written — 0
	 * means the system just created it (so a failed export may delete it
	 * again, see `discardArchiveDestination`), a non-zero value means the user
	 * pointed us at a file that already existed (never deleted), and -1 means
	 * the provider would not say (also never deleted).
	 */
	pickArchiveDestination(params: {
		suggestedName: string;
	}): Promise<{
		uri: string;
		sizeBytesAtPick: number;
		isNewlyCreated: boolean;
		displayName?: string;
	} | null>;
	/**
	 * Launches a SAF `ACTION_OPEN_DOCUMENT` picker for an existing archive.
	 * Resolves with a `content://` source URI for `importArchive`, or null
	 * when the user cancelled. Web: null.
	 */
	pickArchiveSource(): Promise<{ uri: string } | null>;
	/**
	 * Native archive assembly: reads the real media bytes from custody by the
	 * recipe's relative paths, SHA-256-hashes each, streams them into a STORE
	 * ZIP at `destinationUri`, and resolves with the authoritative manifest
	 * (hashes native computed). Rejects `IO_ERROR` on write failure, leaving
	 * no committed archive (native writes to a temp doc and renames).
	 */
	/**
	 * Extracts the SOURCE frame at `timestampMicros` and writes it as a PNG in
	 * media custody, returning its durable relative path. Optional: platforms
	 * without native custody (web) and older native shells leave it undefined,
	 * and the caller must refuse the freeze rather than fake a still.
	 *
	 * `referencedFreezePaths` is the project's current set of freeze stills;
	 * native deletes unreferenced files under its generated-freeze directory as
	 * part of the capture, so replaced/removed freezes do not accumulate.
	 */
	captureFreezeFrame?(params: {
		sourceElementId: string;
		/** Custody-relative path of the clip's source media. */
		sourceMediaPath: string;
		timestampMicros: number;
		referencedFreezePaths?: string[];
	}): Promise<FreezeFrameCapture | null>;
	/**
	 * Generates a real reversed MP4 for `[startMs, endMs)` of the source: the
	 * clip's own frames encoded backwards into an ordinary forward-playing
	 * file. The caller retargets the element at the returned asset, so preview
	 * and native export need no reverse-aware code path.
	 *
	 * The file is video-only (the reversed clip is silent; the UI says so), and
	 * `referencedReversePaths` lets native prune generated files the project no
	 * longer references. Progress is delivered through `onProgress`; rejects
	 * with the native code (`CANCELLED`, `RANGE_OUT_OF_BOUNDS`,
	 * `FRAME_UNAVAILABLE`, `REVERSE_FAILED`) rather than resolving empty.
	 * Absent on platforms without native media custody (callers must refuse).
	 */
	reverseVideo?(
		params: {
			assetId: string;
			sourceMediaPath: string;
			startMs: number;
			endMs: number;
			fps?: number;
			referencedReversePaths?: string[];
		},
		onProgress?: (progress: {
			done: number;
			total: number;
			progress: number;
		}) => void,
	): Promise<ReverseVideoResult | null>;
	/** Requests cancellation of the in-flight `reverseVideo`. */
	cancelReverseVideo?(): Promise<void>;
	exportArchive(params: {
		destinationUri: string;
		/** Replayed from `pickArchiveDestination` — the ownership evidence a
		 *  failed write needs before it may remove the document. */
		sizeBytesAtPick: number;
		projectJson: string;
		media: BackupMediaDescriptor[];
		appVersion: string;
	}): Promise<{ manifestJson: string }>;
	/**
	 * Removes an archive destination that was created empty by this operation
	 * but never written (the failure happened before `exportArchive`, e.g.
	 * while building the recipe).
	 *
	 * Always resolves: `deleted:false` with `outcome:"refused"` is a normal
	 * answer from a provider that will not let us delete, and the caller must
	 * report that leftover file honestly instead of claiming a clean failure.
	 */
	discardArchiveDestination(params: {
		uri: string;
		sizeBytesAtPick: number;
	}): Promise<{ deleted: boolean; outcome: string; message: string }>;
	/**
	 * Native archive import: reads the ZIP from `sourceUri`, verifies every
	 * entry's SHA-256 against the manifest, extracts media to FRESH custody
	 * paths (staging then atomic move), and resolves with the manifest +
	 * project JSON + the fresh-path restore map. Rejects `CORRUPT_ARCHIVE`
	 * (added to the error codes) on any integrity failure, committing nothing.
	 */
	importArchive(params: {
		sourceUri: string;
	}): Promise<{
		manifestJson: string;
		projectJson: string;
		restoredFiles: RestoredMediaFile[];
	}>;
}
