import type { EffectDefinition } from "@/effects/types";
import {
	colorGradeFromFilter,
	colorGradeUniforms,
	isNeutralColorGrade,
} from "@/effects/color-grade";

/**
 * M8 "Filters" panel — corpus `04` §3.7: "categorized [filters], plus...
 * an intensity slider." Filters are modeled as ONE effect instance per
 * element (matches how CapCut's own panel behaves: picking a new preset
 * replaces the current filter rather than stacking a second one) carrying
 * a `preset` selector plus an `intensity` slider.
 *
 * Preset set is a small curated local list, NOT a CapCut category taxonomy
 * clone — corpus 04 §7 item 7 flags the mobile/desktop category lists as
 * conflicting and low-confidence, and corpus 04 §3.8 confirms "CapCut
 * mobile cannot import custom LUTs," so there is no LUT-import surface to
 * replicate. Zero-cost/local-first: no remote filter packs, no CDN.
 *
 * GitHub #48: presets are no longer a no-op. Each preset is authored as a
 * `ColorGrade` in `effects/color-grade.ts` (affine adjustments only, so the
 * same numbers reach Android's native exporter), scaled by `intensity`, and
 * resolved through the SAME `color-adjust` shader pass the Adjust panel uses.
 * The panel therefore changes pixels in preview AND in export.
 */
export const FILTER_EFFECT_TYPE = "filter";

export const FILTER_PRESETS = [
	{ value: "none", label: "None" },
	{ value: "vivid", label: "Vivid" },
	{ value: "mono", label: "Mono" },
	{ value: "vintage", label: "Vintage" },
	{ value: "cool", label: "Cool" },
	{ value: "warm", label: "Warm" },
	{ value: "cinematic", label: "Cinematic" },
] as const;

export const filterEffectDefinition: EffectDefinition = {
	type: FILTER_EFFECT_TYPE,
	name: "Filter",
	keywords: ["filter", "preset", "grade", "look"],
	params: [
		{
			key: "preset",
			label: "Preset",
			type: "select",
			default: "none",
			options: [...FILTER_PRESETS],
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 100,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const grade = colorGradeFromFilter(effectParams);
			if (isNeutralColorGrade(grade)) return [];
			return [{ shader: "color-adjust", uniforms: colorGradeUniforms(grade) }];
		},
	},
};
