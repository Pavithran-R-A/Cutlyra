/**
 * Fixer pass: maps the REAL `EditorCore` scene graph
 * (`editor.scenes.getActiveSceneOrNull()?.tracks`, a `SceneTracks` of
 * `main`/`overlay[]`/`audio[]` `TimelineTrack`s) into M7's
 * `TimelineProjectVM` view-model, so `TimelineView` can be mounted against
 * live project state instead of only `mock-data.ts`'s synthetic stress
 * project.
 *
 * This closes the "never imported/mounted, never sees real EditorCore
 * state" gap. It does NOT close the separate, pre-existing gap disclosed in
 * timeline-view.tsx's own `handleTrimCommit` comment and the M7 handoff
 * notes: trim/reorder gestures still don't write back through editor-core's
 * resize/move commands from inside `TimelineView` itself. That's real
 * follow-on wiring work (each gesture needs its own command call, the same
 * way `packages/mobile-ui/src/editor/actions.ts` wires panel buttons to
 * commands), left for a dedicated M7-completion pass rather than papered
 * over here.
 *
 * Time rule: every field read off an element/track here is a `MediaTime`
 * (integer ticks) converted to float seconds exactly once, at this
 * UI-boundary mapping — never treated as seconds before that conversion.
 *
 * Snapshot-caching rule (real bug hit and fixed during this pass): the
 * first version of this hook returned a freshly-allocated `{tracks,
 * durationSec, fps}` object literal directly from a `useEditor(selector)`
 * call. `useEditor`'s own `isShallowEqual` cache (packages/editor-core/
 * react/use-editor.ts) only special-cases ARRAYS — a plain object always
 * compares unequal to its own previous snapshot by `Object.is`, so
 * `getSnapshot()` never hit the cache and `useSyncExternalStore` re-fired
 * on every render, which re-triggered a re-render, forever. Reproduced
 * live: React logged "The result of getSnapshot should be cached" followed
 * by "Maximum update depth exceeded," and `/dev/mobile-editor` rendered
 * only a client-side-exception error boundary — this file's OWN doc-header
 * intent (mount `TimelineView` against live state) was fully broken by
 * this bug, not just degraded. Same failure mode `use-live-editor.ts`'s
 * `useSelectedElement` doc comment already warns about, for the identical
 * reason. Fixed by pulling only REFERENTIALLY STABLE values out of
 * `useEditor` (the manager's own `tracks`/`fps` objects, which the engine
 * only replaces on an actual mutation — `Object.is` correctly detects "no
 * change" on those) and doing the object-literal mapping in a local
 * `useMemo` keyed on those stable references instead, so the mapping only
 * re-runs when something real changed.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useEditor } from "@cutlyra/editor-core/react";
import { mediaTimeToSeconds } from "@cutlyra/editor-core/wasm";
import { calculateTotalDuration } from "@cutlyra/editor-core/timeline";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@cutlyra/editor-core/timeline";
import type { MediaAsset } from "@cutlyra/editor-core";
import { sampleSourceWaveformSummary } from "@cutlyra/editor-core/media/waveform-summary";
import type { FrameRate } from "opencut-wasm";
import {
	getWaveformsVersion,
	getWaveformSummary,
	kickWaveform,
	subscribeWaveforms,
} from "./waveform-peaks";
import {
	getThumbnailStrip,
	getThumbnailsVersion,
	kickThumbnailStrip,
	makeStripPersister,
	subscribeThumbnails,
} from "./thumbnail-strip";
import { mapSourceStripToClip } from "../timeline/thumbnails";
import {
	resolveNativeMediaPath,
	resolveNativeMediaRawPath,
} from "@cutlyra/editor-core/media/native-paths";
import { getClipKeyframeTimes } from "./keyframes";
import { trackDisplayOrder, trackLaneKind } from "./track-order";
import type {
	TimelineClipKind,
	TimelineClipVM,
	TimelineProjectVM,
	TimelineThumbnailFrame,
	TimelineTrackVM,
} from "../timeline/types";

/** `rate.numerator / rate.denominator` — the exact same one-line
 *  computation as editor-core's own `frameRateToFloat` (packages/editor-core
 *  /src/fps/utils.ts), inlined here rather than deep-imported through a
 *  package-exports wildcard subpath (`@cutlyra/editor-core/fps/utils`) that
 *  this package's `tsc --noEmit` could not resolve (`TS2307`) even though
 *  the exports map's `"./*"` catch-all resolves it correctly at the
 *  bundler/runtime level — a real, narrow gap between this package's type
 *  program and its build-time resolver, not worth widening scope to fix
 *  generally in this pass. UI-boundary use only (the timeline's DISPLAYED
 *  fps readout), same "never cross the EDL bridge as a float" rule as
 *  everywhere else in this file. */
function frameRateToFloatInline(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

/** Stable per-id hash so a given real element always gets the same
 *  placeholder color bar across re-renders (no `Math.random()`). */
function colorHueForId(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	}
	return hash % 360;
}

function clipKindForElement(element: TimelineElement): TimelineClipKind {
	switch (element.type) {
		case "video":
			return "video";
		case "image":
			return "image";
		case "audio":
			return "audio";
		case "text":
			return "text";
		case "sticker":
			return "sticker";
		case "graphic":
			// Closest visual family to a single non-media shape/effect node —
			// `TimelineClipVM` has no dedicated "graphic" kind.
			return "sticker";
		case "caption":
			// Founder capture 2026-08-18: captions are orange blocks in CapCut,
			// not text-styled clips — dedicated kind + CSS class.
			return "caption";
		default:
			return "text";
	}
}

/** Real amplitude peaks for an AUDIO clip's visible (trimmed, retimed)
 *  source window, from the shared waveform cache. Null until the async
 *  decode lands (kicked here; `useTimelineProjectVM` re-runs on arrival
 *  via the waveform version store) or when the source can't decode. */
function audioClipPeaks({
	element,
	asset,
}: {
	element: TimelineElement;
	asset: MediaAsset | undefined;
}): number[] | undefined {
	if (!asset) return undefined;
	kickWaveform({ assetId: asset.id, file: asset.file, url: asset.url });
	const summary = getWaveformSummary(asset.id);
	if (!summary) return undefined;

	const rate =
		"retime" in element && element.retime ? element.retime.rate : 1;
	const trimStartSec = mediaTimeToSeconds({ time: element.trimStart });
	const durationSec = mediaTimeToSeconds({ time: element.duration });
	const windowSec = durationSec * rate;
	const startSample = Math.max(0, trimStartSec * summary.sampleRate);
	const endSample = Math.min(
		summary.totalSamples,
		startSample + windowSec * summary.sampleRate,
	);
	if (endSample <= startSample) return undefined;
	const bucketCount = Math.min(400, Math.max(16, Math.round(durationSec * 20)));
	const span = (endSample - startSample) / bucketCount;
	return sampleSourceWaveformSummary({
		summary,
		buckets: Array.from({ length: bucketCount }, (_, i) => ({
			bucketStart: startSample + i * span,
			bucketEnd: startSample + (i + 1) * span,
		})),
	});
}

function keyframeVMs({ element }: { element: TimelineElement }): TimelineClipVM["keyframes"] {
	const times = getClipKeyframeTimes({ animations: element.animations });
	if (times.length === 0) return undefined;
	return times.map((ticks) => ({
		id: `${element.id}:kf:${ticks}`,
		timeSec: mediaTimeToSeconds({ time: ticks }),
		timeTicks: ticks,
	}));
}

/** Everything the filmstrip kick needs beyond the asset itself — read at
 *  persist time through the LIVE editor, never from the mapping snapshot
 *  (a delete/switch mid-generation must not resurrect stale metadata). */
interface StripKickContext {
	projectId: string | null;
	liveAssets: () => MediaAsset[];
}

/** Absolute native path to sample for the strip: the PROXY first (short-
 *  GOP, baked upright, full length — proxy time == source time), falling
 *  back to the original for legacy assets imported before relative proxy
 *  paths existed. Null on web / pre-root builds (no custody resolver
 *  registered) — there the caller simply doesn't kick and the honest
 *  placeholder stays, exactly like the web waveform path. */
function resolveAssetRawPath(asset: MediaAsset): string | null {
	if (asset.nativeRelativePath) {
		const raw = resolveNativeMediaRawPath(asset.nativeRelativePath);
		if (raw) return raw;
	}
	if (asset.sourceNativeRelativePath) {
		const raw = resolveNativeMediaRawPath(asset.sourceNativeRelativePath);
		if (raw) return raw;
	}
	return null;
}

/** Persisted strip manifest (import seed or a previous session's upgrade)
 *  resolved against the CURRENT custody root — relative paths are the
 *  durable form precisely so this re-anchoring happens at read time
 *  (iOS rotates the container UUID under them). Unresolvable frames are
 *  dropped; an all-dropped manifest degrades to `undefined` (kick will
 *  regenerate). */
function persistedStripFrames(
	asset: MediaAsset,
): TimelineThumbnailFrame[] | undefined {
	const strip = asset.thumbnailStrip;
	if (!strip?.length) return undefined;
	const frames: TimelineThumbnailFrame[] = [];
	for (const frame of strip) {
		const uri = resolveNativeMediaPath(frame.relativePath);
		if (uri) frames.push({ timeSec: frame.timeSec, uri });
	}
	return frames.length > 0 ? frames : undefined;
}

/** Real filmstrip frames for a VIDEO/IMAGE clip's source window (GitHub
 *  #54), or `undefined` → honest placeholder while generation is in
 *  flight / impossible / exhausted. Images skip native entirely: the
 *  still IS every frame of the clip. */
function videoClipThumbnails({
	element,
	asset,
	stripContext,
}: {
	element: TimelineElement;
	asset: MediaAsset | undefined;
	stripContext: StripKickContext;
}): TimelineThumbnailFrame[] | undefined {
	if (!asset) return undefined;
	const durationSec = mediaTimeToSeconds({ time: element.duration });

	if (element.type === "image") {
		const uri = asset.thumbnailUrl ?? asset.url;
		return uri ? [{ timeSec: 0, uri }] : undefined;
	}
	if (element.type !== "video") return undefined;

	// Kick only when there's no SUCCESSFUL strip yet — `null` (failed)
	// re-enters here too, and the store itself bounds that to a few
	// cooldown-gated retries rather than a per-render storm.
	const generated = getThumbnailStrip(asset.id);
	if (!generated || generated.length === 0) {
		const rawPath = resolveAssetRawPath(asset);
		if (rawPath && asset.duration != null && asset.duration > 0) {
			kickThumbnailStrip({
				assetId: asset.id,
				rawPath,
				durationMicros: Math.round(asset.duration * 1_000_000),
				fileName: asset.name,
				persist: stripContext.projectId
					? makeStripPersister({
							projectId: stripContext.projectId,
							asset,
							isAssetLive: () =>
								stripContext
									.liveAssets()
									.some((live) => live.id === asset.id),
						})
					: undefined,
			});
		}
	}

	// Generated frames win; the persisted manifest covers the gap while
	// generation runs and is the ONLY source when generation is impossible
	// (web) or keeps failing — real (if stale) footage beats a gradient.
	const sourceFrames = generated ?? persistedStripFrames(asset);
	if (!sourceFrames?.length) return undefined;
	return mapSourceStripToClip({
		frames: sourceFrames,
		trimStartSec: mediaTimeToSeconds({ time: element.trimStart }),
		durationSec,
		rate:
			"retime" in element && element.retime
				? element.retime.rate
				: undefined,
	});
}

function mapTrack({
	track,
	isMain,
	assetById,
	stripContext,
}: {
	track: TimelineTrack;
	isMain: boolean;
	assetById: Map<string, MediaAsset>;
	stripContext: StripKickContext;
}): TimelineTrackVM {
	const clips: TimelineClipVM[] = track.elements.map((element) => ({
		id: element.id,
		trackId: track.id,
		kind: clipKindForElement(element),
		name: element.name,
		startSec: mediaTimeToSeconds({ time: element.startTime }),
		durationSec: mediaTimeToSeconds({ time: element.duration }),
		colorHue: colorHueForId(element.id),
		// Trim/source state for the handle-extension bounds (see the VM
		// type's own doc comment). sourceDuration is only meaningful on
		// media-backed elements; text/sticker/image leave it undefined and
		// extend freely.
		trimStartSec: mediaTimeToSeconds({ time: element.trimStart }),
		trimEndSec: mediaTimeToSeconds({ time: element.trimEnd }),
		sourceDurationSec:
			element.sourceDuration != null && (element.type === "video" || element.type === "audio")
				? mediaTimeToSeconds({ time: element.sourceDuration })
				: undefined,
		retimeRate:
			"retime" in element && element.retime ? element.retime.rate : undefined,
		waveformPeaks:
			element.type === "audio" && "mediaId" in element
				? audioClipPeaks({ element, asset: assetById.get(element.mediaId) })
				: undefined,
		// GitHub #54: real filmstrip frames for video/image clips —
		// kick + persisted-seed fallback + trim/speed source mapping.
		thumbnails:
			element.type === "video" || element.type === "image"
				? videoClipThumbnails({
						element,
						asset:
							"mediaId" in element
								? assetById.get(element.mediaId)
								: undefined,
						stripContext,
					})
				: undefined,
		// Round 47: one diamond per clip-keyframe TIME (the group model in
		// keyframes.ts), drawn on the clip by TimelineClip. Ticks ride along
		// so a diamond tap seeks exactly.
		keyframes: keyframeVMs({ element }),
	}));
	return {
		id: track.id,
		kind: trackLaneKind({ track, isMain }),
		name: track.name,
		clips,
		muted: "muted" in track ? track.muted : undefined,
		hidden: "hidden" in track ? track.hidden : undefined,
	};
}

/** Live `TimelineProjectVM` built from the real active scene/project, or
 *  `null` before a project exists yet. */
export function useTimelineProjectVM(): TimelineProjectVM | null {
	// Referentially stable reads only — see this file's header re: why the
	// object-literal MAPPING must not happen inside the `useEditor` selector
	// itself.
	const tracks = useEditor(
		(editor): SceneTracks | null => editor.scenes.getActiveSceneOrNull()?.tracks ?? null,
	);
	const fps = useEditor(
		(editor): FrameRate | null => editor.project.getActiveOrNull()?.settings.fps ?? null,
	);
	const mediaAssets = useEditor((editor) => editor.media.getAssets());
	// Stable singleton — the filmstrip persist hook reads the CURRENT media
	// list through it at write time (see StripKickContext).
	const editor = useEditor();
	const projectId = useEditor(
		(editor): string | null =>
			editor.project.getActiveOrNull()?.metadata.id ?? null,
	);
	// Bumps when an async waveform decode lands, re-running the mapping so
	// audio clips pick up their real peaks (see waveform-peaks.ts).
	const waveformsVersion = useSyncExternalStore(
		subscribeWaveforms,
		getWaveformsVersion,
		getWaveformsVersion,
	);
	// Bumps when a native filmstrip strip lands (or fails), re-running the
	// mapping so video clips upgrade placeholder → real frames (see
	// thumbnail-strip.ts).
	const thumbnailsVersion = useSyncExternalStore(
		subscribeThumbnails,
		getThumbnailsVersion,
		getThumbnailsVersion,
	);

	return useMemo(() => {
		if (!tracks || !fps) return null;

		const assetById = new Map(mediaAssets.map((asset) => [asset.id, asset]));
		const stripContext: StripKickContext = {
			projectId,
			liveAssets: () => editor.media.getAssets(),
		};
		// Lane order comes from `track-order.ts`: overlays above the main row,
		// audio below it — matching the placement engine's own track indexing
		// and the web editor (see that file's doc comment for the report this
		// fixes).
		const trackVMs: TimelineTrackVM[] = trackDisplayOrder(tracks).map(
			({ track, isMain }) =>
				mapTrack({ track, isMain, assetById, stripContext }),
		);

		return {
			tracks: trackVMs,
			durationSec: mediaTimeToSeconds({ time: calculateTotalDuration({ tracks }) }),
			fps: frameRateToFloatInline(fps),
		};
	}, [
		tracks,
		fps,
		mediaAssets,
		waveformsVersion,
		thumbnailsVersion,
		projectId,
		editor,
	]);
}
