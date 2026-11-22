/**
 * Per-clip audio fades — the engine's single source of truth for the
 * `fadeIn` / `fadeOut` params and the gain envelope the EDL carries.
 *
 * Units: the params are SECONDS (the unit the fade sliders and the fade
 * length read naturally in; the engine has no other duration param, and
 * transition durations are authored in seconds too). The EDL envelope is
 * TICKS, converted once here — never in a mapper — so preview, EDL and the
 * Android/iOS exporters cannot disagree about where a ramp starts.
 *
 * Everything in this module is pure and dependency-free apart from the tick
 * constant, which is what makes the ramp shape testable without a canvas,
 * a decoder or an editor instance.
 */

import type { ParamValues } from "@/params";
import { TICKS_PER_SECOND } from "@/wasm/media-time";

export const AUDIO_FADE_IN_PARAM_KEY = "fadeIn";
export const AUDIO_FADE_OUT_PARAM_KEY = "fadeOut";

export interface AudioFadeSeconds {
	fadeIn: number;
	fadeOut: number;
}

export interface AudioFadeEnvelope {
	/** Ramp-up length at the clip's start, in TICKS OF THE CLIP'S TIMELINE
	 *  SPAN (`EdlClip.durationTicks`), not source ticks. */
	inTicks: number;
	/** Ramp-down length at the clip's end, same unit. */
	outTicks: number;
}

function sanitizeSeconds({ value }: { value: number }): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value;
}

function clamp({ value, min, max }: { value: number; min: number; max: number }): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Fade lengths that fit inside `duration`: each is clamped to the clip's own
 * length, and when the two together exceed it they are scaled down
 * PROPORTIONALLY rather than one being dropped — a clip with 1s in + 1s out
 * on a 1s clip keeps both, at 0.5s each.
 */
export function clampAudioFades({
	fadeIn,
	fadeOut,
	duration,
}: {
	fadeIn: number;
	fadeOut: number;
	duration: number;
}): AudioFadeSeconds {
	const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
	let clampedIn = clamp({ value: sanitizeSeconds({ value: fadeIn }), min: 0, max: total });
	let clampedOut = clamp({ value: sanitizeSeconds({ value: fadeOut }), min: 0, max: total });
	const sum = clampedIn + clampedOut;
	if (sum > total && sum > 0) {
		const scale = total / sum;
		clampedIn *= scale;
		clampedOut *= scale;
	}
	return { fadeIn: clampedIn, fadeOut: clampedOut };
}

/** Reads the two params, ignoring anything that is not a positive number.
 *  Existing projects have neither key, so both resolve to 0 (no fade). */
export function readAudioFadeSeconds({ params }: { params: ParamValues }): AudioFadeSeconds {
	const rawIn = params[AUDIO_FADE_IN_PARAM_KEY];
	const rawOut = params[AUDIO_FADE_OUT_PARAM_KEY];
	return {
		fadeIn: typeof rawIn === "number" ? sanitizeSeconds({ value: rawIn }) : 0,
		fadeOut: typeof rawOut === "number" ? sanitizeSeconds({ value: rawOut }) : 0,
	};
}

/**
 * The EDL envelope for a clip, or `null` when the clip has no fade at all.
 *
 * `null` is load-bearing: the field is omitted from the EDL in that case, so
 * an unfaded project produces a byte-identical descriptor to before this
 * feature existed and every exporter's "no envelope" path stays exactly the
 * old code path.
 */
export function buildAudioFadeEnvelope({
	params,
	durationTicks,
	ticksPerSecond = TICKS_PER_SECOND,
}: {
	params: ParamValues;
	durationTicks: number;
	ticksPerSecond?: number;
}): AudioFadeEnvelope | null {
	if (!Number.isFinite(durationTicks) || durationTicks <= 0 || ticksPerSecond <= 0) {
		return null;
	}
	const seconds = readAudioFadeSeconds({ params });
	const clamped = clampAudioFades({
		fadeIn: seconds.fadeIn,
		fadeOut: seconds.fadeOut,
		duration: durationTicks / ticksPerSecond,
	});
	const inTicks = Math.round(clamped.fadeIn * ticksPerSecond);
	const outTicks = Math.round(clamped.fadeOut * ticksPerSecond);
	if (inTicks <= 0 && outTicks <= 0) return null;
	return { inTicks, outTicks };
}

/**
 * The params patch the Edit panel writes: the two fade lengths, clamped
 * against the clip's own duration by the same rule the EDL uses. Shared so the
 * slider, the resolver and the exporter can never disagree about the clamp.
 * Rounded to milliseconds: the stored value is what the slider shows, not
 * floating-point dust from the proportional scaling.
 */
export function buildAudioFadeParamsPatch({
	params,
	durationTicks,
	ticksPerSecond = TICKS_PER_SECOND,
}: {
	params: ParamValues;
	durationTicks: number;
	ticksPerSecond?: number;
}): ParamValues {
	const seconds = readAudioFadeSeconds({ params });
	const clamped = clampAudioFades({
		fadeIn: seconds.fadeIn,
		fadeOut: seconds.fadeOut,
		duration: durationTicks / ticksPerSecond,
	});
	return {
		[AUDIO_FADE_IN_PARAM_KEY]: Math.round(clamped.fadeIn * 1000) / 1000,
		[AUDIO_FADE_OUT_PARAM_KEY]: Math.round(clamped.fadeOut * 1000) / 1000,
	};
}

/**
 * Linear gain at `timeTicks` into a clip, given its envelope — the exact
 * shape the Kotlin `AudioFadeMath` implements per sample. Both sides ramp
 * linearly from 0 to unity; where the two ramps would meet, the smaller
 * gain wins (a min, not a sum), so a clip that is almost all fade dips to
 * silence at the crossing instead of overshooting.
 */
export function audioFadeGainAt({
	timeTicks,
	durationTicks,
	envelope,
}: {
	timeTicks: number;
	durationTicks: number;
	envelope: AudioFadeEnvelope;
}): number {
	if (durationTicks <= 0) return 1;
	const time = clamp({ value: timeTicks, min: 0, max: durationTicks });
	const fadeInGain =
		envelope.inTicks > 0 ? clamp({ value: time / envelope.inTicks, min: 0, max: 1 }) : 1;
	const fadeOutGain =
		envelope.outTicks > 0
			? clamp({ value: (durationTicks - time) / envelope.outTicks, min: 0, max: 1 })
			: 1;
	return Math.min(fadeInGain, fadeOutGain);
}
