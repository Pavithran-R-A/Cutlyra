/**
 * Generates `apps/mobile/android/app/src/test/resources/color-grade-fixtures.json`
 * — the shared fixtures that pin Kotlin's `ColorGrade` to the TypeScript model.
 * Run: bun run scripts/generate-color-grade-fixtures.ts
 */
import {
	NEUTRAL_COLOR_GRADE,
	colorGradeFromAdjust,
	colorGradeFromFilter,
	colorGradeRgbMatrix,
	unsupportedNativeColorGradeParams,
	type ColorGrade,
} from "../packages/editor-core/src/effects/color-grade";

const GRADES: Array<{ name: string; grade: ColorGrade }> = [
	{ name: "neutral", grade: NEUTRAL_COLOR_GRADE },
	{ name: "brightness-up", grade: { ...NEUTRAL_COLOR_GRADE, brightness: 50 } },
	{ name: "brightness-down", grade: { ...NEUTRAL_COLOR_GRADE, brightness: -60 } },
	{ name: "contrast-up", grade: { ...NEUTRAL_COLOR_GRADE, contrast: 80 } },
	{ name: "contrast-down", grade: { ...NEUTRAL_COLOR_GRADE, contrast: -45 } },
	{ name: "desaturate", grade: { ...NEUTRAL_COLOR_GRADE, saturation: -100 } },
	{ name: "saturate", grade: { ...NEUTRAL_COLOR_GRADE, saturation: 60 } },
	{ name: "warm", grade: { ...NEUTRAL_COLOR_GRADE, temperature: 70, tint: -40 } },
	{
		name: "kitchen-sink",
		grade: {
			...NEUTRAL_COLOR_GRADE,
			brightness: 17,
			contrast: -45,
			saturation: 33,
			temperature: -22,
			tint: 9,
		},
	},
	{ name: "sharpen-only", grade: { ...NEUTRAL_COLOR_GRADE, sharpen: 40 } },
	{ name: "vignette-only", grade: { ...NEUTRAL_COLOR_GRADE, vignette: 40 } },
];

const COLORS: Array<[number, number, number]> = [
	[0, 0, 0],
	[1, 1, 1],
	[0.5, 0.5, 0.5],
	[0.2, 0.4, 0.6],
	[0.9, 0.1, 0.3],
	[0.05, 0.05, 0.05],
	[1, 0.87, 0.13],
];

function applyMatrix(m: number[], rgb: [number, number, number]): [number, number, number] {
	return [
		m[0] * rgb[0] + m[4] * rgb[1] + m[8] * rgb[2] + m[12],
		m[1] * rgb[0] + m[5] * rgb[1] + m[9] * rgb[2] + m[13],
		m[2] * rgb[0] + m[6] * rgb[1] + m[10] * rgb[2] + m[14],
	];
}

const cases = GRADES.map(({ name, grade }) => {
	const matrix = colorGradeRgbMatrix(grade);
	return {
		name,
		grade,
		unsupported: unsupportedNativeColorGradeParams(grade),
		matrix,
		samples: COLORS.map((rgb) => ({ rgb, out: applyMatrix(matrix, rgb) })),
	};
});

const presets = ["none", "vivid", "mono", "vintage", "cool", "warm", "cinematic"].flatMap(
	(preset) =>
		[0, 50, 100].map((intensity) => ({
			preset,
			intensity,
			grade: colorGradeFromFilter({ preset, intensity }),
		})),
);

const adjustSample = colorGradeFromAdjust({
	brightness: 10,
	contrast: -20,
	saturation: 30,
	temperature: -40,
	tint: 50,
	sharpen: 60,
	vignette: 70,
});

const fixture = { cases, presets, adjustSample };
const out = JSON.stringify(fixture, null, "\t");
const target =
	"apps/mobile/android/app/src/test/resources/color-grade-fixtures.json";
await Bun.write(target, `${out}\n`);
console.log(`wrote ${target}`);
