import type { FrameRate } from "opencut-wasm";

/**
 * Export frame-rate contract (GitHub #21 / Linear PAV-71).
 *
 * The whole source-to-output FPS path is:
 *
 *   FPS_OPTIONS (here) → export sheet → `setProjectFps` (project settings)
 *     → `buildEdl({ output.fps })` → `Edl.output.fps` (rational)
 *     → `EdlToComposition` declares `EditedMediaItem.setFrameRate` for every
 *       visual item.
 *
 * media3 1.11.0's own source (verified at tag 1.11.0,
 * `SequenceRenderersFactory.TargetFrameRateHelper`) defines what that
 * declaration means, and it is deliberately asymmetric:
 *
 *   - footage AT OR ABOVE the selection is capped (frames dropped to the
 *     selected rate, on every API level Cutlyra supports);
 *   - footage BELOW the selection is NOT upscaled — media3 has no
 *     frame-duplication primitive ("This algorithm has no impact if the
 *     target frame rate is greater [than] input frame rate").
 *
 * `describeFrameRateCapability` turns the second bullet into the pre-export
 * warning the issue demands ("warn accurately before export and use an
 * explicit supported fallback (not silent 30 FPS)"): the fallback IS the
 * clip's own rate, stated before the user spends an export on it.
 */

export interface FpsOption {
	id: string;
	label: string;
	fps: FrameRate;
}

export const FPS_OPTIONS: readonly FpsOption[] = [
	{ id: "24", label: "24", fps: { numerator: 24, denominator: 1 } },
	{ id: "25", label: "25", fps: { numerator: 25, denominator: 1 } },
	{ id: "30", label: "30", fps: { numerator: 30, denominator: 1 } },
	{ id: "60", label: "60", fps: { numerator: 60, denominator: 1 } },
];

/**
 * The sheet's frame-rate control must start on the PROJECT's own rate, not a
 * hardcoded "30": `applyFps` persists the selection into project settings, so
 * a reopened sheet that defaulted to 30 would silently export a 60-fps
 * project at 30 — an untouched sheet quietly overriding the user's earlier
 * choice is exactly the class of defect PAV-71 is about. NTSC rates resolve
 * to their nearest whole option (29.97 → 30, 23.976 → 24, 59.94 → 60).
 */
export function nearestFpsOptionId({
	fps,
	options = FPS_OPTIONS,
}: {
	fps: FrameRate;
	options?: readonly FpsOption[];
}): string {
	const value = fps.numerator / fps.denominator;
	let bestId = options[0]?.id ?? "30";
	let bestDelta = Number.POSITIVE_INFINITY;
	for (const option of options) {
		const delta = Math.abs(option.fps.numerator / option.fps.denominator - value);
		if (delta < bestDelta) {
			bestId = option.id;
			bestDelta = delta;
		}
	}
	return bestId;
}

/** One video clip's effective output frame rate on the exported timeline. */
export interface VideoSourceRate {
	/** The asset's probed source frame rate; undefined when unknown. */
	fps?: number;
	/** The clip's retime rate (2 = double speed → double the emitted rate). */
	retimeRate?: number;
}

const EPSILON_FPS = 0.01;

function formatFpsLabel(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The honest pre-export capability note. Returns `null` when the selection is
 * fully achievable (every used video clip is at or above it, or there are no
 * video clips at all — stills, text and captions are synthesized at the
 * selected rate and never limit it).
 *
 * When some clip is slower, the note states the exact fallback: that clip
 * keeps its own rate, so the MP4's frame rate varies. Sources whose fps is
 * unknown are skipped rather than guessed — an unknown must not become a
 * claim in either direction.
 */
export function describeFrameRateCapability({
	requested,
	label,
	sources,
}: {
	requested: FrameRate;
	label: string;
	sources: readonly VideoSourceRate[];
}): string | null {
	const requestedFps = requested.numerator / requested.denominator;
	let slowest: number | null = null;
	let slowCount = 0;
	for (const source of sources) {
		if (source.fps === undefined || !Number.isFinite(source.fps) || source.fps <= 0) continue;
		const retime = source.retimeRate ?? 1;
		const effective = source.fps * (retime > 0 ? retime : 1);
		if (effective < requestedFps - EPSILON_FPS) {
			slowCount += 1;
			if (slowest === null || effective < slowest) slowest = effective;
		}
	}
	if (slowest === null) return null;
	const slowestLabel = formatFpsLabel(slowest);
	return (
		`${label} FPS is a maximum: footage at or above it is capped to it. ` +
		`${slowCount} clip(s) below that (slowest ${slowestLabel} FPS) keep their own frame rate — ` +
		`Cutlyra does not duplicate frames — so the exported file's frame rate varies. ` +
		`Stills, text and captions always follow ${label} FPS.`
	);
}
