import type { MediaAsset } from "@/media/types";
import { getEffectiveRateAt, getTimelineDurationForSourceSpan } from "@/retime";
import type { TimelineElement } from "@/timeline";
import {
	type MediaTime,
	mediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";

/**
 * Nondestructive Replace-Clip planning (#74).
 *
 * Replace Clip swaps the media a timeline clip points at while keeping the
 * user's authored work: clip identity, track, timeline position, trim intent,
 * framing, transform, effects, masks, keyframes and source-audio settings.
 *
 * The hard part is not the swap, it is deciding what to do when the new source
 * cannot satisfy the old edit. The rules here are deliberately conservative:
 *
 * 1. **Never silently rewrite timing.** If the existing trimmed source window
 *    does not fit inside the replacement's duration, the plan REFUSES and
 *    reports the numbers the caller needs to ask the user. Only an explicit
 *    `allowClamp` produces the shortened plan, and the caller is expected to
 *    have shown that choice to the user first.
 * 2. **Preserve `trimStart` when clamping.** A clip trimmed to start 2s into
 *    the old source keeps starting 2s into the replacement when that is still
 *    inside the new source; only the tail is shortened. Only when the trim
 *    start itself is past the end of the replacement does the plan fall back
 *    to the full replacement from its start (and it says so via
 *    `clampedFromStart`).
 * 3. **Images are visual-only.** An image clip's `duration` is authored
 *    timeline time, not source time, so an image→image replacement never
 *    touches timing and never needs clamping.
 *
 * Cross-type replacement (video↔image, audio→video, …) is rejected: an image
 * has no source duration to honour and a video's trim window has no meaning
 * against a still, so the rules above cannot be defined without inventing
 * semantics. Video→video and image→image are the supported cases.
 */

export type ReplaceMediaRejectionReason =
	| "unsupported-element-type"
	| "type-mismatch"
	| "unknown-source-duration"
	| "source-too-short";

export interface ReplaceMediaClampPreview {
	/** Trim start the clip would keep (source ticks). */
	trimStartTicks: MediaTime;
	/** Timeline duration the clip would keep (timeline ticks, retime-aware). */
	durationTicks: MediaTime;
	/** True when `trimStart` itself was past the replacement's end. */
	clampedFromStart: boolean;
}

/**
 * The exact field set a replacement writes. It is one flat shape (not a union
 * of per-element partials) so applying it to a `TimelineElement` needs no cast:
 * every field exists on both video and image elements, and the timing fields
 * stay absent unless the plan genuinely changes them.
 */
export interface ReplaceMediaPatch {
	mediaId: string;
	name: string;
	sourceDuration?: MediaTime;
	trimStart?: MediaTime;
	duration?: MediaTime;
	trimEnd?: MediaTime;
}

export interface ReplaceMediaPlanOk {
	ok: true;
	/** Exact element patch to apply. Never contains timing fields the user did
	 *  not author — timing only appears when it must actually change. */
	patch: ReplaceMediaPatch;
	/** True when applying this plan shortens the clip. Callers must have asked. */
	clamped: boolean;
}

export interface ReplaceMediaPlanRejected {
	ok: false;
	reason: ReplaceMediaRejectionReason;
	/** Human-readable, user-facing sentence. */
	message: string;
	/** Present for `source-too-short`: exactly what an `allowClamp` retry does. */
	clamp?: ReplaceMediaClampPreview;
}

export type ReplaceMediaPlan = ReplaceMediaPlanOk | ReplaceMediaPlanRejected;

function sourceTicksForAsset({ asset }: { asset: MediaAsset }): MediaTime {
	const seconds = typeof asset.duration === "number" ? asset.duration : 0;
	if (!Number.isFinite(seconds) || seconds <= 0) return ZERO_MEDIA_TIME;
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function rateForElement({ element }: { element: TimelineElement }): number {
	const retime = "retime" in element ? element.retime : undefined;
	return getEffectiveRateAt({ retime });
}

/**
 * Plan a replacement without touching editor state, so a caller can validate
 * (and, when needed, ask the user) before anything is committed.
 */
export function planClipMediaReplacement({
	element,
	asset,
	allowClamp = false,
}: {
	element: TimelineElement;
	asset: MediaAsset;
	allowClamp?: boolean;
}): ReplaceMediaPlan {
	if (element.type !== "video" && element.type !== "image") {
		return {
			ok: false,
			reason: "unsupported-element-type",
			message: "Only video and image clips can be replaced.",
		};
	}

	if (asset.type !== element.type) {
		return {
			ok: false,
			reason: "type-mismatch",
			message:
				element.type === "video"
					? "Pick a video file to replace this video clip."
					: "Pick an image file to replace this image clip.",
		};
	}

	if (element.type === "image") {
		// Authored timeline duration, not source time: preserve everything.
		return {
			ok: true,
			patch: { mediaId: asset.id, name: asset.name },
			clamped: false,
		};
	}

	const sourceDurationTicks = sourceTicksForAsset({ asset });
	if (sourceDurationTicks <= 0) {
		return {
			ok: false,
			reason: "unknown-source-duration",
			message: "This file has no readable duration, so it can't replace the clip.",
		};
	}

	const rate = rateForElement({ element });
	const consumedSourceTicks = Math.round(element.duration * rate);
	const requestedEnd = element.trimStart + consumedSourceTicks;

	if (requestedEnd <= sourceDurationTicks) {
		return {
			ok: true,
			patch: {
				mediaId: asset.id,
				name: asset.name,
				sourceDuration: sourceDurationTicks,
			},
			clamped: false,
		};
	}

	const startFits = element.trimStart < sourceDurationTicks;
	const trimStart = startFits ? element.trimStart : ZERO_MEDIA_TIME;
	const availableSourceTicks = subMediaTime({
		a: sourceDurationTicks,
		b: mediaTime({ ticks: trimStart }),
	});
	const clampedDuration = mediaTime({
		ticks: Math.max(
			0,
			Math.round(
				getTimelineDurationForSourceSpan({
					sourceSpan: availableSourceTicks,
					retime: "retime" in element ? element.retime : undefined,
				}),
			),
		),
	});

	const clamp: ReplaceMediaClampPreview = {
		trimStartTicks: trimStart,
		durationTicks: clampedDuration,
		clampedFromStart: !startFits,
	};

	if (clampedDuration <= 0) {
		return {
			ok: false,
			reason: "source-too-short",
			message: "This file is too short to replace the clip.",
			clamp,
		};
	}

	if (!allowClamp) {
		return {
			ok: false,
			reason: "source-too-short",
			message: "The new file is shorter than this clip's trimmed range.",
			clamp,
		};
	}

	return {
		ok: true,
		clamped: true,
		patch: {
			mediaId: asset.id,
			name: asset.name,
			sourceDuration: sourceDurationTicks,
			trimStart,
			duration: clampedDuration,
			trimEnd: ZERO_MEDIA_TIME,
		},
	};
}

/**
 * The element fields a replacement must not disturb. Kept as a value (not just
 * prose) so the contract is executable: tests diff these keys before/after.
 */
export const REPLACE_CLIP_PRESERVED_KEYS = [
	"id",
	"type",
	"startTime",
	"params",
	"effects",
	"masks",
	"animations",
	"hidden",
	"isSourceAudioEnabled",
	"retime",
] as const;
