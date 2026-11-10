package app.cutlyra.editor.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLExt
import android.opengl.GLES20
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Replace Clip (#74) — native export half of the guarantee.
 *
 * The editor-side command (packages/editor-core, `ReplaceClipMediaCommand`)
 * repoints one clip at a different media asset and proves, on the timeline
 * model, that identity/track/position/trim/framing/transform/effects/keyframes
 * survive and that the EDL resolves the new asset. What Kotlin has to prove is
 * the other half: once a clip's `assetId`/`sourceUri` change, the REAL
 * Media3 export renders the NEW source, no longer renders the old one, keeps
 * the timeline's duration, produces no black tail, and still handles a
 * mixed-source timeline.
 *
 * These are deliberate replacements, not "two clips": the same EDL is exported
 * twice with only the clip's asset changed, exactly the delta a replacement
 * makes, so a difference in the decoded pixels can only come from the swap.
 *
 * Fixtures are synthesized here (solid colour, 320x320, 30fps) because the
 * exported pixel colour is the assertion and the shared `R.raw.test_clip`
 * cannot distinguish two sources.
 */
@RunWith(AndroidJUnit4::class)
class ExportReplaceClipInstrumentedTest {
	private lateinit var context: Context
	private val ticksPerSecond = 120_000L
	private val srcSize = 320
	private val red = 0xFFFF0000.toInt()
	private val green = 0xFF00FF00.toInt()

	@Before
	fun setUp() {
		context = ApplicationProvider.getApplicationContext()
	}

	@After
	fun tearDown() {
		// Fixtures are per-test files in cacheDir; the test body deletes them.
	}

	private fun tmp(name: String): File = File(context.cacheDir, "replace_${name}_${System.nanoTime()}.mp4")

	private fun identityTransform() = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0)

	private fun assetFor(id: String, file: File, durationSeconds: Double): EdlAsset = EdlAsset(
		assetId = id,
		kind = EdlAssetKind.VIDEO,
		name = file.name,
		sourceUri = file.toURI().toString(),
		codec = "avc1",
		width = srcSize,
		height = srcSize,
		durationTicks = (durationSeconds * ticksPerSecond).toLong(),
		rotationDegrees = 0,
		hasAudio = false,
	)

	private fun clipFor(
		clipId: String,
		assetId: String,
		startTicks: Long,
		durationTicks: Long,
	): EdlClip = EdlClip(
		clipId = clipId,
		kind = "video",
		assetId = assetId,
		name = assetId,
		startTicks = startTicks,
		durationTicks = durationTicks,
		sourceStartTicks = 0,
		sourceEndTicks = durationTicks,
		speed = EdlRational(1, 1),
		maintainPitch = false,
		volumeDb = 0.0,
		muted = false,
		hidden = false,
		transform = identityTransform(),
		opacity = 1.0,
		framing = "fill",
		effects = emptyList(),
		hasMasks = false,
		animations = emptyList(),
		params = mapOf("framing" to "fill"),
	)

	private fun edlOf(
		assets: List<EdlAsset>,
		clips: List<EdlClip>,
		durationTicks: Long,
	): Edl = Edl(
		meta = EdlMeta(
			edlVersion = 1,
			generator = "cutlyra-replace-clip-test",
			ticksPerSecond = ticksPerSecond,
			frameRate = EdlRational(30, 1),
			canvasWidth = srcSize,
			canvasHeight = srcSize,
			projectId = "proj-replace",
			projectName = "Replace Clip Fixture",
			sceneId = "scene-1",
			sceneName = "Scene 1",
			durationTicks = durationTicks,
		),
		assets = assets,
		tracks = listOf(
			EdlTrack(
				trackId = "track-main",
				kind = EdlTrackKind.MAIN,
				trackType = EdlTrackType.VIDEO,
				name = "Main",
				zIndex = 0,
				muted = false,
				hidden = false,
				clips = clips,
			),
		),
		transitions = emptyList(),
		overlays = emptyList(),
		output = EdlOutput(
			container = "mp4",
			videoCodec = "avc1",
			audioCodec = "mp4a",
			bitrate = 4_000_000,
			fps = EdlRational(30, 1),
			resolutionWidth = srcSize,
			resolutionHeight = srcSize,
			includeAudio = false,
		),
	)

	/** Solid-colour H.264 fixture drawn through an EGL surface. */
	private fun createSolidVideo(target: File, color: Int, seconds: Double = 1.5): File {
		val fps = 30
		val frameCount = (seconds * fps).toInt().coerceAtLeast(15)
		val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, srcSize, srcSize).apply {
			setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
			setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
			setInteger(MediaFormat.KEY_FRAME_RATE, fps)
			setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
		}
		val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
		encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
		val inputSurface: SurfaceTexture? = null
		val encoderSurface = encoder.createInputSurface()
		encoder.start()
		val muxer = MediaMuxer(target.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
		var muxerStarted = false
		var trackIndex = -1
		val info = MediaCodec.BufferInfo()

		val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
		check(EGL14.eglInitialize(display, null, 0, null, 0)) { "eglInitialize failed" }
		val attribs = intArrayOf(
			EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
			EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, 0x3142, 1, EGL14.EGL_NONE,
		)
		val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
		val numConfigs = IntArray(1)
		check(EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, numConfigs, 0)) { "eglChooseConfig failed" }
		val config = checkNotNull(configs[0])
		val eglContext = EGL14.eglCreateContext(
			display, config, EGL14.EGL_NO_CONTEXT,
			intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
		)
		val eglSurface = EGL14.eglCreateWindowSurface(display, config, encoderSurface, intArrayOf(EGL14.EGL_NONE), 0)
		check(EGL14.eglMakeCurrent(display, eglSurface, eglSurface, eglContext)) { "eglMakeCurrent failed" }

		fun drain(endOfStream: Boolean) {
			val timeout = if (endOfStream) 10_000L else 0L
			while (true) {
				val index = encoder.dequeueOutputBuffer(info, timeout)
				when {
					index == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return
					index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
						trackIndex = muxer.addTrack(encoder.outputFormat)
						muxer.start()
						muxerStarted = true
					}
					index >= 0 -> {
						val encoded = checkNotNull(encoder.getOutputBuffer(index))
						if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
						if (info.size > 0 && muxerStarted) {
							encoded.position(info.offset)
							encoded.limit(info.offset + info.size)
							muxer.writeSampleData(trackIndex, encoded, info)
						}
						val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
						encoder.releaseOutputBuffer(index, false)
						if (eos) return
					}
				}
			}
		}

		try {
			GLES20.glEnable(GLES20.GL_SCISSOR_TEST)
			GLES20.glScissor(0, 0, srcSize, srcSize)
			GLES20.glClearColor(
				((color shr 16) and 0xFF) / 255f,
				((color shr 8) and 0xFF) / 255f,
				(color and 0xFF) / 255f,
				1f,
			)
			var ptsNs = 0L
			repeat(frameCount) {
				GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
				EGLExt.eglPresentationTimeANDROID(display, eglSurface, ptsNs)
				EGL14.eglSwapBuffers(display, eglSurface)
				drain(false)
				ptsNs += 1_000_000_000L / fps
			}
			encoder.signalEndOfInputStream()
			drain(true)
		} finally {
			EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
			EGL14.eglDestroySurface(display, eglSurface)
			EGL14.eglDestroyContext(display, eglContext)
			EGL14.eglTerminate(display)
			encoder.stop()
			encoder.release()
			if (muxerStarted) muxer.stop()
			muxer.release()
			encoderSurface.release()
			inputSurface?.release()
		}
		assertTrue("fixture not written: ${target.name}", target.exists() && target.length() > 0)
		return target
	}

	private fun export(edl: Edl, name: String): File {
		val out = tmp(name)
		out.delete()
		val latch = CountDownLatch(1)
		val events = mutableListOf<Media3Exporter.Event>()
		Media3Exporter.start(context, edl, out) { event ->
			events.add(event)
			if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) latch.countDown()
		}
		assertTrue("export '$name' did not terminate within 180s: $events", latch.await(180, TimeUnit.SECONDS))
		val terminal = events.lastOrNull()
		assertTrue("export '$name' failed: $terminal", terminal is Media3Exporter.Event.Done)
		assertTrue("export '$name' wrote no file", out.exists() && out.length() > 0)
		return out
	}

	/** Video track length of an exported file, in microseconds. */
	private fun videoDurationUs(file: File): Long {
		val extractor = MediaExtractor()
		try {
			extractor.setDataSource(file.absolutePath)
			for (index in 0 until extractor.trackCount) {
				val format = extractor.getTrackFormat(index)
				val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
				if (!mime.startsWith("video/")) continue
				return if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L
			}
			return 0L
		} finally {
			extractor.release()
		}
	}

	private data class Rgb(val r: Int, val g: Int, val b: Int) {
		override fun toString() = "rgb($r,$g,$b)"
	}

	/**
	 * Mean colour of the frame's central region. Sampling the middle (not a
	 * single pixel) keeps the assertion stable against encoder chroma noise and
	 * scale filtering at the edges.
	 */
	private fun centerColor(file: File, atUs: Long): Rgb {
		val retriever = MediaMetadataRetriever()
		try {
			retriever.setDataSource(file.absolutePath)
			val decoded = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
				?: throw AssertionError("no decodable frame at ${atUs}us in ${file.name}")
			val bmp = decoded.copy(Bitmap.Config.ARGB_8888, false)
				?: throw AssertionError("could not convert frame of ${file.name}")
			decoded.recycle()
			try {
				val w = bmp.width
				val h = bmp.height
				val x0 = w * 3 / 10
				val x1 = w * 7 / 10
				val y0 = h * 3 / 10
				val y1 = h * 7 / 10
				var r = 0L
				var g = 0L
				var b = 0L
				var n = 0
				var y = y0
				while (y < y1) {
					var x = x0
					while (x < x1) {
						val p = bmp.getPixel(x, y)
						r += (p shr 16) and 0xFF
						g += (p shr 8) and 0xFF
						b += p and 0xFF
						n++
						x += 8
					}
					y += 8
				}
				require(n > 0) { "no samples" }
				return Rgb((r / n).toInt(), (g / n).toInt(), (b / n).toInt())
			} finally {
				bmp.recycle()
			}
		} finally {
			retriever.release()
		}
	}

	private fun isClose(actual: Rgb, expected: Rgb, tolerance: Int = 60): Boolean =
		abs(actual.r - expected.r) <= tolerance &&
			abs(actual.g - expected.g) <= tolerance &&
			abs(actual.b - expected.b) <= tolerance

	private val RED = Rgb(255, 0, 0)
	private val GREEN = Rgb(0, 255, 0)

	@Test
	fun replaced_asset_renders_new_source_and_keeps_timing() {
		val oldSource = createSolidVideo(tmp("old"), red)
		val newSource = createSolidVideo(tmp("new"), green)
		val clipTicks = ticksPerSecond * 4 / 5 // 800 ms
		val oldAsset = assetFor("asset-old", oldSource, 1.5)
		val newAsset = assetFor("asset-new", newSource, 1.5)
		val clip = clipFor("clip-a", "asset-old", 0, clipTicks)

		val before = export(edlOf(listOf(oldAsset), listOf(clip), clipTicks), "before")
		// The ONLY delta a replacement makes in the EDL: the clip's assetId.
		val after = export(edlOf(listOf(newAsset), listOf(clip.copy(assetId = "asset-new")), clipTicks), "after")
		try {
			val beforeColor = centerColor(before, 300_000)
			val afterColor = centerColor(after, 300_000)
			assertTrue(
				"baseline clip must render its own source, got $beforeColor",
				isClose(beforeColor, RED),
			)
			assertTrue(
				"after replacement the clip must render the NEW source ($GREEN), got $afterColor",
				isClose(afterColor, GREEN),
			)
			assertTrue(
				"the replaced clip must no longer show the old source at 300ms, got $afterColor",
				!isClose(afterColor, RED),
			)

			val beforeUs = videoDurationUs(before)
			val afterUs = videoDurationUs(after)
			val expectedUs = clipTicks * 1_000_000L / ticksPerSecond // 800_000
			assertTrue(
				"replacement must not change the clip duration: before=$beforeUs after=$afterUs expected=$expectedUs",
				abs(beforeUs - expectedUs) <= 150_000 && abs(afterUs - expectedUs) <= 150_000,
			)
			assertTrue(
				"replacement must not change duration relative to the original export: before=$beforeUs after=$afterUs",
				abs(afterUs - beforeUs) <= 100_000,
			)
		} finally {
			before.delete()
			after.delete()
			oldSource.delete()
			newSource.delete()
		}
	}

	@Test
	fun longer_replacement_does_not_stretch_the_clip_or_add_a_black_tail() {
		// A 3s replacement into a 700ms clip: the timeline duration wins, the clip
		// consumes only its own source span, and the last frame is still picture.
		val longSource = createSolidVideo(tmp("long"), green, seconds = 3.0)
		val clipTicks = ticksPerSecond * 7 / 10 // 700 ms
		val asset = assetFor("asset-long", longSource, 3.0)
		val clip = clipFor("clip-long", "asset-long", 0, clipTicks)
		val out = export(edlOf(listOf(asset), listOf(clip), clipTicks), "long")
		try {
			val durationUs = videoDurationUs(out)
			val expectedUs = clipTicks * 1_000_000L / ticksPerSecond // 700_000
			assertTrue(
				"a longer replacement must not stretch the clip: got ${durationUs}us, expected ~${expectedUs}us",
				abs(durationUs - expectedUs) <= 150_000,
			)
			// 100ms before the end: picture, not black.
			val nearEndUs = (expectedUs - 100_000).coerceAtLeast(0)
			val tail = centerColor(out, nearEndUs)
			assertTrue(
				"no black tail: frame ${nearEndUs}us must still be the source ($GREEN), got $tail",
				isClose(tail, GREEN),
			)
		} finally {
			out.delete()
			longSource.delete()
		}
	}

	@Test
	fun mixed_sources_on_one_track_render_in_order() {
		// The timeline shape a replacement produces next to an untouched clip:
		// red clip then replaced (green) clip, same track, back to back.
		val redSource = createSolidVideo(tmp("mix_red"), red)
		val greenSource = createSolidVideo(tmp("mix_green"), green)
		val half = ticksPerSecond / 2 // 500 ms
		val assets = listOf(assetFor("asset-red", redSource, 1.5), assetFor("asset-green", greenSource, 1.5))
		val clips = listOf(
			clipFor("clip-1", "asset-red", 0, half),
			clipFor("clip-2", "asset-green", half, half),
		)
		val out = export(edlOf(assets, clips, ticksPerSecond), "mixed")
		try {
			val first = centerColor(out, 250_000)
			val second = centerColor(out, 750_000)
			assertTrue("first clip must stay its original red source, got $first", isClose(first, RED))
			assertTrue("second clip must render the replacement green source, got $second", isClose(second, GREEN))
			val durationUs = videoDurationUs(out)
			assertTrue(
				"mixed-source timeline keeps its total duration: ${durationUs}us vs ~1000000us",
				abs(durationUs - 1_000_000L) <= 150_000,
			)
		} finally {
			out.delete()
			redSource.delete()
			greenSource.delete()
		}
	}
}
