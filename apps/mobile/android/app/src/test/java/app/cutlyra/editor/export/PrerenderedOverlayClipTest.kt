package app.cutlyra.editor.export

import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTransform
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression (Milestone 2, stickers): a project containing a sticker used to
 * fail export with `ExportUnsupportedException: ... has no assetId`, because
 * sticker clips live on a GRAPHIC overlay track and were built as PiP media
 * items. Their pixels come from the webview's prerendered overlay frames, so
 * they must be skipped by the media pipeline instead.
 */
class PrerenderedOverlayClipTest {
    private fun clip(kind: String, assetId: String?): EdlClip = EdlClip(
        clipId = "clip-$kind",
        kind = kind,
        assetId = assetId,
        name = kind,
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
        effects = emptyList(),
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    @Test
    fun stickersAndGraphicsArePrerenderedOverlays() {
        assertTrue(EdlToComposition.isPrerenderedOverlayClip(clip("sticker", null)))
        assertTrue(EdlToComposition.isPrerenderedOverlayClip(clip("graphic", null)))
        assertTrue(EdlToComposition.isPrerenderedOverlayClip(clip("text", null)))
        assertTrue(EdlToComposition.isPrerenderedOverlayClip(clip("caption", null)))
    }

    @Test
    fun mediaClipsStayInTheMediaPipeline() {
        assertFalse(EdlToComposition.isPrerenderedOverlayClip(clip("video", "asset-1")))
        assertFalse(EdlToComposition.isPrerenderedOverlayClip(clip("image", "asset-2")))
        // A video clip that lost its asset must NOT be silently dropped: the
        // exporter still needs to surface that as an error to the user.
        assertFalse(EdlToComposition.isPrerenderedOverlayClip(clip("video", null)))
    }
}
