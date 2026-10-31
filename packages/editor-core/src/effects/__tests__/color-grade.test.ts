import { describe, expect, test } from "bun:test";
import {
	FILTER_PRESET_GRADES,
	NEUTRAL_COLOR_GRADE,
	colorGradeFromAdjust,
	colorGradeFromFilter,
	colorGradeRgbMatrix,
	colorGradeUniforms,
	isNeutralColorGrade,
	unsupportedNativeColorGradeParams,
	type ColorGrade,
} from "@/effects/color-grade";

/**
 * GitHub #48 — preview ⇄ export parity contract for the color-grade model.
 *
 * `colorGradeRgbMatrix()` is what Android's exporter multiplies every frame
 * by (`ColorGrade.kt`). It is only correct if it reproduces, exactly, what
 * `color_adjust.wgsl` does per pixel. The reference implementation below is
 * transcribed from that WGSL file LINE BY LINE (and from the uniform mapping
 * in `adjust.ts`), independently of the code under test — if either side
 * changes shape, these tests fail instead of shipping a preview/export
 * mismatch.
 */

/** The uniform mapping documented in adjust.ts / color_adjust.wgsl. */
function referenceUniforms(grade: ColorGrade) {
	return {
		brightness: (grade.brightness / 100) * 0.35,
		contrast: 1 + (grade.contrast / 100) * 0.6,
		saturation: Math.max(0, 1 + grade.saturation / 100),
		temperature: grade.temperature / 100,
		tint: grade.tint / 100,
	};
}

/** Literal transcription of `fragment_main` in color_adjust.wgsl (minus the
 *  sharpen/vignette branches, which native export refuses rather than fakes). */
function wgslGrade({
	rgb,
	grade,
}: {
	rgb: readonly [number, number, number];
	grade: ColorGrade;
}) {
	const u = referenceUniforms(grade);
	let [r, g, b] = rgb;

	// Temperature / tint.
	r += u.temperature * 0.12 + u.tint * 0.05;
	b += -u.temperature * 0.12 + u.tint * 0.05;
	g += -u.tint * 0.1;

	// Brightness, contrast about mid-grey, saturation around luma.
	r += u.brightness;
	g += u.brightness;
	b += u.brightness;
	r = (r - 0.5) * u.contrast + 0.5;
	g = (g - 0.5) * u.contrast + 0.5;
	b = (b - 0.5) * u.contrast + 0.5;
	const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	r = luma + (r - luma) * u.saturation;
	g = luma + (g - luma) * u.saturation;
	b = luma + (b - luma) * u.saturation;

	return [r, g, b] as const;
}

/** media3's fragment shader: `uRgbMatrix * vec4(rgb, 1)`, column-major. */
function applyMatrix({
	m,
	rgb,
}: {
	m: readonly number[];
	rgb: readonly [number, number, number];
}) {
	return [
		m[0] * rgb[0] + m[4] * rgb[1] + m[8] * rgb[2] + m[12],
		m[1] * rgb[0] + m[5] * rgb[1] + m[9] * rgb[2] + m[13],
		m[2] * rgb[0] + m[6] * rgb[1] + m[10] * rgb[2] + m[14],
	] as const;
}

const SAMPLE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0, 0],
	[1, 1, 1],
	[0.5, 0.5, 0.5],
	[0.2, 0.4, 0.6],
	[0.9, 0.1, 0.3],
	[0.05, 0.05, 0.05],
	[1, 0.87, 0.13],
];

const SAMPLE_GRADES: ColorGrade[] = [
	NEUTRAL_COLOR_GRADE,
	{ ...NEUTRAL_COLOR_GRADE, brightness: 50 },
	{ ...NEUTRAL_COLOR_GRADE, brightness: -60 },
	{ ...NEUTRAL_COLOR_GRADE, contrast: 80 },
	{ ...NEUTRAL_COLOR_GRADE, saturation: -100 },
	{ ...NEUTRAL_COLOR_GRADE, saturation: 60 },
	{ ...NEUTRAL_COLOR_GRADE, temperature: 70, tint: -40 },
	{ ...NEUTRAL_COLOR_GRADE, temperature: -100, tint: 100, brightness: 25, contrast: -30 },
	{ ...NEUTRAL_COLOR_GRADE, brightness: 17, contrast: -45, saturation: 33, temperature: -22, tint: 9 },
];

describe("color-grade ⇄ color_adjust.wgsl parity", () => {
	test("the export matrix reproduces the WGSL chain for every sample", () => {
		for (const grade of SAMPLE_GRADES) {
			const m = colorGradeRgbMatrix(grade);
			expect(m.length).toBe(16);
			for (const color of SAMPLE_COLORS) {
				const expected = wgslGrade({ rgb: color, grade });
				const actual = applyMatrix({ m, rgb: color });
				for (let i = 0; i < 3; i++) {
					expect(Math.abs(actual[i] - expected[i])).toBeLessThan(1e-6);
				}
			}
		}
	});

	test("a neutral grade is the identity matrix", () => {
		const m = colorGradeRgbMatrix(NEUTRAL_COLOR_GRADE);
		const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		for (let i = 0; i < 16; i++) expect(Math.abs(m[i] - identity[i])).toBeLessThan(1e-12);
	});

	test("uniforms match adjust.ts's documented mapping exactly", () => {
		const u = colorGradeUniforms({
			brightness: 50,
			contrast: -25,
			saturation: 80,
			temperature: 40,
			tint: -10,
			sharpen: 60,
			vignette: 30,
		});
		expect(u.u_brightness).toBeCloseTo(0.175, 10);
		expect(u.u_contrast).toBeCloseTo(0.85, 10);
		expect(u.u_saturation).toBeCloseTo(1.8, 10);
		expect(u.u_temperature).toBeCloseTo(0.4, 10);
		expect(u.u_tint).toBeCloseTo(-0.1, 10);
		expect(u.u_sharpen).toBeCloseTo(0.6, 10);
		expect(u.u_vignette).toBeCloseTo(0.3, 10);
	});
});

describe("unsupported native params are named, never silently dropped", () => {
	test("affine-only grades are fully supported", () => {
		expect(
			unsupportedNativeColorGradeParams({
				...NEUTRAL_COLOR_GRADE,
				brightness: 40,
				contrast: -20,
				saturation: 15,
				temperature: 30,
				tint: -5,
			}),
		).toEqual([]);
	});

	test("sharpen and vignette are reported as not-yet-mapped", () => {
		expect(
			unsupportedNativeColorGradeParams({ ...NEUTRAL_COLOR_GRADE, sharpen: 40 }),
		).toEqual(["sharpen"]);
		expect(
			unsupportedNativeColorGradeParams({ ...NEUTRAL_COLOR_GRADE, vignette: 40 }),
		).toEqual(["vignette"]);
		expect(
			unsupportedNativeColorGradeParams({ ...NEUTRAL_COLOR_GRADE, sharpen: 1, vignette: 1 }),
		).toEqual(["sharpen", "vignette"]);
	});
});

describe("filter presets resolve to grades both renderers share", () => {
	test("none / missing / unknown presets are neutral", () => {
		expect(colorGradeFromFilter({ preset: "none" })).toEqual(NEUTRAL_COLOR_GRADE);
		expect(colorGradeFromFilter(undefined)).toEqual(NEUTRAL_COLOR_GRADE);
		expect(colorGradeFromFilter({ preset: "does-not-exist" })).toEqual(NEUTRAL_COLOR_GRADE);
	});

	test("every non-none preset produces a NON-neutral, affine-only grade", () => {
		for (const value of Object.keys(FILTER_PRESET_GRADES)) {
			if (value === "none") continue;
			const grade = colorGradeFromFilter({ preset: value });
			expect(isNeutralColorGrade(grade)).toBe(false);
			expect(unsupportedNativeColorGradeParams(grade)).toEqual([]);
		}
	});

	test("intensity scales the preset toward neutral (0 = neutral, 100 = full)", () => {
		const full = colorGradeFromFilter({ preset: "vivid", intensity: 100 });
		const half = colorGradeFromFilter({ preset: "vivid", intensity: 50 });
		const none = colorGradeFromFilter({ preset: "vivid", intensity: 0 });
		expect(half.saturation).toBeCloseTo(full.saturation / 2, 10);
		expect(half.contrast).toBeCloseTo(full.contrast / 2, 10);
		expect(isNeutralColorGrade(none)).toBe(true);
		// Missing intensity behaves like the panel default of 100.
		expect(colorGradeFromFilter({ preset: "vivid" })).toEqual(full);
	});

	test("mono actually zeroes saturation", () => {
		const grade = colorGradeFromFilter({ preset: "mono", intensity: 100 });
		expect(grade.saturation).toBe(-100);
		for (const color of SAMPLE_COLORS) {
			const [r, g, b] = wgslGrade({ rgb: color, grade });
			expect(Math.abs(r - g)).toBeLessThan(1e-6);
			expect(Math.abs(g - b)).toBeLessThan(1e-6);
		}
	});
});

describe("adjust params flow from panel units", () => {
	test("reads the seven sliders and defaults non-finite/absent to 0", () => {
		expect(
			colorGradeFromAdjust({
				brightness: 10,
				contrast: -20,
				saturation: 30,
				temperature: -40,
				tint: 50,
				sharpen: 60,
				vignette: 70,
			}),
		).toEqual({
			brightness: 10,
			contrast: -20,
			saturation: 30,
			temperature: -40,
			tint: 50,
			sharpen: 60,
			vignette: 70,
		});
		expect(colorGradeFromAdjust({ brightness: Number.NaN })).toEqual(NEUTRAL_COLOR_GRADE);
		expect(colorGradeFromAdjust(undefined)).toEqual(NEUTRAL_COLOR_GRADE);
	});
});
