export const BACKGROUND_BLUR_INTENSITY_PRESETS: Array<{
	label: string;
	value: number;
}> = [
	{ label: "Light", value: 100 },
	{ label: "Medium", value: 200 },
	{ label: "Heavy", value: 500 },
] as const;

export const DEFAULT_BACKGROUND_BLUR_INTENSITY = 10;

/**
 * Background-blur intensity is a UNITLESS value the UI exposes directly:
 * 0 = off, 500 = heaviest. Preview and the Android exporter convert it with
 * this ONE formula (mirrored by `BackgroundBlurMath.kt` and pinned on both
 * sides by tests using the same fixtures), so the two cannot drift.
 */
export const BACKGROUND_BLUR_INTENSITY_MIN = 0;
export const BACKGROUND_BLUR_INTENSITY_MAX = 500;
export const BACKGROUND_BLUR_SIGMA_DIVISOR = 5;
export const BACKGROUND_BLUR_REFERENCE_WIDTH = 1920;
export const BACKGROUND_BLUR_REFERENCE_HEIGHT = 1080;

export function backgroundBlurSigma({
	intensity,
	width,
	height,
}: {
	intensity: number;
	width: number;
	height: number;
}): { sigmaX: number; sigmaY: number } {
	const safeIntensity = Number.isFinite(intensity)
		? Math.min(
				BACKGROUND_BLUR_INTENSITY_MAX,
				Math.max(BACKGROUND_BLUR_INTENSITY_MIN, intensity),
			)
		: 0;
	const base = safeIntensity / BACKGROUND_BLUR_SIGMA_DIVISOR;
	return {
		sigmaX: base * (width / BACKGROUND_BLUR_REFERENCE_WIDTH),
		sigmaY: base * (height / BACKGROUND_BLUR_REFERENCE_HEIGHT),
	};
}
