import type { EffectDefinition } from "@/effects/types";

/**
 * Derived transition passes.
 *
 * These definitions are NOT user-facing effects: they are registered only so
 * `resolveEffectPasses` can turn the effect instances
 * `deriveTransitionExtras()` attaches to a transition's neighbours into GPU
 * passes. Both mobile and web effect pickers filter `internal` definitions
 * out, and the instances themselves are render-only (never persisted).
 *
 * The two shaders are `transition-wipe` (animated half-plane reveal, alpha
 * discarded on the unrevealed side) and `transition-dip` (mix the frame
 * toward a solid colour). Their WGSL lives in
 * `rust/crates/effects/src/shaders/`; the exporter derives the same passes
 * natively in `EdlWipeEffect` / `EdlDipEffect`, using the SAME progress and
 * softness semantics.
 */
export const TRANSITION_WIPE_EFFECT_TYPE = "transition-wipe";
export const TRANSITION_DIP_EFFECT_TYPE = "transition-dip";

/** Normalised edge width; the shared constant lives in the timeline layer. */
const WIPE_SOFTNESS = 0.01;

export const transitionWipeEffectDefinition: EffectDefinition = {
	type: TRANSITION_WIPE_EFFECT_TYPE,
	name: "Transition Wipe",
	keywords: ["transition", "wipe", "internal"],
	internal: true,
	params: [
		{
			key: "progress",
			label: "Progress",
			type: "number",
			default: 0,
			min: 0,
			max: 1,
			step: 0.001,
		},
		{
			key: "directionX",
			label: "Direction X",
			type: "number",
			default: -1,
			min: -1,
			max: 1,
			step: 1,
		},
		{
			key: "directionY",
			label: "Direction Y",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 1,
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: WIPE_SOFTNESS,
			min: 0,
			max: 0.2,
			step: 0.001,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const read = ({ key, fallback }: { key: string; fallback: number }): number => {
				const value = effectParams[key];
				return typeof value === "number" && Number.isFinite(value) ? value : fallback;
			};
			return [
				{
					shader: "transition-wipe",
					uniforms: {
						u_progress: read({ key: "progress", fallback: 0 }),
						u_direction: [
							read({ key: "directionX", fallback: -1 }),
							read({ key: "directionY", fallback: 0 }),
						],
						u_softness: Math.max(read({ key: "softness", fallback: WIPE_SOFTNESS }), 0.0001),
					},
				},
			];
		},
	},
};

export const transitionDipEffectDefinition: EffectDefinition = {
	type: TRANSITION_DIP_EFFECT_TYPE,
	name: "Transition Dip",
	keywords: ["transition", "dip", "internal"],
	internal: true,
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 0,
			min: 0,
			max: 1,
			step: 0.001,
		},
		{
			/** 0 = dip through black, 1 = dip through white. */
			key: "white",
			label: "White",
			type: "number",
			default: 0,
			min: 0,
			max: 1,
			step: 1,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => {
			const read = ({ key, fallback }: { key: string; fallback: number }): number => {
				const value = effectParams[key];
				return typeof value === "number" && Number.isFinite(value) ? value : fallback;
			};
			const white = read({ key: "white", fallback: 0 }) > 0.5 ? 1 : 0;
			return [
				{
					shader: "transition-dip",
					uniforms: {
						u_amount: read({ key: "amount", fallback: 0 }),
						u_colour: [white, white, white],
					},
				},
			];
		},
	},
};
