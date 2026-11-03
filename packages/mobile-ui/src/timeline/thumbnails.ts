/**
 * Source-time mapping + nearest-slot lookup for real filmstrip frames
 * (GitHub #54).
 *
 * The native strip is a set of frames at fixed SOURCE-relative times
 * (midpoints of evenly spaced cells over the whole file), while the
 * timeline renders slots at zoom-dependent, float-computed clip-relative
 * times (`visibleThumbnailSlots` rounds to 3 decimals; the interval itself
 * changes with pixels-perSecond). Matching those two by exact dictionary
 * equality is the trap issue #54 calls out — arbitrary `slotSec` keys will
 * essentially never equal a native timestamp. Instead:
 *
 *   1. `mapSourceStripToClip` converts each source frame into the clip's
 *      own timeline (trim start, duration, speed/retime), dropping frames
 *      outside the clip's source window so trimmed-away footage never
 *      renders — this is what makes trim/split/speed/reorder/duplicate all
 *      fall out correctly with no per-gesture special cases (each gesture
 *      just changes the element's trim/retime, and re-mapping follows).
 *   2. `nearestThumbnailUri` picks the closest mapped frame for whatever
 *      slot the current zoom asks for, so zoom density changes only alter
 *      how often frames repeat — never which footage they show.
 *
 * Pure functions, unit-tested (thumbnails.test.ts).
 */
import type { TimelineThumbnailFrame } from "./types";

/**
 * Frames from the source strip that fall inside the clip's source window
 * `[trimStart, trimStart + duration·rate]`, expressed in CLIP-relative
 * seconds: `clipSec = (sourceSec - trimStart) / rate` (the same
 * source = clip·rate + trimStart relation `audioClipPeaks` windows with).
 *
 * `rate <= 0` (or absent) means 1 — reverse retiming is future support and
 * must not divide by zero when it arrives.
 *
 * Sliver clips (a split fragment narrower than the strip's frame spacing —
 * e.g. a 0.3s slice of a 60s source with 0.5s frames) can contain ZERO
 * frames in-window; rather than fall back to a gradient, keep the single
 * source frame nearest the window centre. Its mapped time may land outside
 * `[0, duration]`, which is fine: the nearest lookup below clamps by
 * proximity, and one real frame beats an honest-but-empty placeholder when
 * the footage genuinely exists.
 */
export function mapSourceStripToClip({
	frames,
	trimStartSec,
	durationSec,
	rate,
}: {
	frames: readonly { timeSec: number; uri: string }[];
	trimStartSec: number;
	durationSec: number;
	rate: number | undefined;
}): TimelineThumbnailFrame[] | undefined {
	if (frames.length === 0) return undefined;
	const effectiveRate = rate != null && rate > 0 ? rate : 1;

	const inWindow: TimelineThumbnailFrame[] = [];
	for (const frame of frames) {
		const clipSec = (frame.timeSec - trimStartSec) / effectiveRate;
		// 1µs of slack keeps float noise from dropping a frame that lands
		// exactly on a trim edge.
		if (clipSec >= -1e-6 && clipSec <= durationSec + 1e-6) {
			inWindow.push({ timeSec: clipSec, uri: frame.uri });
		}
	}

	if (inWindow.length === 0) {
		const windowCentre =
			trimStartSec + (durationSec * effectiveRate) / 2;
		let best = frames[0];
		let bestDist = Math.abs(best.timeSec - windowCentre);
		for (const frame of frames.slice(1)) {
			const dist = Math.abs(frame.timeSec - windowCentre);
			if (dist < bestDist) {
				best = frame;
				bestDist = dist;
			}
		}
		inWindow.push({
			timeSec: (best.timeSec - trimStartSec) / effectiveRate,
			uri: best.uri,
		});
	}

	inWindow.sort((a, b) => a.timeSec - b.timeSec);
	return inWindow;
}

/**
 * URI of the frame nearest `slotSec` (clip-relative). `frames` must be
 * sorted ascending by `timeSec` — `mapSourceStripToClip` guarantees that.
 * Returns `undefined` only when there is no strip at all, which is the
 * ONE case where the caller shows the placeholder gradient: everything
 * else renders real footage, however coarsely the current zoom samples it.
 */
export function nearestThumbnailUri({
	frames,
	slotSec,
}: {
	frames: readonly TimelineThumbnailFrame[] | undefined;
	/** Clip-relative seconds of the filmstrip slot to look up. */
	slotSec: number;
}): string | undefined {
	if (!frames || frames.length === 0) return undefined;

	// Last frame at or before the slot (binary search — strips are bounded
	// but can hold a few hundred frames across many visible slots).
	let lo = 0;
	let hi = frames.length - 1;
	while (lo < hi) {
		const mid = lo + Math.ceil((hi - lo) / 2);
		if (frames[mid].timeSec <= slotSec) lo = mid;
		else hi = mid - 1;
	}

	// `lo` may still be a frame AFTER the slot (all frames greater) or the
	// last frame overall (all frames before) — comparing both neighbours
	// covers both, and with a single frame it trivially returns that one.
	if (lo < frames.length - 1) {
		const next = frames[lo + 1];
		if (
			Math.abs(next.timeSec - slotSec) <
			Math.abs(frames[lo].timeSec - slotSec)
		) {
			return next.uri;
		}
	}
	return frames[lo].uri;
}