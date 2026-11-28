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
 * Blur-in pass for a `blur` transition's incoming head.
 *
 * The transition is a cross-fade whose incoming layer starts fully blurred and
 * resolves to sharp. The preview derives the same shape by animating the
 * existing `blur` effect's intensity from `TRANSITION_BLUR_INTENSITY` to 0
 * across the window; this pass evaluates `TransitionAlphaMath.incomingBlurSigma`
 * against the composition clock.
 *
 * One pass, 9 taps per axis (a small separable Gaussian), because a full
 * multi-pass chain per frame would require a second render target per item.
 * The tap count is fixed; only the sampling stride grows with sigma, so the
 * cost stays constant across the whole window.
 */
class EdlBlurEffect(
    private val windowStartUs: Long,
    private val windowEndUs: Long,
    private val intensity: Float = 200f,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(windowStartUs, windowEndUs, intensity)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private class Program(
        private val windowStartUs: Long,
        private val windowEndUs: Long,
        private val intensity: Float,
    ) : BaseGlShaderProgram(/* useHdr = */ false, /* texturePoolCapacity = */ 1) {

        private val glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        private var inputWidth = 1
        private var inputHeight = 1

        init {
            glProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                4,
            )
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            this.inputWidth = inputWidth
            this.inputHeight = inputHeight
            return Size(inputWidth, inputHeight)
        }

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            val sigma = TransitionAlphaMath.incomingBlurSigma(
                frameHeight = inputHeight,
                startUs = windowStartUs,
                endUs = windowEndUs,
                presentationTimeUs = presentationTimeUs,
            )
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform(
                    "uTexel",
                    floatArrayOf(1f / inputWidth.toFloat(), 1f / inputHeight.toFloat()),
                )
                glProgram.setFloatUniform("uSigma", sigma)
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
         * 9 taps per axis with fixed Gaussian weights and a sigma-scaled stride.
         * A zero sigma short-circuits to the untouched sample, so the last
         * frame of the window is pixel-identical to no effect at all.
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec2 uTexel;
            uniform float uSigma;
            varying vec2 vTexSamplingCoord;

            void main() {
              vec4 center = texture2D(uTexSampler, vTexSamplingCoord);
              if (uSigma < 0.25) {
                gl_FragColor = center;
                return;
              }
              float stride = uSigma / 3.0;
              vec4 sum = center;
              float weightSum = 1.0;
              for (int i = 1; i < 5; i++) {
                float fi = float(i);
                float weight = exp(-0.5 * fi * fi * 0.36);
                vec2 offset = vec2(uTexel.x * stride * fi, 0.0);
                sum += texture2D(uTexSampler, vTexSamplingCoord + offset) * weight;
                sum += texture2D(uTexSampler, vTexSamplingCoord - offset) * weight;
                weightSum += 2.0 * weight;
              }
              vec4 horizontal = sum / weightSum;
              sum = horizontal;
              weightSum = 1.0;
              for (int i = 1; i < 5; i++) {
                float fi = float(i);
                float weight = exp(-0.5 * fi * fi * 0.36);
                vec2 offset = vec2(0.0, uTexel.y * stride * fi);
                sum += texture2D(uTexSampler, vTexSamplingCoord + offset) * weight;
                sum += texture2D(uTexSampler, vTexSamplingCoord - offset) * weight;
                weightSum += 2.0 * weight;
              }
              gl_FragColor = sum / weightSum;
            }
        """
    }
}
