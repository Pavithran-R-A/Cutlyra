import { describe, expect, it } from "bun:test";
import {
	BACKGROUND_BLUR_INTENSITY_MAX,
	BACKGROUND_BLUR_INTENSITY_MIN,
	backgroundBlurSigma,
} from "../blur";

/**
 * Fixtures mirror `BackgroundBlurMathTest.kt` exactly. Both sides assert the
 * same numbers, so the preview and the Android exporter cannot drift apart on
 * background-blur intensity.
 */
describe("backgroundBlurSigma", () => {
	it("matches the exporter at 1280x720 for intensity 200", () => {
		const sigma = backgroundBlurSigma({ intensity: 200, width: 1280, height: 720 });
		expect(sigma.sigmaX).toBeCloseTo(26.666667, 5);
		expect(sigma.sigmaY).toBeCloseTo(26.666667, 5);
	});

	it("clamps to the UI range", () => {
		expect(backgroundBlurSigma({ intensity: 9999, width: 1920, height: 1080 }).sigmaX)
			.toBeCloseTo((BACKGROUND_BLUR_INTENSITY_MAX / 5) * 1, 5);
		expect(backgroundBlurSigma({ intensity: -5, width: 1920, height: 1080 }).sigmaX)
			.toBe(BACKGROUND_BLUR_INTENSITY_MIN);
		expect(backgroundBlurSigma({ intensity: Number.NaN, width: 1920, height: 1080 }).sigmaX)
			.toBe(0);
	});

	it("scales with resolution like the exporter", () => {
		const portrait = backgroundBlurSigma({ intensity: 400, width: 720, height: 1280 });
		expect(portrait.sigmaX).toBeCloseTo((400 / 5) * (720 / 1920), 5);
		expect(portrait.sigmaY).toBeCloseTo((400 / 5) * (1280 / 1080), 5);
	});
});
