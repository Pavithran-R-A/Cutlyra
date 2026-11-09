package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.test.R
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GitHub #22 — clip-to-canvas framing: `fit` preserves the whole source
 * frame (letter/pillarboxing against the canvas/background) while `fill`
 * scales to cover the canvas and crops overflow. The preview compositor and
 * the native Media3 export path must agree, and the authored framing must
 * survive the EDL (persistence/reopen/undo is covered on the TS side).
 *
 * Uses the standard instrumentation `R.raw.test_clip` (320x240, 4:3). A 4:3
 * source exported to a 9:16 portrait canvas in `fit` mode produces large
 * dark bars above/below the picture; `fill` covers the whole frame so those
 * edge regions contain picture content instead of a uniform dark bar.
 */
@RunWith(AndroidJUnit4::class)
class ExportFramingInstrumentedTest {
	private lateinit var context: Context
	private lateinit var testContext: Context
	private lateinit var sourceClip: File

	private val ticksPerSecond = 120_000L

	@Before
	fun setUp() {
		context = ApplicationProvider.getApplicationContext()
		testContext = InstrumentationRegistry.getInstrumentation().context
		sourceClip = File(context.cacheDir, "framing_source_${System.nanoTime()}.mp4")
		testContext.resources.openRawResource(R.raw.test_clip).use { input ->
			sourceClip.outputStream().use { output -> input.copyTo(output) }
		}
	}

	@After
	fun tearDown() {
		sourceClip.delete()
	}

	private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

	private fun buildEdl(framing: String): Edl {
		val clipTicks = ticksPerSecond / 2 // 500 ms
		val asset = EdlAsset(
			assetId = "asset-1",
			kind = EdlAssetKind.VIDEO,
			name = sourceClip.name,
			sourceUri = sourceClip.toURI().toString(),
			codec = null,
			width = 320,
			height = 240,
			durationTicks = 2 * ticksPerSecond,
			rotationDegrees = 0,
			hasAudio = true,
		)
		val clip = EdlClip(
			clipId = "clip-a",
			kind = "video",
			assetId = "asset-1",
			name = "a",
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
			framing = framing,
			effects = emptyList(),
			hasMasks = false,
			animations = emptyList(),
			params = mapOf("framing" to framing),
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
		// Portrait 9:16 canvas vs landscape 4:3 source: fit letterboxes top/bottom,
		// fill crops horizontally to cover the whole frame.
		return Edl(
			meta = EdlMeta(
				edlVersion = 1,
				generator = "cutlyra-framing-test",
				ticksPerSecond = ticksPerSecond,
				frameRate = EdlRational(30, 1),
				canvasWidth = 1080,
				canvasHeight = 1920,
				projectId = "proj-framing",
				projectName = "Framing Fixture",
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
				resolutionWidth = 1080,
				resolutionHeight = 1920,
				includeAudio = true,
			),
		)
	}

	private fun export(edl: Edl, name: String): File {
		val out = File(context.cacheDir, "framing_${name}_${System.nanoTime()}.mp4")
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
			"export '$name' did not terminate within 120s: $events",
			latch.await(120, TimeUnit.SECONDS),
		)
		val terminal = events.lastOrNull()
		assertTrue("export '$name' failed: $terminal", terminal is Media3Exporter.Event.Done)
		assertTrue("export '$name' wrote no file", out.exists() && out.length() > 0)
		return out
	}

	private data class Border(val top: Int, val bottom: Int)

	/**
	 * Measures how many contiguous dark rows exist at the top and bottom of a
	 * sampled frame. A pixel counts as "dark bar" when its max channel is below
	 * [darkThreshold] (composition background/bars are black). Picture content
	 * from the encoded test clip is not uniformly dark across a full row.
	 */
	private fun measureVerticalDarkBars(file: File, atUs: Long = 200_000L): Border {
		val retriever = MediaMetadataRetriever()
		try {
			retriever.setDataSource(file.absolutePath)
			val frame = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
				?: throw AssertionError("undecodable export: no frame at ${atUs}us in ${file.name}")
			val bmp = frame.copy(Bitmap.Config.ARGB_8888, false)
				?: throw AssertionError("could not convert frame of ${file.name}")
			val px = IntArray(bmp.width * bmp.height)
			bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)

			fun isDarkRow(y: Int): Boolean {
				val row = y * bmp.width
				var dark = 0
				// Sample across the row (every 4th pixel) for speed/robustness.
				var x = 0
				var samples = 0
				while (x < bmp.width) {
					val p = px[row + x]
					val r = (p shr 16) and 0xFF
					val g = (p shr 8) and 0xFF
					val b = p and 0xFF
					val maxC = maxOf(r, g, b)
					if (maxC < 24) dark++
					samples++
					x += 4
				}
				return samples > 0 && dark.toFloat() / samples >= 0.90f
			}

			var top = 0
			while (top < bmp.height && isDarkRow(top)) top++
			var bottom = 0
			var y = bmp.height - 1
			while (y >= 0 && isDarkRow(y)) {
				bottom++
				y--
			}
			bmp.recycle()
			frame.recycle()
			return Border(top = top, bottom = bottom)
		} finally {
			retriever.release()
		}
	}

	@Test
	fun fitLetterboxesMismatchedSource_and_fillCoversCanvas() {
		// 4:3 source in 9:16 canvas -> fit yields ~555px bars top+bottom;
		// fill covers the full 9:16 frame (bars ~0).
		val fitOut = export(buildEdl("fit"), "fit")
		val fillOut = export(buildEdl("fill"), "fill")
		try {
			val fitBars = measureVerticalDarkBars(fitOut)
			val fillBars = measureVerticalDarkBars(fillOut)
			assertTrue(
				"fit framing must preserve the whole frame with visible letterbox bars " +
					"(expected substantial dark top/bottom bars for 4:3 in 9:16), got $fitBars",
				fitBars.top >= 120 && fitBars.bottom >= 120,
			)
			assertTrue(
				"fill framing must crop to cover the canvas without letterbox bars, got $fillBars " +
					"(fit produced $fitBars)",
				fillBars.top <= 40 && fillBars.bottom <= 40,
			)
			// Sanity: fill must materially reduce bars compared to fit.
			assertTrue(
				"fill must remove most fit letterbox bars (fit=$fitBars fill=$fillBars)",
				(fillBars.top + fillBars.bottom) < (fitBars.top + fitBars.bottom) / 2,
			)
		} finally {
			fitOut.delete()
			fillOut.delete()
		}
	}
}
