/**
 * Chroma key — THE shared model. One set of parameter units and one distance
 * formula, read by:
 *
 *   - the preview's wgpu pass (`rust/crates/effects/src/shaders/chroma_key.wgsl`,
 *     shader id `chroma-key`), uniforms built by `chromaKeyUniforms()` below;
 *   - the Android exporter's Media3 GL pass (`EdlChromaKeyEffect.kt`), whose
 *     numbers come from `ChromaKeyMath.kt` — a line-for-line port of this file;
 *   - the EDL validator (`edl/validate.ts`), which reads the same ranges.
 *
 * Nothing here is a preview-only knob: every field is carried in the clip's
 * EDL `effects[]` entry, so an export either renders it or refuses the clip.
 *
 * COLOUR SPACE. The distance is measured on the Cb/Cr plane (Rec.709), not in
 * RGB. A green screen is not one colour — it is lit unevenly, so its RGB
 * changes a lot while its chroma barely moves. Comparing chroma keeps a shadow
 * on the screen keyed out while the subject's skin tones (which sit at a very
 * different chroma angle) survive.
 *
 * DISTANCE SCALE. Rec.709 chroma for a fully saturated primary is about 0.54
 * from neutral, so `MAX_CHROMA_DISTANCE = 0.6` lets `similarity: 100` swallow
 * every colour while the default 30 keys only colours within 0.18 of the key.
 */

export const CHROMA_KEY_EFFECT_TYPE = "chroma-key";

/** A chroma key in panel units. `keyColor` is `#rrggbb`. */
export interface ChromaKey {
	keyColor: string;
	/** 0..100 — how far from the key colour still counts as background. */
	similarity: number;
	/** 0..100 — width of the soft edge, in the same distance units. */
	softness: number;
	/** 0..100 — how much green/magenta fringe is desaturated on kept pixels. */
	spill: number;
}

/** Green screen default (the shade most consumer keying starts from). */
export const DEFAULT_CHROMA_KEY: ChromaKey = {
	keyColor: "#00b140",
	similarity: 30,
	softness: 8,
	spill: 60,
};

/**
 * Largest Cb/Cr distance the similarity slider can reach. Derived above:
 * a saturated primary is ~0.54 away from neutral on this plane.
 */
export const MAX_CHROMA_DISTANCE = 0.6;

/** Rec.709 luma weights, matching `color_adjust.wgsl` and `ChromaKeyMath.kt`. */
export const CHROMA_LUMA_R = 0.2126;
export const CHROMA_LUMA_G = 0.7152;
export const CHROMA_LUMA_B = 0.0722;

/** Rec.709 chroma scaling constants (BT.709 Kr/Kb derived). */
export const CHROMA_CB_SCALE = 1.8556;
export const CHROMA_CR_SCALE = 1.5748;

/** The uniform keys the preview pass and the Android pass both understand. */
export interface ChromaKeyUniforms {
	u_key: number[];
	u_similarity: number;
	u_softness: number;
	u_spill: number;
}

function clampPanel(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, value));
}

/** `#rrggbb` (or `#rgb`) -> linear-ish 0..1 RGB. Invalid input = the default
 *  green, which is what the panels show and what the key was authored for. */
export function parseHexColor(hex: unknown): [number, number, number] {
	// `#00b140` decomposed exactly, so it equals `parseHexColor` of the default.
	const fallback: [number, number, number] = [0, 177 / 255, 64 / 255];
	if (typeof hex !== "string") return fallback;
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return fallback;
	const digits =
		match[1].length === 3
			? match[1]
					.split("")
					.map((c) => c + c)
					.join("")
			: match[1];
	const value = Number.parseInt(digits, 16);
	return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** The clip's effect params -> a ChromaKey in panel units. */
export function chromaKeyFromParams(
	params: Record<string, unknown> | undefined,
): ChromaKey {
	return {
		keyColor:
			typeof params?.keyColor === "string" && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(params.keyColor)
				? (params.keyColor.startsWith("#") ? params.keyColor : `#${params.keyColor}`)
				: DEFAULT_CHROMA_KEY.keyColor,
		similarity: clampPanel(params?.similarity, DEFAULT_CHROMA_KEY.similarity),
		softness: clampPanel(params?.softness, DEFAULT_CHROMA_KEY.softness),
		spill: clampPanel(params?.spill, DEFAULT_CHROMA_KEY.spill),
	};
}

function chromaOf(rgb: [number, number, number]): [number, number] {
	const luma = CHROMA_LUMA_R * rgb[0] + CHROMA_LUMA_G * rgb[1] + CHROMA_LUMA_B * rgb[2];
	return [(rgb[2] - luma) / CHROMA_CB_SCALE, (rgb[0] - luma) / CHROMA_CR_SCALE];
}

/**
 * Shader units for the `chroma-key` pass. `u_key` is the key colour's RGB,
 * `u_similarity`/`u_softness` are distances on the Cb/Cr plane and `u_spill` is
 * a 0..1 mix. Exactly these four values are what `chroma_key.wgsl` and
 * `EdlChromaKeyEffect` read, so there is no second mapping to drift.
 */
export function chromaKeyUniforms(key: ChromaKey): ChromaKeyUniforms {
	return {
		u_key: [...parseHexColor(key.keyColor)],
		u_similarity: (key.similarity / 100) * MAX_CHROMA_DISTANCE,
		u_softness: (key.softness / 100) * MAX_CHROMA_DISTANCE,
		u_spill: key.spill / 100,
	};
}

/**
 * The shader's alpha for one pixel — the reference implementation the WGSL and
 * GLSL passes mirror. Kept in TypeScript so the unit test can pin the
 * thresholds (centre keys out, subject survives, the edge ramps) without a GPU,
 * and so the Android JVM test has a generated table to compare against.
 */
export function chromaKeyAlpha({
	rgb,
	key,
}: {
	rgb: [number, number, number];
	key: ChromaKeyUniforms;
}): number {
	const [keyCb, keyCr] = chromaOf([key.u_key[0], key.u_key[1], key.u_key[2]]);
	const [cb, cr] = chromaOf(rgb);
	const distance = Math.hypot(cb - keyCb, cr - keyCr);
	const edge = Math.max(key.u_softness, 1e-4);
	const t = Math.max(0, Math.min(1, (distance - key.u_similarity) / edge));
	// GLSL/WGSL smoothstep: 3t^2 - 2t^3.
	return t * t * (3 - 2 * t);
}

/** The RGB the spill slider produces for one pixel (green-excess removal). */
export function chromaKeySpillColor({
	rgb,
	spill,
}: {
	rgb: [number, number, number];
	spill: number;
}): [number, number, number] {
	const excess = Math.max(0, rgb[1] - Math.max(rgb[0], rgb[2]));
	const amount = Math.max(0, Math.min(1, spill)) * excess;
	return [rgb[0], Math.max(0, rgb[1] - amount), rgb[2]];
}
