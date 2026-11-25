/**
 * Reverse Video — the source range a clip plays, and the element patch that
 * points it at real reversed media.
 *
 * The editor has carried a `reversed` boolean since M8, but nothing downstream
 * reads it: the retime engine only accepts positive rates and neither the WASM
 * compositor nor the Media3 exporter decodes backwards. This module is the
 * shared half of the honest implementation: the clip's own audible/visible
 * source range is computed here (trim + retime, the same math the split
 * command uses), the native side generates ONE bounded reversed file for that
 * range, and the clip is then retargeted at that file — so preview and export
 * play real reversed frames through the ordinary forward pipeline instead of a
 * flag nothing honours.
 *
 * Audio policy: the generated file carries video only. The reversed clip is
 * therefore silent, and the UI says so; the original media keeps its own
 * bytes and is never modified.
 */
import type { VideoElement } from "@/timeline";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { getSourceSpanAtClipTime } from "@/retime/split";
import { TICKS_PER_SECOND, addMediaTime, mediaTime, roundMediaTime } from "@/wasm";

const MICROS_PER_SECOND = 1_000_000;

/** Custody-relative directory the native generator writes into. */
export const REVERSE_SUBDIR = "reverse";

/** Rate the generator samples the source at. */
export const REVERSE_DEFAULT_FPS = 30;

export type ReverseSourceRange =
	| {
			ok: true;
			/** First source instant the clip shows, in microseconds. */
			startMicros: number;
			/** One past the last source instant the clip shows, in microseconds. */
			endMicros: number;
			durationMicros: number;
		}
	| { ok: false; reason: "not-video" | "empty-range" };

/**
 * The source range a video element actually plays, in source microseconds.
 *
 * `trimStart` is the trimmed-away head; the length is the clip's own duration
 * converted back through its retime rate (`getSourceSpanAtClipTime`), so a
 * 2x clip reversed covers the same source frames it played, in reverse, and
 * keeps its timeline duration. Velocity is a display property of the element,
 * not something baked into the generated file.
 */
export function reverseSourceRange({
	element,
}: {
	element: TimelineElement;
}): ReverseSourceRange {
	if (element.type !== "video") return { ok: false, reason: "not-video" };
	const span = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: element.duration,
			retime: element.retime,
		}),
	});
	if (span <= 0) return { ok: false, reason: "empty-range" };
	const startTicks = element.trimStart;
	const endTicks = addMediaTime({ a: startTicks, b: span });
	return {
		ok: true,
		startMicros: Math.round((startTicks * MICROS_PER_SECOND) / TICKS_PER_SECOND),
		endMicros: Math.round((endTicks * MICROS_PER_SECOND) / TICKS_PER_SECOND),
		durationMicros: Math.round((span * MICROS_PER_SECOND) / TICKS_PER_SECOND),
	};
}

/**
 * The single undoable element patch that makes a clip play the generated
 * reversed file: retarget the media and start it at 0. Duration, retime rate,
 * trim end, transform, crop, framing and effects stay exactly as they were, so
 * rotation/framing/colour keep applying on top of the reversed frames.
 *
 * `reversed` is cleared because it is now bookkeeping for a state that no
 * longer needs a flag — the clip's media really is reversed.
 */
export function buildReversedElementPatch({
	element,
	mediaId,
}: {
	element: TimelineElement;
	mediaId: string;
}): Partial<VideoElement> | null {
	if (element.type !== "video" || mediaId.length === 0) return null;
	return {
		mediaId,
		trimStart: mediaTime({ ticks: 0 }) as MediaTime,
		trimEnd: mediaTime({ ticks: 0 }) as MediaTime,
		params: { ...element.params, reversed: false },
	};
}

/** Name for the generated asset row (never a path — the native side names the file). */
export function reversedAssetName({
	startMicros,
	endMicros,
}: {
	startMicros: number;
	endMicros: number;
}): string {
	return `reversed-${Math.round(startMicros / 1000)}-${Math.round(endMicros / 1000)}ms.mp4`;
}
