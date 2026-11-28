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
 * Directional wipe for the incoming transition head.
 *
 * The head is painted ABOVE the opaque base (`TransitionAlphaMath.WIPE` is an
 * `incoming-above` kind). This pass discards the part of the frame the edge has
 * not reached yet, so the base shows through and the wipe reveals the incoming
 * clip exactly like the preview's derived `transition-wipe` pass.
 *
 * Semantics are shared with `rust/crates/effects/src/shaders/transition_wipe.wgsl`:
 * `direction` is where the edge travels (left => reveal starts at the right
 * edge), `progress` sweeps 0..1 across the window, and `softness` is the
 * normalised edge width (fraction of the frame along the wipe axis).
 */
class EdlWipeEffect(
    private val direction: String,
    private val windowStartUs: Long,
    private val windowEndUs: Long,
    private val softness: Float = 0.01f,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(direction, windowStartUs, windowEndUs, softness)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private class Program(
        private val direction: String,
        private val windowStartUs: Long,
        private val windowEndUs: Long,
        private val softness: Float,
    ) : BaseGlShaderProgram(/* useHdr = */ false, /* texturePoolCapacity = */ 1) {

        private val glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)

        init {
            glProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                4,
            )
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size =
            Size(inputWidth, inputHeight)

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            val progress = TransitionAlphaMath.progress(
                startUs = windowStartUs,
                endUs = windowEndUs,
                presentationTimeUs = presentationTimeUs,
            )
            val axis = when (direction) {
                "right" -> floatArrayOf(1f, 0f)
                "up" -> floatArrayOf(0f, -1f)
                "down" -> floatArrayOf(0f, 1f)
                else -> floatArrayOf(-1f, 0f)
            }
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform("uDirection", axis)
                glProgram.setFloatUniform("uProgress", progress)
                glProgram.setFloatUniform("uSoftness", softness)
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
         * `vTexSamplingCoord` runs bottom-up in this stage's texture, while the
         * preview's WGSL samples top-down, so the wipe coordinate flips y to
         * keep up/down wipes agreeing (the same convention `EdlMaskEffect`
         * documents for its geometry).
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec2 uDirection;
            uniform float uProgress;
            uniform float uSoftness;
            varying vec2 vTexSamplingCoord;

            void main() {
              vec4 color = texture2D(uTexSampler, vTexSamplingCoord);
              vec2 uv = vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y);
              bool vertical = abs(uDirection.y) > abs(uDirection.x);
              bool movingPositive = vertical ? (uDirection.y > 0.0) : (uDirection.x > 0.0);
              float coord = vertical ? uv.y : uv.x;
              if (!movingPositive) {
                coord = 1.0 - coord;
              }
              float softness = max(uSoftness, 0.0001);
              float progress = clamp(uProgress, 0.0, 1.0);
              float edge = mix(-softness, 1.0 + softness, progress);
              float visible = 1.0 - smoothstep(edge - softness, edge + softness, coord);
              gl_FragColor = vec4(color.rgb, color.a * visible);
            }
        """
    }
}
