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
 * Background Blur as a ONE-INPUT GL composite: a blurred, fill-cropped copy of
 * the frame behind a sharp, fit-preserved copy of the same frame.
 *
 * Media3 1.11.0's `GaussianBlurWithFrameOverlaid` cannot express this: it blurs
 * the input it also overlays sharp, so with mismatched aspect ratios the sharp
 * layer would be a CROP of the picture rather than the whole picture — exactly
 * the portrait-on-landscape case this feature exists for. A custom fragment
 * shader can sample the same input twice with different UV mappings, which is
 * what this effect does.
 *
 * Geometry comes from [BackgroundBlurMath], computed from the frame the shader
 * actually receives (i.e. AFTER crop, rotation and transform), so rotation,
 * crop and Fit/Fill are honoured automatically. Intensity uses the same
 * `intensity / 5 * resolution / reference` formula as the preview
 * (`background/blur.ts`), pinned on both sides by tests with identical
 * fixtures.
 *
 * Bounded by construction: one input texture, one output texture, nine taps.
 */
class BackgroundBlurEffect(
    private val outputWidth: Int,
    private val outputHeight: Int,
    private val intensity: Float,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(outputWidth, outputHeight, intensity)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = intensity <= 0f

    private class Program(
        private val outputWidth: Int,
        private val outputHeight: Int,
        private val intensity: Float,
    ) : BaseGlShaderProgram(/* useHdr = */ false, /* texturePoolCapacity = */ 1) {

        private val glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)

        init {
            // Media3 only auto-creates no buffers: the quad positions come from
            // GlUtil exactly as every built-in effect does. Texture
            // coordinates are derived from the position in the vertex shader
            // (identical to the default texcoord buffer), so no second
            // attribute is needed.
            glProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                4,
            )
        }

        /** Fixed once `configure` reports the real post-effect input size. */
        private var layout: BackgroundBlurMath.Layout? = null

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            layout = BackgroundBlurMath.layout(
                sourceWidth = inputWidth,
                sourceHeight = inputHeight,
                outputWidth = outputWidth,
                outputHeight = outputHeight,
                intensity = intensity,
            )
            return Size(outputWidth, outputHeight)
        }

        override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
            val current = layout
                ?: BackgroundBlurMath.layout(
                    sourceWidth = outputWidth,
                    sourceHeight = outputHeight,
                    outputWidth = outputWidth,
                    outputHeight = outputHeight,
                    intensity = intensity,
                )
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform(
                    "uForegroundHalfSize",
                    floatArrayOf(current.foregroundHalfU, current.foregroundHalfV),
                )
                glProgram.setFloatsUniform(
                    "uBackdropScale",
                    floatArrayOf(current.backdropScaleU, current.backdropScaleV),
                )
                glProgram.setFloatsUniform(
                    "uBlurStep",
                    floatArrayOf(current.blurStepU, current.blurStepV),
                )
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
        /** Matches Media3's built-in shader attribute/varying names. */
        private const val VERTEX_SHADER = """
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        /**
         * Nine-tap Gaussian (1-2-1 separable, 16ths) in the BACKDROP's
         * normalised space. The foreground is a straight fit-mapped sample;
         * outside its rect the blurred backdrop shows. Sampling is a plain
         * linear remap, so the input's orientation is preserved (no flip).
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec2 uForegroundHalfSize;
            uniform vec2 uBackdropScale;
            uniform vec2 uBlurStep;
            varying vec2 vTexSamplingCoord;

            void main() {
              vec2 p = vTexSamplingCoord;

              // Backdrop: the frame scaled to FILL the canvas (cropped).
              vec2 bgUv = (p - 0.5) / uBackdropScale + 0.5;
              vec2 s = uBlurStep;

              vec4 blurred = texture2D(uTexSampler, bgUv) * 0.25;
              blurred += texture2D(uTexSampler, bgUv + vec2(s.x, 0.0)) * 0.125;
              blurred += texture2D(uTexSampler, bgUv - vec2(s.x, 0.0)) * 0.125;
              blurred += texture2D(uTexSampler, bgUv + vec2(0.0, s.y)) * 0.125;
              blurred += texture2D(uTexSampler, bgUv - vec2(0.0, s.y)) * 0.125;
              blurred += texture2D(uTexSampler, bgUv + vec2(s.x, s.y)) * 0.0625;
              blurred += texture2D(uTexSampler, bgUv + vec2(-s.x, s.y)) * 0.0625;
              blurred += texture2D(uTexSampler, bgUv + vec2(s.x, -s.y)) * 0.0625;
              blurred += texture2D(uTexSampler, bgUv - vec2(s.x, s.y)) * 0.0625;

              // Foreground: the frame scaled to FIT the canvas, sharp.
              vec2 fgUv = (p - (0.5 - uForegroundHalfSize)) / (2.0 * uForegroundHalfSize);
              if (fgUv.x >= 0.0 && fgUv.x <= 1.0 && fgUv.y >= 0.0 && fgUv.y <= 1.0) {
                gl_FragColor = texture2D(uTexSampler, fgUv);
              } else {
                gl_FragColor = blurred;
              }
            }
        """
    }
}
