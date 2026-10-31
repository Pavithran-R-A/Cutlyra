package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlEffect

/**
 * GitHub #48 / Linear PAV-142 — the Android half of the shared color-grade
 * model.
 *
 * BEFORE this class existed, `EdlToComposition.buildEditedMediaItem` threw
 * `ExportUnsupportedException` for ANY non-empty `EdlClip.effects` ("generic
 * filter mapping is not implemented in this M9 pass"). Because the Adjust and
 * Filters panels write exactly such effects, moving a single brightness slider
 * made every Android export of that project fail outright — the reason those
 * two panels were deliberately kept out of the shipping toolbar
 * (`toolbar-defs.ts`).
 *
 * `ColorGrade` mirrors `packages/editor-core/src/effects/color-grade.ts`
 * byte for byte: the same panel units, the same preset table, the same
 * shader-uniform constants and the same op order (temperature/tint ->
 * brightness -> contrast -> saturation), derived into one 4x4 matrix so the
 * whole grade is a single media3 [RgbMatrix] pass. The parity is pinned by
 * two tests that share fixtures generated from the TypeScript implementation:
 *
 *   - `src/test/.../ColorGradeMatrixTest.kt` (JVM, runs in CI) asserts the
 *     Kotlin matrix equals the TS matrix on shared sample colors;
 *   - `src/androidTest/.../ExportColorGradeInstrumentedTest.kt` (emulator,
 *     runs in CI) exports a graded clip and asserts the DECODED MP4 frame
 *     matches the grade computed from the ungraded export's own pixels.
 *
 * Deliberately NOT mapped (and therefore refused, never silently dropped):
 * `sharpen` (neighbour sampling) and `vignette` (position-varying) — neither
 * is expressible as one 4x4 matrix. Refusing keeps the "do not ship
 * preview-only effects" rule intact: a project that uses them fails export
 * with a message naming the exact params instead of exporting as if they
 * were never applied.
 */
data class ColorGrade(
    val brightness: Float = 0f,
    val contrast: Float = 0f,
    val saturation: Float = 0f,
    val temperature: Float = 0f,
    val tint: Float = 0f,
    val sharpen: Float = 0f,
    val vignette: Float = 0f,
) {
    fun isNeutral(): Boolean =
        brightness == 0f &&
            contrast == 0f &&
            saturation == 0f &&
            temperature == 0f &&
            tint == 0f &&
            sharpen == 0f &&
            vignette == 0f

    /** Params this grade cannot express as one matrix — always reported. */
    fun unsupportedParams(): List<String> = buildList {
        if (sharpen != 0f) add("sharpen")
        if (vignette != 0f) add("vignette")
    }

    /**
     * The grade as a 4x4 RGB matrix, column-major `FloatArray(16)`
     * (`index = column * 4 + row`), exactly as media3's
     * `fragment_shader_transformation_es2.glsl` consumes it:
     * `gl_FragColor = uRgbMatrix * vec4(inputColor.rgb, 1)`, alpha untouched.
     *
     * Derivation mirrors `colorGradeRgbMatrix()` in TypeScript:
     *
     *   offsets: r += temp*0.12 + tint*0.05 ; b += -temp*0.12 + tint*0.05
     *            g += -tint*0.10             (then + brightness on all)
     *   contrast: c = (c - 0.5) * k + 0.5
     *   saturation: c = luma*(1-s) + c*s   (luma = Rec.709 weights)
     *
     * so out = A*c0 + d with A = k*M and d = M*(k*offset + 0.5*(1-k)).
     */
    fun rgbMatrix(): FloatArray {
        val brightnessU = (brightness / 100f) * 0.35f
        val contrastK = 1f + (contrast / 100f) * 0.6f
        val saturationS = maxOf(0f, 1f + saturation / 100f)
        val temperatureU = temperature / 100f
        val tintU = tint / 100f

        val ox = temperatureU * 0.12f + tintU * 0.05f + brightnessU
        val oy = -tintU * 0.10f + brightnessU
        val oz = -temperatureU * 0.12f + tintU * 0.05f + brightnessU

        val luma = floatArrayOf(0.2126f, 0.7152f, 0.0722f)
        // m[i][j] = s*delta + (1-s)*luma[j]
        val m = Array(3) { i -> FloatArray(3) { j -> (if (i == j) saturationS else 0f) + (1f - saturationS) * luma[j] } }
        val offsets = floatArrayOf(ox, oy, oz)

        val pre = FloatArray(3) { i -> contrastK * offsets[i] + 0.5f * (1f - contrastK) }
        val out = FloatArray(16)
        for (i in 0 until 3) {
            for (j in 0 until 3) {
                out[j * 4 + i] = contrastK * m[i][j]   // A = k * M, column-major
            }
            out[12 + i] = m[i][0] * pre[0] + m[i][1] * pre[1] + m[i][2] * pre[2]   // d = M * pre
        }
        // Alpha row/column: identity (media3 preserves input alpha itself).
        out[3] = 0f
        out[7] = 0f
        out[11] = 0f
        out[15] = 1f
        return out
    }

    companion object {
        const val ADJUST_TYPE = "adjust"
        const val FILTER_TYPE = "filter"

        /**
         * Filter presets as grade units, authored locally (NOT copied from
         * any proprietary app's LUTs) and shared verbatim with
         * `FILTER_PRESET_GRADES` in TypeScript. Affine-only by construction,
         * so every preset survives this exporter.
         */
        private val FILTER_PRESET_GRADES: Map<String, ColorGrade> = mapOf(
            "none" to ColorGrade(),
            "vivid" to ColorGrade(saturation = 35f, contrast = 18f),
            "mono" to ColorGrade(saturation = -100f),
            "vintage" to ColorGrade(saturation = -30f, temperature = 30f, contrast = -8f),
            "cool" to ColorGrade(temperature = -35f, saturation = -5f),
            "warm" to ColorGrade(temperature = 35f, saturation = 5f),
            "cinematic" to ColorGrade(contrast = 22f, saturation = -15f, temperature = -12f),
        )

        private fun number(params: Map<String, Any?>, key: String): Float {
            val raw = params[key] ?: return 0f
            val value = (raw as? Number)?.toFloat() ?: return 0f
            return if (value.isFinite()) value else 0f
        }

        /** The `adjust` effect's seven sliders -> a grade (panel units). */
        fun fromAdjust(params: Map<String, Any?>): ColorGrade = ColorGrade(
            brightness = number(params, "brightness"),
            contrast = number(params, "contrast"),
            saturation = number(params, "saturation"),
            temperature = number(params, "temperature"),
            tint = number(params, "tint"),
            sharpen = number(params, "sharpen"),
            vignette = number(params, "vignette"),
        )

        /** The `filter` effect (preset + intensity) -> a grade. Unknown
         *  presets and a missing intensity behave exactly as TypeScript:
         *  neutral and full (100) respectively. */
        fun fromFilter(params: Map<String, Any?>): ColorGrade {
            val preset = params["preset"] as? String ?: return ColorGrade()
            val base = FILTER_PRESET_GRADES[preset] ?: return ColorGrade()
            if (base.isNeutral()) return ColorGrade()
            val intensity = when (val raw = params["intensity"]) {
                is Number -> raw.toFloat()
                else -> 100f
            }.let { if (it.isFinite()) it else 100f }.coerceIn(0f, 100f)
            val scale = intensity / 100f
            return base.copy(
                brightness = base.brightness * scale,
                contrast = base.contrast * scale,
                saturation = base.saturation * scale,
                temperature = base.temperature * scale,
                tint = base.tint * scale,
                sharpen = base.sharpen * scale,
                vignette = base.vignette * scale,
            )
        }

        /**
         * Every non-neutral grade a clip carries, in EDL order (disabled
         * effects skipped, matching how the preview renderer drops them).
         *
         * @throws ExportUnsupportedException for an effect type native export
         *   does not implement, or for a grade carrying `sharpen`/`vignette`.
         *   Refusing — rather than skipping — is the whole point: a dropped
         *   visual edit is a silent data-loss bug.
         */
        fun gradesFor(clip: EdlClip): List<ColorGrade> = clip.effects
            .filter { it.enabled }
            .map { effect -> gradeFor(clip, effect) }
            .filterNot { it.isNeutral() }

        private fun gradeFor(clip: EdlClip, effect: EdlEffect): ColorGrade = when (effect.type) {
            ADJUST_TYPE -> fromAdjust(effect.params)
            FILTER_TYPE -> fromFilter(effect.params)
            else -> throw ExportUnsupportedException(
                "clip ${clip.clipId} has effect type \"${effect.type}\"; native export maps " +
                    "\"$ADJUST_TYPE\" and \"$FILTER_TYPE\" only (GitHub #48) and refuses the rest " +
                    "rather than silently dropping a visual edit",
            )
        }.also { grade ->
            val unsupported = grade.unsupportedParams()
            if (unsupported.isNotEmpty()) {
                throw ExportUnsupportedException(
                    "clip ${clip.clipId} uses ${unsupported.joinToString()} on an adjust/filter " +
                        "effect; those params need a spatial shader pass that native export does " +
                        "not implement yet (GitHub #48) and are not silently dropped",
                )
            }
        }

        /**
         * One combined matrix applying every grade in EDL order (first grade
         * applied first: `out = M_n * ... * M_1 * c`), or `null` when the
         * clip carries no effect the exporter must render.
         */
        fun combinedMatrixFor(clip: EdlClip): FloatArray? {
            val grades = gradesFor(clip)
            if (grades.isEmpty()) return null
            var combined = IDENTITY
            for (grade in grades) {
                combined = multiply(grade.rgbMatrix(), combined)
            }
            return combined
        }

        private val IDENTITY = floatArrayOf(
            1f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, 1f, 0f,
            0f, 0f, 0f, 1f,
        )

        /** `lhs * rhs`, both column-major: applying `rhs` first. */
        fun multiply(lhs: FloatArray, rhs: FloatArray): FloatArray {
            val out = FloatArray(16)
            for (col in 0 until 4) {
                for (row in 0 until 4) {
                    var sum = 0f
                    for (k in 0 until 4) {
                        sum += lhs[k * 4 + row] * rhs[col * 4 + k]
                    }
                    out[col * 4 + row] = sum
                }
            }
            return out
        }
    }
}

/**
 * The single-pass carrier for a [ColorGrade] matrix.
 *
 * Implements media3's [androidx.media3.effect.RgbMatrix] directly, so media3
 * owns the shader plumbing (`DefaultShaderProgram` + the stock
 * `fragment_shader_transformation_es2.glsl`): no custom GLSL, no extra
 * per-frame work, and the matrix is fetched lazily per presentation time like
 * the opacity effects next to it.
 */
class ColorGradeMatrixEffect(
    private val matrix: FloatArray,
) : androidx.media3.effect.RgbMatrix {
    override fun getMatrix(presentationTimeUs: Long, useHdr: Boolean): FloatArray = matrix
}
