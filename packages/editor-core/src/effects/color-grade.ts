/**
 * GitHub #48 / Linear PAV-142 — THE shared color-grade model.
 *
 * Before this file existed there were two unrelated half-implementations of
 * "make a clip look different":
 *
 *   - preview: `adjust.ts` built `color-adjust` shader uniforms (WGSL:
 *     `rust/crates/effects/src/shaders/color_adjust.wgsl`), while `filter.ts`
 *     built NOTHING (`buildPasses: () => []`) — a filter changed no pixels at
 *     all, preview or export;
 *   - Android export: `EdlToComposition.buildEditedMediaItem` threw
 *     `ExportUnsupportedException` for ANY non-empty `EdlClip.effects`, so a
 *     single Adjust slider change made the whole export fail.
 *
 * This module is the single source of truth both sides read:
 *
 *   - `colorGradeUniforms()`  -> the exact numbers `adjust`/`filter` feed the
 *     preview's `color-adjust` pass (byte-for-byte the mapping `adjust.ts`
 *     shipped before, so existing preview behaviour is unchanged);
 *   - `colorGradeRgbMatrix()` -> the mathematically equivalent 4x4 matrix the
 *     Android exporter applies through media3's `RgbMatrix` (see
 *     `ColorGradeEffect.kt`), composed so that temp/tint -> brightness ->
 *     contrast -> saturation land in the SAME order the WGSL fragment shader
 *     applies them.
 *
 * Every value here is in the PANELS' user-facing units (the slider ranges in
 * `adjust-panel.tsx`: -100..100, or 0..100 for sharpen/vignette), never in
 * shader units — shader units are derived, in one place, below.
 *
 * SCOPE (GitHub #48): brightness, contrast, saturation, temperature, tint and
 * the filter presets are mapped for native export because they are all
 * AFFINE per-channel operations (one 4x4 matrix). `sharpen` (neighbour
 * sampling) and `vignette` (position-varying) are not, and are deliberately
 * NOT faked — `unsupportedNativeColorGradeParams()` names them so the
 * exporter can refuse loudly instead of silently dropping a real edit.
 */

/** A grade in panel/slider units. All fields default to 0 (neutral). */
export interface ColorGrade {
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number;
	tint: number;
	sharpen: number;
	vignette: number;
}

export const NEUTRAL_COLOR_GRADE: ColorGrade = {
	brightness: 0,
	contrast: 0,
	saturation: 0,
	temperature: 0,
	tint: 0,
	sharpen: 0,
	vignette: 0,
};

/** The params Android's native exporter can express (affine, one matrix). */
export const NATIVE_EXPORT_COLOR_PARAMS = [
	"brightness",
	"contrast",
	"saturation",
	"temperature",
	"tint",
] as const;

/** The params that need a spatial/neighbour shader pass — NOT mapped yet. */
export const NATIVE_EXPORT_UNMAPPED_COLOR_PARAMS = ["sharpen", "vignette"] as const;

export function isNeutralColorGrade(grade: ColorGrade): boolean {
	return (
		grade.brightness === 0 &&
		grade.contrast === 0 &&
		grade.saturation === 0 &&
		grade.temperature === 0 &&
		grade.tint === 0 &&
		grade.sharpen === 0 &&
		grade.vignette === 0
	);
}

/** Params of this grade Android native export cannot express yet. Empty for
 *  every grade it can. Mirrors `ColorGrade.unsupportedParams()` in Kotlin. */
export function unsupportedNativeColorGradeParams(grade: ColorGrade): string[] {
	const unsupported: string[] = [];
	if (grade.sharpen !== 0) unsupported.push("sharpen");
	if (grade.vignette !== 0) unsupported.push("vignette");
	return unsupported;
}

function numberParam({ params, key }: { params?: Record<string, unknown>; key: string }): number {
	const raw = params?.[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** The `adjust` effect's seven sliders -> a grade (missing/non-finite = 0,
 *  matching the "a NEUTRAL adjust is an EMPTY pass group" rule in
 *  `services/renderer/resolve.ts`). */
export function colorGradeFromAdjust(params: Record<string, unknown> | undefined): ColorGrade {
	return {
		brightness: numberParam({ params, key: "brightness" }),
		contrast: numberParam({ params, key: "contrast" }),
		saturation: numberParam({ params, key: "saturation" }),
		temperature: numberParam({ params, key: "temperature" }),
		tint: numberParam({ params, key: "tint" }),
		sharpen: numberParam({ params, key: "sharpen" }),
		vignette: numberParam({ params, key: "vignette" }),
	};
}

/**
 * Filter presets, expressed as the SAME grade units the Adjust sliders use so
 * both effects resolve through one shader path.
 *
 * Deliberately affine-only (no sharpen/vignette): a preset must survive the
 * Android exporter, and #48 maps exactly the affine subset. Preset looks are
 * authored here — not cloned from any proprietary app's LUTs — and scaled by
 * the panel's `intensity` slider (0..100).
 */
export const FILTER_PRESET_GRADES: Record<string, ColorGrade> = {
	none: NEUTRAL_COLOR_GRADE,
	vivid: { ...NEUTRAL_COLOR_GRADE, saturation: 35, contrast: 18 },
	mono: { ...NEUTRAL_COLOR_GRADE, saturation: -100 },
	vintage: { ...NEUTRAL_COLOR_GRADE, saturation: -30, temperature: 30, contrast: -8 },
	cool: { ...NEUTRAL_COLOR_GRADE, temperature: -35, saturation: -5 },
	warm: { ...NEUTRAL_COLOR_GRADE, temperature: 35, saturation: 5 },
	cinematic: { ...NEUTRAL_COLOR_GRADE, contrast: 22, saturation: -15, temperature: -12 },
};

/** The `filter` effect (preset + intensity) -> a grade. */
export function colorGradeFromFilter(params: Record<string, unknown> | undefined): ColorGrade {
	const presetRaw = params?.preset;
	const preset = typeof presetRaw === "string" ? presetRaw : "none";
	const base = FILTER_PRESET_GRADES[preset] ?? NEUTRAL_COLOR_GRADE;
	if (preset === "none" || isNeutralColorGrade(base)) return { ...NEUTRAL_COLOR_GRADE };

	const intensityRaw = params?.intensity;
	const intensity =
		typeof intensityRaw === "number" && Number.isFinite(intensityRaw) ? intensityRaw : 100;
	const scale = Math.max(0, Math.min(100, intensity)) / 100;
	return {
		brightness: base.brightness * scale,
		contrast: base.contrast * scale,
		saturation: base.saturation * scale,
		temperature: base.temperature * scale,
		tint: base.tint * scale,
		sharpen: base.sharpen * scale,
		vignette: base.vignette * scale,
	};
}

/**
 * Shader units for `color_adjust.wgsl` / `color-adjust` — the exact mapping
 * `adjust.ts` shipped with (unchanged numbers, so preview output does not
 * move by a single level).
 */
export function colorGradeUniforms(grade: ColorGrade): {
	u_brightness: number;
	u_contrast: number;
	u_saturation: number;
	u_temperature: number;
	u_tint: number;
	u_sharpen: number;
	u_vignette: number;
} {
	return {
		u_brightness: (grade.brightness / 100) * 0.35,
		u_contrast: 1 + (grade.contrast / 100) * 0.6,
		u_saturation: Math.max(0, 1 + grade.saturation / 100),
		u_temperature: grade.temperature / 100,
		u_tint: grade.tint / 100,
		u_sharpen: grade.sharpen / 100,
		u_vignette: grade.vignette / 100,
	};
}

/** Rec.709 luma weights, as in the WGSL shader. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * The same grade as a 4x4 RGB matrix for media3's `RgbMatrix` effect —
 * column-major `float[16]` (index = column * 4 + row), applied as
 * `M * vec4(rgb, 1)` (media3's `fragment_shader_transformation_es2.glsl`
 * hard-codes `w = 1`, so column 3 is a true translation and alpha passes
 * through untouched).
 *
 * Derivation, following the WGSL fragment shader's ORDER exactly:
 *
 *   1. temperature/tint offsets  c += t
 *   2. brightness                c += b
 *      => c = c0 + t + b
 *   3. contrast about mid-gray   c = k*c + 0.5*(1-k)
 *      => c = k*(c0 + t + b) + 0.5*(1-k)
 *   4. saturation around luma    c = (s*I + (1-s)*L) * c  (L = luma row)
 *
 * So out = A*c0 + d with  A = k*M  and  d = M*(k*(t+b) + 0.5*(1-k)).
 *
 * `sharpen`/`vignette` have no matrix representation and are ignored here —
 * callers must check `unsupportedNativeColorGradeParams()` FIRST and refuse,
 * which is exactly what `EdlToComposition` does.
 */
export function colorGradeRgbMatrix(grade: ColorGrade): number[] {
	const { u_brightness, u_contrast, u_saturation, u_temperature, u_tint } =
		colorGradeUniforms(grade);

	// Step 1+2 offsets, in RGB order.
	const tx = u_temperature * 0.12 + u_tint * 0.05;
	const ty = -u_tint * 0.1;
	const tz = -u_temperature * 0.12 + u_tint * 0.05;
	const ox = tx + u_brightness;
	const oy = ty + u_brightness;
	const oz = tz + u_brightness;

	const k = u_contrast;
	const s = u_saturation;
	const luma = [LUMA_R, LUMA_G, LUMA_B] as const;

	// Saturation matrix M[i][j] = s*delta + (1-s)*L[j].
	const m: number[][] = [0, 1, 2].map((i) =>
		[0, 1, 2].map((j) => (i === j ? s : 0) + (1 - s) * luma[j]),
	);

	// A = k * M
	const a = m.map((row) => row.map((v) => k * v));
	// pre = k * offset + 0.5*(1-k)
	const pre = [ox, oy, oz].map((v) => k * v + 0.5 * (1 - k));
	// d = M * pre
	const d = m.map((row) => row[0] * pre[0] + row[1] * pre[1] + row[2] * pre[2]);

	return [
		a[0][0], a[1][0], a[2][0], 0,
		a[0][1], a[1][1], a[2][1], 0,
		a[0][2], a[1][2], a[2][2], 0,
		d[0], d[1], d[2], 1,
	];
}
