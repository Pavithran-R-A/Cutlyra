import type { EffectDefinition } from "@/effects/types";
import {
	CHROMA_KEY_EFFECT_TYPE,
	DEFAULT_CHROMA_KEY,
	chromaKeyFromParams,
	chromaKeyUniforms,
} from "@/effects/chroma-key";

/**
 * Green-screen removal. Unlike `adjust`/`filter` this pass changes the frame's
 * ALPHA: keyed pixels become transparent, so a lower video/image layer shows
 * through. Both renderers already carry per-layer alpha (the mask pass proved
 * it end to end), which is why this is one additive fragment pass rather than a
 * change to the compositor.
 *
 * The pass runs wherever the clip's effect stack runs, in EDL order, so a
 * chroma key added after an Adjust is evaluated after that Adjust in preview
 * and in the exported MP4 (`ColorGrade.passesForEffect` /
 * `EdlChromaKeyEffect`).
 */
export const chromaKeyEffectDefinition: EffectDefinition = {
	type: CHROMA_KEY_EFFECT_TYPE,
	name: "Chroma key",
	keywords: ["chroma", "green screen", "key", "remove background"],
	params: [
		{
			key: "keyColor",
			label: "Key colour",
			type: "color",
			default: DEFAULT_CHROMA_KEY.keyColor,
			// Keying is a whole-clip property; a keyframed threshold would animate
			// in the preview and sit still in the MP4, so it is not offered.
			keyframable: false,
		},
		{
			key: "similarity",
			label: "Similarity",
			type: "number",
			default: DEFAULT_CHROMA_KEY.similarity,
			min: 0,
			max: 100,
			step: 1,
			keyframable: false,
		},
		{
			key: "softness",
			label: "Edge softness",
			type: "number",
			default: DEFAULT_CHROMA_KEY.softness,
			min: 0,
			max: 100,
			step: 1,
			keyframable: false,
		},
		{
			key: "spill",
			label: "Spill reduction",
			type: "number",
			default: DEFAULT_CHROMA_KEY.spill,
			min: 0,
			max: 100,
			step: 1,
			keyframable: false,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams }) => [
			{
				shader: "chroma-key",
				uniforms: { ...chromaKeyUniforms(chromaKeyFromParams(effectParams)) },
			},
		],
	},
};
