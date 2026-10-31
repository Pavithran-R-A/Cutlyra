package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlEffect
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTransform
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.math.abs

/**
 * GitHub #48 — the PRE-EMPTION half of the preview/export parity contract.
 *
 * The fixtures in `src/test/resources/color-grade-fixtures.json` are
 * GENERATED from the TypeScript model (`bun scripts/generate-color-grade-
 * fixtures.ts`), i.e. from the very code that produces the preview's shader
 * uniforms. If either implementation of the grade -> matrix derivation
 * drifts, this test fails before any device is involved.
 *
 * The device half is `ExportColorGradeInstrumentedTest`, which asserts the
 * same grade on DECODED frames of a real exported MP4.
 */
class ColorGradeMatrixTest {
    private fun fixture(): JSONObject {
        val stream = checkNotNull(javaClass.classLoader.getResourceAsStream("color-grade-fixtures.json")) {
            "color-grade-fixtures.json missing — regenerate with: bun scripts/generate-color-grade-fixtures.ts"
        }
        val text = stream.bufferedReader().use { it.readText() }
        return JSONObject(text)
    }

    private fun gradeOf(json: JSONObject): ColorGrade = ColorGrade(
        brightness = json.getDouble("brightness").toFloat(),
        contrast = json.getDouble("contrast").toFloat(),
        saturation = json.getDouble("saturation").toFloat(),
        temperature = json.getDouble("temperature").toFloat(),
        tint = json.getDouble("tint").toFloat(),
        sharpen = json.getDouble("sharpen").toFloat(),
        vignette = json.getDouble("vignette").toFloat(),
    )

    private fun assertClose(expected: Float, actual: Float, message: String, tol: Float = 1e-4f) {
        assertTrue("$message: expected $expected, was $actual", abs(expected - actual) <= tol)
    }

    @Test
    fun kotlin_matrix_matches_the_generated_typescript_matrix() {
        val cases = fixture().getJSONArray("cases")
        for (caseIndex in 0 until cases.length()) {
            val json = cases.getJSONObject(caseIndex)
            val grade = gradeOf(json.getJSONObject("grade"))
            val expected = json.getJSONArray("matrix")
            val actual = grade.rgbMatrix()
            assertEquals(16, actual.size)
            for (i in 0 until 16) {
                assertClose(
                    expected.getDouble(i).toFloat(),
                    actual[i],
                    "${json.getString("name")} matrix[$i]",
                )
            }
        }
    }

    @Test
    fun kotlin_matrix_reproduces_the_preview_shading_on_sample_colors() {
        val cases = fixture().getJSONArray("cases")
        for (caseIndex in 0 until cases.length()) {
            val json = cases.getJSONObject(caseIndex)
            val grade = gradeOf(json.getJSONObject("grade"))
            val matrix = grade.rgbMatrix()
            val samples = json.getJSONArray("samples")
            for (sampleIndex in 0 until samples.length()) {
                val s = samples.getJSONObject(sampleIndex)
                val rgb = s.getJSONArray("rgb")
                val out = s.getJSONArray("out")
                val x = rgb.getDouble(0).toFloat()
                val y = rgb.getDouble(1).toFloat()
                val z = rgb.getDouble(2).toFloat()
                val got = floatArrayOf(
                    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
                )
                for (i in 0 until 3) {
                    assertClose(
                        out.getDouble(i).toFloat(),
                        got[i],
                        "${json.getString("name")} on ${rgb.getDouble(0)},${rgb.getDouble(1)},${rgb.getDouble(2)} channel $i",
                    )
                }
            }
        }
    }

    @Test
    fun unsupported_params_match_the_typescript_side() {
        val cases = fixture().getJSONArray("cases")
        for (caseIndex in 0 until cases.length()) {
            val json = cases.getJSONObject(caseIndex)
            val grade = gradeOf(json.getJSONObject("grade"))
            val expected = json.getJSONArray("unsupported").let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            }
            assertEquals(json.getString("name"), expected, grade.unsupportedParams())
        }
    }

    @Test
    fun filter_presets_match_the_typescript_side_including_intensity() {
        val presets = fixture().getJSONArray("presets")
        for (presetIndex in 0 until presets.length()) {
            val p = presets.getJSONObject(presetIndex)
            val params = mapOf("preset" to p.getString("preset"), "intensity" to p.getInt("intensity"))
            val expected = gradeOf(p.getJSONObject("grade"))
            val actual = ColorGrade.fromFilter(params)
            assertEquals(
                "${p.getString("preset")}/${p.getInt("intensity")}",
                expected,
                actual,
            )
        }
    }

    @Test
    fun adjust_params_flow_through_the_same_seven_sliders() {
        val expected = gradeOf(fixture().getJSONObject("adjustSample"))
        val actual = ColorGrade.fromAdjust(
            mapOf(
                "brightness" to 10,
                "contrast" to -20,
                "saturation" to 30,
                "temperature" to -40,
                "tint" to 50,
                "sharpen" to 60,
                "vignette" to 70,
            ),
        )
        assertEquals(expected, actual)
    }

    private fun clip(effects: List<EdlEffect>): EdlClip = EdlClip(
        clipId = "clip-grade",
        kind = "video",
        assetId = "asset-1",
        name = "a",
        startTicks = 0,
        durationTicks = 120_000,
        sourceStartTicks = 0,
        sourceEndTicks = 120_000,
        speed = EdlRational(1, 1),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = false,
        hidden = false,
        transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        opacity = 1.0,
        effects = effects,
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    private fun effect(type: String, params: Map<String, Any?>, enabled: Boolean = true) =
        EdlEffect(effectId = "e-1", type = type, enabled = enabled, params = params)

    @Test
    fun an_adjust_bearing_clip_maps_instead_of_being_refused() {
        // The regression itself: this used to be ExportUnsupportedException
        // ("generic filter mapping is not implemented in this M9 pass").
        val clip = clip(listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("brightness" to 50))))
        val matrix = ColorGrade.combinedMatrixFor(clip)
        assertNotNull("an effect-bearing clip must map to a grade matrix", matrix)
        val expected = ColorGrade.fromAdjust(mapOf("brightness" to 50)).rgbMatrix()
        for (i in 0 until 16) assertClose(expected[i], matrix!![i], "brightness matrix[$i]")
    }

    @Test
    fun a_filter_bearing_clip_maps_and_a_neutral_clip_maps_nothing() {
        val mono = clip(listOf(effect(ColorGrade.FILTER_TYPE, mapOf("preset" to "mono", "intensity" to 100))))
        assertNotNull(ColorGrade.combinedMatrixFor(mono))

        val none = clip(listOf(effect(ColorGrade.FILTER_TYPE, mapOf("preset" to "none"))))
        assertNull("a 'none' filter must contribute no effect at all", ColorGrade.combinedMatrixFor(none))

        val noEffects = clip(emptyList())
        assertNull(ColorGrade.combinedMatrixFor(noEffects))
    }

    @Test
    fun disabled_effects_are_ignored_exactly_like_the_preview() {
        val disabled = clip(
            listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("brightness" to 90), enabled = false)),
        )
        assertNull(ColorGrade.combinedMatrixFor(disabled))
    }

    @Test
    fun two_effects_combine_in_edl_order() {
        val clip = clip(
            listOf(
                effect(ColorGrade.ADJUST_TYPE, mapOf("brightness" to 50)),
                effect(ColorGrade.FILTER_TYPE, mapOf("preset" to "mono", "intensity" to 100)),
            ),
        )
        val combined = ColorGrade.combinedMatrixFor(clip)
        assertNotNull(combined)
        val first = ColorGrade.fromAdjust(mapOf("brightness" to 50)).rgbMatrix()
        val second = ColorGrade.fromFilter(mapOf("preset" to "mono", "intensity" to 100)).rgbMatrix()
        val expected = ColorGrade.multiply(second, first)
        for (i in 0 until 16) assertClose(expected[i], combined!![i], "combined[$i]")
    }

    @Test
    fun unsupported_params_and_unknown_effect_types_refuse_instead_of_dropping() {
        val sharpenClip = clip(listOf(effect(ColorGrade.ADJUST_TYPE, mapOf("sharpen" to 40))))
        try {
            ColorGrade.combinedMatrixFor(sharpenClip)
            fail("sharpen must be refused, not silently dropped")
        } catch (e: ExportUnsupportedException) {
            assertTrue(e.message!!.contains("sharpen"))
        }

        val vignetteClip = clip(listOf(effect(ColorGrade.FILTER_TYPE, mapOf("preset" to "vivid", "intensity" to 100, "vignette" to 10))))
        try {
            ColorGrade.combinedMatrixFor(vignetteClip)
            fail("vignette must be refused, not silently dropped")
        } catch (e: ExportUnsupportedException) {
            assertTrue(e.message!!.contains("vignette"))
        }

        val unknown = clip(listOf(effect("blur", mapOf("radius" to 8))))
        try {
            ColorGrade.combinedMatrixFor(unknown)
            fail("an unimplemented effect type must be refused, not dropped")
        } catch (e: ExportUnsupportedException) {
            assertTrue(e.message!!.contains("blur"))
        }
    }

    @Test
    fun multiply_applies_the_right_hand_side_first() {
        val identity = floatArrayOf(
            1f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, 1f, 0f,
            0f, 0f, 0f, 1f,
        )
        val scale = ColorGrade(saturation = -100f).rgbMatrix()
        assertArrayEquals(scale, ColorGrade.multiply(scale, identity), 1e-6f)
        assertArrayEquals(scale, ColorGrade.multiply(identity, scale), 1e-6f)
        // A * B where B scales first: order must matter for non-commuting pairs.
        val bright = ColorGrade(brightness = 50f).rgbMatrix()
        val ab = ColorGrade.multiply(bright, scale)
        val ba = ColorGrade.multiply(scale, bright)
        var differs = false
        for (i in 0 until 16) if (abs(ab[i] - ba[i]) > 1e-6) differs = true
        assertTrue("brightness and saturation must not commute (order is observable)", differs)
    }
}
