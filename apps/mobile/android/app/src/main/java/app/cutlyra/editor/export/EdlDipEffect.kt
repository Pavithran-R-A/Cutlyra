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
 * Dip-to-colour pass used by both ends of a `dip-black` / `dip-white`
 * transition.
 *
 * The preview derives an equivalent `transition-dip` effect on each element,
 * with `amount` keyframed 0 -> 1 on the outgoing clip (first half of the
 * window) and 1 -> 0 on the incoming clip (second half). This pass evaluates
 * the same piecewise ramp against the composition clock and mixes every pixel
 * toward the dip colour, leaving alpha alone so the cross-fade stacking still
 * decides which layer is visible.
 */
class EdlDipEffect(
    private val colour: FloatArray,
    private val windowStartUs: Long,
    private val windowEndUs: Long,
    private val incoming: Boolean,
) : GlEffect {

    init {
        require(colour.size == 3) { "dip colour needs r,g,b" }
    }

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(colour, windowStartUs, windowEndUs, incoming)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private class Program(
        private val colour: FloatArray,
        private val windowStartUs: Long,
        private val windowEndUs: Long,
        private val incoming: Boolean,
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
            val amount = if (incoming) {
                TransitionAlphaMath.incomingDipAmount(
                    startUs = windowStartUs,
                    endUs = windowEndUs,
                    presentationTimeUs = presentationTimeUs,
                )
            } else {
                TransitionAlphaMath.outgoingDipAmount(
                    startUs = windowStartUs,
                    endUs = windowEndUs,
                    presentationTimeUs = presentationTimeUs,
                )
            }
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatUniform("uAmount", amount)
                glProgram.setFloatsUniform("uColour", colour)
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

        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform float uAmount;
            uniform vec3 uColour;
            varying vec2 vTexSamplingCoord;

            void main() {
              vec4 color = texture2D(uTexSampler, vTexSamplingCoord);
              float amount = clamp(uAmount, 0.0, 1.0);
              gl_FragColor = vec4(mix(color.rgb, uColour, amount), color.a);
            }
        """
    }
}
