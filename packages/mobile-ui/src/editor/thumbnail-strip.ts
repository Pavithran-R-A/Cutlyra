/**
 * Async real-filmstrip store for the mobile timeline (GitHub #54).
 *
 * Same subscribe/version/kick shape as `waveform-peaks.ts` (the VM mapping
 * is synchronous, so native work rides out-of-band): `kickThumbnailStrip`
 * is called during mapping for any video asset without a generated strip
 * yet, the native `generateThumbnails` call resolves on a background
 * thread, and `useSyncExternalStore(subscribeThumbnails,
 * getThumbnailsVersion)` re-runs the mapping so clips upgrade from
 * placeholder → real frames. No high-resolution bytes ever enter JS — the
 * store holds only playback URIs plus source-relative timestamps; the
 * JPEGs themselves live in native custody (Android
 * `noBackupFilesDir/thumbnails/<assetId>/`, iOS `MediaSandbox
 * .thumbnailDirectory`), the same files the persisted
 * `MediaAssetData.thumbnailStrip` manifest points at.
 *
 * Bounds and failure discipline (issue #54's "bounded lazy cache"):
 *   - at most `MAX_STRIPS` strips resident, oldest evicted on overflow;
 *   - at most `MAX_CONCURRENT` native generations in flight — a 20-clip
 *     project enqueues instead of spawning 20 decoders at once;
 *   - a failed generation caches `null` (honest placeholder upstream) and
 *     retries at most `MAX_ATTEMPTS` times per session, never faster than
 *     `retryCooldownMs` — renders kick constantly, so without the cooldown
 *     a corrupt source would storm native.
 *
 * The PROXY file is sampled (short-GOP, baked upright, full length, so
 * proxy time == source time), keyed by the durable asset ID — which is
 * also the native thumbnail directory name, making regeneration
 * idempotent across sessions: the same files are rewritten in place and
 * the persisted manifest keeps pointing at them.
 */
import {
	getNativeBridge,
	type MediaHandle,
	type NativeBridge,
} from "@cutlyra/native-bridge";
import type { MediaAsset } from "@cutlyra/editor-core";
import { storageService } from "@cutlyra/editor-core/services/storage/service";
import type { MediaThumbnailStripFrame } from "@cutlyra/editor-core/services/storage/types";
import {
	getRegisteredNativeMediaRoot,
	relativeMediaPathFromPlaybackUrl,
} from "@cutlyra/editor-core/media/native-paths";

/** One generated frame: SOURCE-relative seconds + webview playback URI. */
export interface GeneratedThumbnailFrame {
	timeSec: number;
	uri: string;
}

interface StripEntry {
	/** `null` = the last attempt failed; see `attempts`/`failedAt`. */
	frames: GeneratedThumbnailFrame[] | null;
	attempts: number;
	failedAt: number;
}

const MAX_STRIPS = 48;
const MAX_ATTEMPTS = 3;
const MAX_CONCURRENT = 3;
/** Filmstrip slots are ~44×48 CSS px (TARGET_THUMB_WIDTH_PX ×
 *  TRACK_HEIGHT_PX); 240 long edge covers ~3x DPR with headroom — the
 *  same default iOS's `generateThumbnails` uses. */
const MAX_EDGE_PX = 240;
/** 2 fps of source: dense enough that every default-zoom slot maps to a
 *  distinct frame, bounded enough that a 10-min clip stays at 200 frames
 *  (nearest-lookup repeats frames when zoomed past this — by design). */
const TARGET_FRAMES_PER_SEC = 2;
const MIN_FRAMES = 8;
const MAX_FRAMES = 200;

const entries = new Map<string, StripEntry>();
const pending = new Set<string>();
const queued = new Set<string>();
const queue: Array<() => void> = [];
let active = 0;
let version = 0;
const listeners = new Set<() => void>();

let retryCooldownMs = 10_000;
let now: () => number = () => Date.now();

// --- Test seams -----------------------------------------------------------
// Indirections instead of bun's `mock.module`: that mock is PROCESS-GLOBAL
// in the single root `bun test` process and leaks into every file that
// loads afterwards (it broke native-bridge's own `getNativeBridge` suite),
// and bun offers no reliable unmock. Tests inject fakes here; production
// path is untouched.

type ThumbnailBridge = Pick<NativeBridge, "generateThumbnails">;

type MediaAssetSaveArgs = {
	projectId: string;
	mediaAsset: MediaAsset;
};

function defaultBridgeGetter(): Promise<ThumbnailBridge> {
	return getNativeBridge();
}

function defaultMediaAssetSaver(args: MediaAssetSaveArgs): Promise<void> {
	return storageService.saveMediaAsset(args);
}

let bridgeGetter: () => Promise<ThumbnailBridge> = defaultBridgeGetter;
let mediaAssetSaver: (args: MediaAssetSaveArgs) => Promise<void> =
	defaultMediaAssetSaver;

/** Test hook: swap the native bridge (null restores the real one). */
export function __setNativeBridgeGetterForTests(
	getter: (() => Promise<ThumbnailBridge>) | null,
): void {
	bridgeGetter = getter ?? defaultBridgeGetter;
}

/** Test hook: swap the strip-manifest saver (null restores the real one). */
export function __setMediaAssetSaverForTests(
	saver: ((args: MediaAssetSaveArgs) => Promise<void>) | null,
): void {
	mediaAssetSaver = saver ?? defaultMediaAssetSaver;
}

export function subscribeThumbnails(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getThumbnailsVersion(): number {
	return version;
}

/** `undefined` = never attempted (kick will start one); `null` = failed
 *  (placeholder + bounded retry); array = generated, source-relative. */
export function getThumbnailStrip(
	assetId: string,
): GeneratedThumbnailFrame[] | null | undefined {
	return entries.get(assetId)?.frames;
}

function notify(): void {
	version += 1;
	for (const listener of listeners) listener();
}

/** FIFO-bound the cache: drop the oldest resident (non-in-flight) entry so
 *  inserting a new strip keeps the map at `MAX_STRIPS`. Evicted strips are
 *  cheap to rebuild — the native files persist, and a manifest-backed
 *  asset falls back to `asset.thumbnailStrip` without regenerating. */
function evictBeforeInsert(keepId: string): void {
	while (entries.size >= MAX_STRIPS) {
		let evicted = false;
		for (const key of entries.keys()) {
			if (key === keepId || pending.has(key)) continue;
			entries.delete(key);
			evicted = true;
			break;
		}
		if (!evicted) return; // everything else in flight — bound on the next insert
	}
}

function stripSpec(durationMicros: number): {
	count: number;
	maxEdgePx: number;
} {
	const count = Math.min(
		MAX_FRAMES,
		Math.max(
			MIN_FRAMES,
			Math.round((durationMicros / 1_000_000) * TARGET_FRAMES_PER_SEC),
		),
	);
	return { count, maxEdgePx: MAX_EDGE_PX };
}

/** Idempotent generation kick — safe to call on every VM mapping pass.
 *  Runs immediately while under the concurrency cap, enqueues otherwise. */
export function kickThumbnailStrip({
	assetId,
	rawPath,
	durationMicros,
	fileName,
	persist,
}: {
	assetId: string;
	/** Absolute native path of the file to sample — the caller passes the
	 *  PROXY's (short-GOP, baked upright) with a source fallback. */
	rawPath: string;
	/** Source duration in integer micros (the strip's timestamps ride on
	 *  the same unit discipline as `MediaHandle.durationMicros`). */
	durationMicros: number;
	fileName: string;
	/** Best-effort persistence hook, invoked once per SUCCESS with the
	 *  generated frames — see `makeStripPersister`. */
	persist?: (frames: GeneratedThumbnailFrame[]) => void;
}): void {
	if (!assetId || !rawPath || !(durationMicros > 0)) return;
	if (pending.has(assetId) || queued.has(assetId)) return;

	const existing = entries.get(assetId);
	if (existing?.frames && existing.frames.length > 0) return; // already generated
	if (existing && existing.attempts >= MAX_ATTEMPTS) return; // gave up this session
	if (
		existing &&
		existing.frames === null &&
		now() - existing.failedAt < retryCooldownMs
	) {
		return; // cooldown — bounded retry, never a per-render storm
	}

	const start = (): void => {
		queued.delete(assetId);
		// Re-check on dispatch: state may have moved while queued.
		const current = entries.get(assetId);
		if (pending.has(assetId)) return;
		if (current?.frames && current.frames.length > 0) return;
		if (current && current.attempts >= MAX_ATTEMPTS) return;
		if (
			current &&
			current.frames === null &&
			now() - current.failedAt < retryCooldownMs
		) {
			return;
		}			pending.add(assetId);
			active += 1;
			const attemptsBefore = current?.attempts ?? 0;
			const { count, maxEdgePx } = stripSpec(durationMicros);
			void bridgeGetter()
			.then((bridge) =>
				bridge.generateThumbnails({
					handle: {
						id: assetId,
						uri: rawPath,
						kind: "video",
						fileName,
						sizeBytes: 0,
						durationMicros: Math.round(durationMicros),
						width: 0,
						height: 0,
						rotationDegrees: 0,
						hasAudio: false,
						codec: "",
						frameRate: null,
					} satisfies MediaHandle,
					spec: { count, maxEdgePx },
				}),
			)
			.then((strip) => {
				const frames: GeneratedThumbnailFrame[] = strip.uris.map(
					(uri, index) => ({
						timeSec:
							(strip.timestampsMicros[index] ?? 0) / 1_000_000,
						uri,
					}),
				);
				if (frames.length === 0) {
					// Treat an empty native result as a failure — an empty
					// success would silently cache "no frames forever".
					throw new Error("native strip contained no frames");
				}
				evictBeforeInsert(assetId);
				entries.set(assetId, {
					frames,
					attempts: attemptsBefore,
					failedAt: 0,
				});
				if (persist) {
					try {
						persist(frames);
					} catch (error) {
						// Persistence is best-effort: the strip is already
						// live in memory; only the reopen fast-path lost.
						console.warn(
							`[cutlyra-thumbnails] persist hook failed for ${assetId}:`,
							error instanceof Error ? error.message : String(error),
						);
					}
				}
			})
			.catch((error: unknown) => {
				entries.set(assetId, {
					frames: null,
					attempts: attemptsBefore + 1,
					failedAt: now(),
				});
				console.warn(
					`[cutlyra-thumbnails] strip generation failed for asset ${assetId} (attempt ${attemptsBefore + 1}/${MAX_ATTEMPTS}):`,
					error instanceof Error ? error.message : String(error),
				);
			})
			.finally(() => {
				pending.delete(assetId);
				active -= 1;
				notify();
				drain();
			});
	};

	if (active < MAX_CONCURRENT) start();
	else {
		queued.add(assetId);
		queue.push(start);
	}
}

function drain(): void {
	while (active < MAX_CONCURRENT && queue.length > 0) {
		queue.shift()?.();
	}
}

/**
 * The `persist` hook for `kickThumbnailStrip`: converts generated frames
 * back to custody-relative paths (the durable form — absolute playback
 * URIs die with an iOS container rotation) and writes them onto the LIVE
 * asset + its storage record so the next open paints the strip
 * synchronously, before any generation runs.
 *
 * Best-effort by design: never throws into the generation chain, skips
 * writes when the asset was deleted mid-generation (the guard reads the
 * CURRENT media list — a strip must not resurrect removed metadata), and
 * skips when the strip is already persisted unchanged.
 */
export function makeStripPersister({
	projectId,
	asset,
	isAssetLive,
}: {
	projectId: string | null;
	asset: MediaAsset;
	/** Reads the current media list at persist time (not the mapping-time
	 *  snapshot) so a delete/switch during generation is honored. */
	isAssetLive: () => boolean;
}): ((frames: GeneratedThumbnailFrame[]) => void) | undefined {
	if (!projectId) return undefined;
	return (frames) => {
		try {
			const root = getRegisteredNativeMediaRoot();
			if (!root || !isAssetLive()) return;
			const strip: MediaThumbnailStripFrame[] = [];
			for (const frame of frames) {
				const relativePath = relativeMediaPathFromPlaybackUrl({
					url: frame.uri,
					root,
				});
				if (relativePath) {
					strip.push({ timeSec: frame.timeSec, relativePath });
				}
			}
			if (strip.length === 0) return;
			const existing = asset.thumbnailStrip;
			if (
				existing &&
				existing.length === strip.length &&
				existing.every(
					(frame, index) =>
						frame.relativePath === strip[index].relativePath &&
						frame.timeSec === strip[index].timeSec,
				)
			) {
				return; // already persisted — no clobber, no write
			}
			// Mutate the live object FIRST so any later saveMediaAsset
			// (which copies fields explicitly) carries the strip instead of
			// clobbering it back to undefined.
			asset.thumbnailStrip = strip;
			void mediaAssetSaver({ projectId, mediaAsset: asset })
				.catch((error: unknown) => {
					console.warn(
						`[cutlyra-thumbnails] couldn't persist strip for ${asset.id}:`,
						error instanceof Error ? error.message : String(error),
					);
				});
		} catch (error) {
			console.warn(
				`[cutlyra-thumbnails] persist failed for ${asset.id}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	};
}

/** Test hook: clears all store state (and restores retry timing defaults
 *  unless overridden, so suites can drive the cooldown deterministically). */
export function __resetThumbnailStripForTests(
	opts?: { retryCooldownMs?: number; now?: () => number },
): void {
	entries.clear();
	pending.clear();
	queued.clear();
	queue.length = 0;
	active = 0;
	version = 0;
	listeners.clear();
	retryCooldownMs = opts?.retryCooldownMs ?? 10_000;
	now = opts?.now ?? (() => Date.now());
	// Restore the real collaborators so a test's fakes can never outlive
	// this file's suite (later files in the shared process must see prod).
	bridgeGetter = defaultBridgeGetter;
	mediaAssetSaver = defaultMediaAssetSaver;
}