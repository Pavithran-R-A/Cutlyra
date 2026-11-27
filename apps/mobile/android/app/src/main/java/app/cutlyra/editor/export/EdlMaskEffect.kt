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
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlMask

/**
 * A [GlEffect] that applies one clip mask to the frame's ALPHA channel.
 *
 * Ordering matches the preview compositor. `Crop` changes the frame size, so
 * Media3 runs it inline and this pass sees the CROPPED frame — the same canvas
 * the preview draws its mask texture on. `EdlTransformEffect`
 * (scale/rotate/position/flip) and the per-item `Presentation` are
 * size-preserving matrices that Media3 applies to the finished chain, so the
 * mask is evaluated BEFORE the element transform and the matrix then carries
 * the masked picture as one unit. Putting this pass after
 * `EdlTransformEffect` made the mask a fixed window over the canvas that the
 * clip slid underneath (measured on decoded frames).
 *
 * Masked-out regions become transparent, which is what lets lower video/image
 * layers show through when the clip is an overlay.
 *
 * Geometry comes from [MaskMath]; this class only owns the GL plumbing. The
 * shader's distances use the same `smoothstep(-feather/2, +feather/2, sdf)`
 * ramp as the preview's JFA distance shader
 * (`rust/crates/masks/src/shaders/jfa_distance.wgsl`).
 */
class EdlMaskEffect(
    private val clip: EdlClip,
    private val mask: EdlMask,
    private val canvasWidth: Int,
    private val canvasHeight: Int,
    /** Composition-time start of this item, microseconds — local tick 0. */
    private val itemStartUs: Long,
    private val ticksPerSecond: Long,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(clip, mask, canvasWidth, canvasHeight, itemStartUs, ticksPerSecond)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private class Program(
        private val clip: EdlClip,
        private val mask: EdlMask,
        private val canvasWidth: Int,
        private val canvasHeight: Int,
        private val itemStartUs: Long,
        private val ticksPerSecond: Long,
    ) : BaseGlShaderProgram(/* useHdr = */ false, /* texturePoolCapacity = */ 1) {

        private val glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        private val channels = KeyframeEvaluator.visualChannels(clip)
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
            val transform = if (channels.isEmpty()) {
                clip.transform
            } else {
                val localTicks = KeyframeEvaluator.localTicks(
                    presentationTimeUs = presentationTimeUs,
                    itemStartUs = itemStartUs,
                    ticksPerSecond = ticksPerSecond,
                    durationTicks = clip.durationTicks,
                )
                KeyframeEvaluator.resolveTransform(clip.transform, channels, localTicks)
            }
            val uniforms = MaskMath.uniformsFor(
                inputWidth = inputWidth,
                inputHeight = inputHeight,
                mask = mask,
                transform = transform,
                framing = clip.framing,
                canvasWidth = canvasWidth,
                canvasHeight = canvasHeight,
            ) ?: return
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform(
                    "uResolution",
                    floatArrayOf(inputWidth.toFloat(), inputHeight.toFloat()),
                )
                glProgram.setFloatsUniform(
                    "uCenter",
                    floatArrayOf(uniforms.centerX, uniforms.centerY),
                )
                glProgram.setFloatsUniform(
                    "uHalfSize",
                    floatArrayOf(uniforms.halfWidth, uniforms.halfHeight),
                )
                glProgram.setFloatUniform("uRotation", uniforms.rotationRadians)
                glProgram.setFloatUniform("uFeather", uniforms.featherPixels)
                glProgram.setFloatUniform("uInverted", if (uniforms.inverted) 1f else 0f)
                glProgram.setFloatUniform("uShape", uniforms.shape)
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
         * Signed distances are POSITIVE INSIDE the mask, matching
         * `jfa_distance.wgsl` (`smoothstep(-feather_half, feather_half,
         * signed_distance)`). Rectangles use the exact box SDF; ellipses use
         * the standard first-order approximation (adequate at the feathered
         * edge and identical at the centre/outside limits the fixtures
         * assert); the linear mask is a half-plane.
         *
         * Y AXIS: `vTexSamplingCoord` runs bottom-up in this stage's texture,
         * so the geometry flips it (`1.0 - v`) while the sampler keeps the
         * original coordinate. Without the flip a rotated mask came out
         * mirrored about the horizontal centre line (a 30 deg mask measured
         * its long-edge feather midpoint at the -30 deg position on decoded
         * frames), so `centerY` and `rotation` disagreed with the preview,
         * which authors both with y pointing DOWN.
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec2 uResolution;
            uniform vec2 uCenter;
            uniform vec2 uHalfSize;
            uniform float uRotation;
            uniform float uFeather;
            uniform float uInverted;
            uniform float uShape;
            varying vec2 vTexSamplingCoord;

            float sdBox(vec2 p, vec2 b) {
              vec2 d = abs(p) - b;
              return length(max(d, vec2(0.0, 0.0))) + min(max(d.x, d.y), 0.0);
            }

            float sdEllipse(vec2 p, vec2 r) {
              float k = length(p / r);
              return (1.0 - k) * min(r.x, r.y);
            }

            void main() {
              vec4 color = texture2D(uTexSampler, vTexSamplingCoord);
              vec2 pixel = vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y) * uResolution;
              vec2 p = pixel - uCenter;

              float c = cos(-uRotation);
              float s = sin(-uRotation);
              p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);

              float sd;
              if (uShape < 0.5) {
                sd = -sdBox(p, uHalfSize);
              } else if (uShape < 1.5) {
                sd = sdEllipse(p, uHalfSize);
              } else {
                // Linear/split: the mask covers the positive side of the
                // local +x axis; the centre and rotation uniforms define the
                // line, exactly like `splitLineGeometry` in the engine.
                sd = p.x;
              }

              float halfFeather = uFeather * 0.5;
              float alpha = smoothstep(-halfFeather, halfFeather, sd);
              if (uInverted > 0.5) {
                alpha = 1.0 - alpha;
              }

              gl_FragColor = vec4(color.rgb, color.a * alpha);
            }
        """
    }
}
