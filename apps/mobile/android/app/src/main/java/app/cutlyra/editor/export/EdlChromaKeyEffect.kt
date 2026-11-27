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
import app.cutlyra.editor.edl.EdlEffect

/**
 * A [GlEffect] that keys one chroma-key effect out of the frame's ALPHA channel.
 *
 * Ordering matches the preview's effect stack: `EdlToComposition` walks the
 * clip's enabled effects in EDL order and, for a `chroma-key` entry, inserts
 * this pass at exactly that position — so a key added after an Adjust is
 * evaluated after that Adjust on both renderers (the preview runs the same
 * order through `resolveEffectPassGroups`).
 *
 * Keyed pixels become transparent, which is what lets lower video/image layers
 * show through; the masked-pixel path already proved per-layer alpha survives
 * into the encoded MP4, so this pass is the only new mechanism.
 *
 * Numbers come from [ChromaKeyMath] (the port of `effects/chroma-key.ts`);
 * this class owns only the GL plumbing.
 */
class EdlChromaKeyEffect(
    private val clip: EdlClip,
    private val effect: EdlEffect,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        Program(clip, ChromaKeyMath.uniforms(effect.params))

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private class Program(
        private val clip: EdlClip,
        private val uniforms: ChromaKeyUniforms,
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
            try {
                glProgram.use()
                glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
                glProgram.setFloatsUniform("uKey", uniforms.key())
                glProgram.setFloatUniform("uSimilarity", uniforms.similarity)
                glProgram.setFloatUniform("uSoftness", uniforms.softness)
                glProgram.setFloatUniform("uSpill", uniforms.spill)
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
         * Same formula as `chroma_key.wgsl` and `ChromaKeyMath.alpha()`: the
         * distance is measured between Rec.709 Cb/Cr pairs, and the alpha ramp
         * is `smoothstep(similarity, similarity + softness, distance)`.
         * Spill reduction pulls the green channel toward `max(r, b)` only where
         * green dominates, so a kept subject is left alone.
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec3 uKey;
            uniform float uSimilarity;
            uniform float uSoftness;
            uniform float uSpill;
            varying vec2 vTexSamplingCoord;

            vec2 chroma(vec3 c) {
              float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
              return vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748);
            }

            void main() {
              vec4 color = texture2D(uTexSampler, vTexSamplingCoord);
              float distanceChromakey = length(chroma(color.rgb) - chroma(uKey));
              float edge = max(uSoftness, 0.0001);
              float alpha = smoothstep(uSimilarity, uSimilarity + edge, distanceChromakey);

              float excess = max(0.0, color.g - max(color.r, color.b));
              vec3 rgb = vec3(color.r, max(0.0, color.g - excess * uSpill), color.b);

              gl_FragColor = vec4(rgb, color.a * alpha);
            }
        """
    }
}
