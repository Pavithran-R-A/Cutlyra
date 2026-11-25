package app.cutlyra.editor.export

import android.content.Context
import android.opengl.GLES20
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram

/**
 * The two Adjust-panel sliders a 4x4 matrix cannot express — `sharpen` and
 * `vignette` — as a real GL pass, completing GitHub #48's preview ⇄ export
 * parity work.
 *
 * Before this class, `ColorGrade` refused both params, so moving either slider
 * made every Android export of that project fail with
 * `ExportUnsupportedException`. The preview never had that problem: one WGSL
 * pass (`rust/crates/effects/src/shaders/color_adjust.wgsl`) implements all
 * seven sliders. This effect reimplements the two spatial ones from the same
 * formulas and the same shader units (`ColorGrade.sharpenUniform()` /
 * `vignetteUniform()`, pinned by the shared fixtures):
 *
 *   - sharpen: unsharp mask against the 4-neighbour average at a 1px radius,
 *     `c += (c - n/4) * sharpen * 1.5` (WGSL's exact constants);
 *   - vignette: `falloff = smoothstep(0.35, 0.9, length(uv - 0.5) * 1.6)`,
 *     `c *= 1 - falloff * vignette`.
 *
 * ORDER MATTERS and matches the WGSL shader: sharpen reads raw neighbours and
 * runs BEFORE the affine colour matrix; vignette is applied last. That is why
 * `EdlToComposition` inserts [sharpen] passes before `ColorGradeMatrixEffect`
 * and [vignette] passes after it.
 *
 * Bounded by construction: one input texture, one output texture, five taps.
 * The output frame keeps the input size, so crop/rotation/framing upstream and
 * the overlays downstream are unaffected.
 */
class ColorGradeSpatialEffect(
    private val sharpen: Float,
    private val vignette: Float,
) : GlEffect {

    init {
        require(sharpen >= 0f && vignette >= 0f) { "sharpen/vignette are unsigned panel amounts" }
    }

    /** True when neither slider is engaged — the caller should add no pass. */
    fun isNeutral(): Boolean = sharpen <= 0f && vignette <= 0f

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(sharpen, vignette)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = isNeutral()

    private class Program(
        private val sharpen: Float,
        private val vignette: Float,
    ) : BaseGlShaderProgram(/* useHdr = */ false, /* texturePoolCapacity = */ 1) {

        private val glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)

        /** Fixed once `configure` reports the real post-crop frame size. */
        private var resolution = floatArrayOf(1f, 1f)

        init {
            // Same single-attribute contract as every other custom effect here:
            // Media3 1.11.0 supplies the quad positions (no texcoord buffer),
            // so the fragment varying is derived from the position.
            glProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                4,
            )
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            resolution = floatArrayOf(inputWidth.toFloat(), inputHeight.toFloat())
            return Size(inputWidth, inputHeight)
        }

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform("uResolution", resolution)
                glProgram.setFloatUniform("uSharpen", sharpen)
                glProgram.setFloatUniform("uVignette", vignette)
                glProgram.bindAttributesAndUniforms()
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            } catch (e: GlUtil.GlException) {
                throw VideoFrameProcessingException(e, presentationTimeUs)
            }
        }

        override fun release() {
            runCatching { glProgram.delete() }
            super.release()
        }
    }

    companion object {
        private const val VERTEX_SHADER = """
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        /**
         * Transcription of `color_adjust.wgsl`'s sharpen and vignette blocks,
         * unchanged constants. Each branch is skipped when its uniform is 0, so
         * a sharpen-only or vignette-only instance costs exactly one branch.
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec2 uResolution;
            uniform float uSharpen;
            uniform float uVignette;
            varying vec2 vTexSamplingCoord;

            void main() {
              vec2 uv = vTexSamplingCoord;
              vec4 color = texture2D(uTexSampler, uv);

              if (uSharpen > 0.0) {
                vec2 texel = 1.0 / uResolution;
                vec3 n = texture2D(uTexSampler, uv + vec2(0.0, -texel.y)).rgb
                       + texture2D(uTexSampler, uv + vec2(0.0, texel.y)).rgb
                       + texture2D(uTexSampler, uv + vec2(-texel.x, 0.0)).rgb
                       + texture2D(uTexSampler, uv + vec2(texel.x, 0.0)).rgb;
                color.rgb += (color.rgb - n * 0.25) * uSharpen * 1.5;
              }

              if (uVignette > 0.0) {
                vec2 centered = uv - vec2(0.5, 0.5);
                float falloff = smoothstep(0.35, 0.9, length(centered) * 1.6);
                color.rgb *= (1.0 - falloff * uVignette);
              }

              gl_FragColor = vec4(clamp(color.rgb, vec3(0.0), vec3(1.0)), color.a);
            }
        """
    }
}
