package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.MediaMetadataRetriever
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlCrop
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Crop, end to end on the native path: a deterministic four-quadrant fixture
 * (red / green / blue / yellow, 320x240) is exported through the real
 * [Media3Exporter] with a normalised crop rectangle, then DECODED and its
 * pixels sampled. Data-model tests cannot prove the crop reached Media3's
 * effect chain; these decoded frames can.
 *
 * Expected geometry: cropping to a half-width region yields a 160x240 frame,
 * which the per-item `Presentation` fits into the 320x240 canvas as a centred
 * 160x240 picture with black pillarbox bars. Samples are therefore taken at
 * the horizontal centre of the frame. Top/bottom crops are 320x120 and are
 * sampled at the vertical centre.
 */
@RunWith(AndroidJUnit4::class)
class ExportCropInstrumentedTest {
    private lateinit var context: Context
    private val ticksPerSecond = 120_000L

    private val red = Color.rgb(255, 0, 0)
    private val green = Color.rgb(0, 255, 0)
    private val blue = Color.rgb(0, 0, 255)
    private val yellow = Color.rgb(255, 255, 0)

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    @After
    fun tearDown() {}

    /** Four sharply distinguishable quadrants; PNG keeps the source lossless. */
    private fun createQuadrantPng(width: Int = 320, height: Int = 240): File {
        val target = File(context.cacheDir, "crop_quadrants_${System.nanoTime()}.png")
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        fun fill(left: Int, top: Int, right: Int, bottom: Int, color: Int) {
            paint.color = color
            paint.style = Paint.Style.FILL
            canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        }
        fill(0, 0, width / 2, height / 2, red) // top-left
        fill(width / 2, 0, width, height / 2, green) // top-right
        fill(0, height / 2, width / 2, height, blue) // bottom-left
        fill(width / 2, height / 2, width, height, yellow) // bottom-right
        target.outputStream().use { out ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) { "PNG encode failed" }
        }
        bitmap.recycle()
        return target
    }

    private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

    private fun buildEdl(source: File, crop: EdlCrop?): Edl {
        val clipTicks = ticksPerSecond / 2 // 500 ms
        val asset = EdlAsset(
            assetId = "asset-quadrants",
            kind = EdlAssetKind.IMAGE,
            name = source.name,
            sourceUri = source.toURI().toString(),
            codec = null,
            width = 320,
            height = 240,
            durationTicks = 2 * ticksPerSecond,
            rotationDegrees = 0,
            hasAudio = false,
        )
        val clip = EdlClip(
            clipId = "clip-a",
            kind = "image",
            assetId = "asset-quadrants",
            name = "quadrants",
            startTicks = 0,
            durationTicks = clipTicks,
            sourceStartTicks = 0,
            sourceEndTicks = clipTicks,
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = identityTransform(),
            opacity = 1.0,
            framing = "fit",
            crop = crop ?: EdlCrop(),
            effects = emptyList(),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        val mainTrack = EdlTrack(
            trackId = "track-main",
            kind = EdlTrackKind.MAIN,
            trackType = EdlTrackType.VIDEO,
            name = "Main",
            zIndex = 0,
            muted = false,
            hidden = false,
            clips = listOf(clip),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-crop-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = 320,
                canvasHeight = 240,
                projectId = "proj-crop",
                projectName = "Crop Fixture",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = clipTicks,
            ),
            assets = listOf(asset),
            tracks = listOf(mainTrack),
            transitions = emptyList(),
            overlays = emptyList(),
            output = EdlOutput(
                container = "mp4",
                videoCodec = "avc1",
                audioCodec = "mp4a",
                bitrate = 4_000_000,
                fps = EdlRational(30, 1),
                resolutionWidth = 320,
                resolutionHeight = 240,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl, name: String): File {
        val out = File(context.cacheDir, "crop_${name}_${System.nanoTime()}.mp4")
        out.delete()
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, out) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue(
            "export '$name' did not terminate within 180s: $events",
            latch.await(180, TimeUnit.SECONDS),
        )
        val terminal = events.lastOrNull()
        assertTrue("export '$name' failed: $terminal", terminal is Media3Exporter.Event.Done)
        assertTrue("export '$name' wrote no file", out.exists() && out.length() > 0)
        return out
    }

    private enum class Channel { RED, GREEN, BLUE, YELLOW, BLACK }

    private fun dominant(x: Int): Channel {
        val r = (x shr 16) and 0xFF
        val g = (x shr 8) and 0xFF
        val b = x and 0xFF
        return when {
            maxOf(r, g, b) < 40 -> Channel.BLACK
            r > 96 && g > 96 && b < 96 -> Channel.YELLOW
            r > 96 && b > 96 && g < 96 -> Channel.YELLOW
            r > g && r > b -> Channel.RED
            g > r && g > b -> Channel.GREEN
            else -> Channel.BLUE
        }
    }

    /** Mean colour over a 9x9 box around (fractionX, fractionY) of the frame. */
    private fun sample(file: File, fractionX: Double, fractionY: Double): Channel {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.absolutePath)
            val frame = retriever.getFrameAtTime(
                200_000L,
                MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
            ) ?: throw AssertionError("undecodable export: no frame in ${file.name}")
            val bmp = frame.copy(Bitmap.Config.ARGB_8888, false)
                ?: throw AssertionError("could not convert frame of ${file.name}")
            val cx = (bmp.width * fractionX).toInt().coerceIn(4, bmp.width - 5)
            val cy = (bmp.height * fractionY).toInt().coerceIn(4, bmp.height - 5)
            var r = 0L
            var g = 0L
            var b = 0L
            var n = 0
            for (y in cy - 4..cy + 4) {
                for (x in cx - 4..cx + 4) {
                    val p = bmp.getPixel(x, y)
                    r += (p shr 16) and 0xFF
                    g += (p shr 8) and 0xFF
                    b += p and 0xFF
                    n++
                }
            }
            bmp.recycle()
            frame.recycle()
            val packed = (((r / n).toInt() and 0xFF) shl 16) or
                (((g / n).toInt() and 0xFF) shl 8) or
                ((b / n).toInt() and 0xFF)
            return dominant(packed)
        } finally {
            retriever.release()
        }
    }

    @Test
    fun crop_keeps_the_requested_source_region_in_decoded_frames() {
        val source = createQuadrantPng()
        data class Case(
            val name: String,
            val crop: EdlCrop?,
            /** Fractional sample points and the quadrant each must land on. */
            val samples: List<Triple<Double, Double, Channel>>,
        )
        val cases = listOf(
            Case(
                "uncropped",
                null,
                listOf(
                    Triple(0.25, 0.25, Channel.RED),
                    Triple(0.75, 0.25, Channel.GREEN),
                    Triple(0.25, 0.75, Channel.BLUE),
                    Triple(0.75, 0.75, Channel.YELLOW),
                ),
            ),
            Case(
                "left-half",
                EdlCrop(0.0, 0.0, 0.5, 1.0),
                listOf(
                    Triple(0.5, 0.25, Channel.RED),
                    Triple(0.5, 0.75, Channel.BLUE),
                ),
            ),
            Case(
                "right-half",
                EdlCrop(0.5, 0.0, 0.5, 1.0),
                listOf(
                    Triple(0.5, 0.25, Channel.GREEN),
                    Triple(0.5, 0.75, Channel.YELLOW),
                ),
            ),
            Case(
                "top-half",
                EdlCrop(0.0, 0.0, 1.0, 0.5),
                listOf(
                    Triple(0.25, 0.5, Channel.RED),
                    Triple(0.75, 0.5, Channel.GREEN),
                ),
            ),
            Case(
                "bottom-half",
                EdlCrop(0.0, 0.5, 1.0, 0.5),
                listOf(
                    Triple(0.25, 0.5, Channel.BLUE),
                    Triple(0.75, 0.5, Channel.YELLOW),
                ),
            ),
            Case(
                "centre-quarter",
                EdlCrop(0.6, 0.6, 0.3, 0.3),
                listOf(Triple(0.5, 0.5, Channel.YELLOW)),
            ),
            Case(
                "off-centre",
                EdlCrop(0.1, 0.6, 0.3, 0.3),
                listOf(Triple(0.5, 0.5, Channel.BLUE)),
            ),
        )

        try {
            for (case in cases) {
                val out = export(buildEdl(source, case.crop), case.name)
                try {
                    for ((fx, fy, expected) in case.samples) {
                        val actual = sample(out, fx, fy)
                        assertTrue(
                            "crop '${case.name}': sample at (${fx}, ${fy}) expected $expected " +
                                "but decoded frames read $actual (${out.name})",
                            actual == expected,
                        )
                    }
                } finally {
                    out.delete()
                }
            }
        } finally {
            source.delete()
        }
    }
}
