package app.cutlyra.editor.export

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cutlyra.editor.backup.BackupArchive
import app.cutlyra.editor.edl.Edl
import app.cutlyra.editor.edl.EdlAsset
import app.cutlyra.editor.edl.EdlAssetKind
import app.cutlyra.editor.edl.EdlClip
import app.cutlyra.editor.edl.EdlGifAsset
import app.cutlyra.editor.edl.EdlGifFrame
import app.cutlyra.editor.edl.EdlMeta
import app.cutlyra.editor.edl.EdlOutput
import app.cutlyra.editor.edl.EdlRational
import app.cutlyra.editor.edl.EdlTrack
import app.cutlyra.editor.edl.EdlTrackKind
import app.cutlyra.editor.edl.EdlTrackType
import app.cutlyra.editor.edl.EdlTransform
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.media.gif.GifAssetPreparer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Deterministic proof that a decoded GIF survives a real backup archive.
 *
 * Builds an animated GIF (solid RED / GREEN / BLUE frames at 200/300/500 ms),
 * decodes it into media custody, archives it with [BackupArchive.export],
 * DELETES the source frame PNGs (a fresh install), restores with
 * [BackupArchive.import], and then exports the restored frames through the
 * real Media3 pipeline and decodes the MP4 at known timestamps.
 *
 * So the assertions are on actual restored bytes and actual exported pixels:
 * the frames still animate, in order, with their original delays. The JS half
 * (rewriting `MediaAssetData.gif.frames[].relativePath` onto the fresh paths
 * native returns, plus the count/index consistency checks) is covered by
 * `packages/editor-core/src/services/backup/__tests__/backup-service.test.ts`.
 */
@RunWith(AndroidJUnit4::class)
class GifBackupRestoreInstrumentedTest {
    private lateinit var context: Context
    private lateinit var workDir: File
    private lateinit var custodyRoot: File
    private lateinit var outputFile: File
    private lateinit var prepared: GifAssetPreparer.PreparedGif
    private lateinit var gifCustodyFile: File
    private val restoredDirs = mutableListOf<File>()

    private val ticksPerSecond = 120_000L
    private val gifWidth = 320
    private val gifHeight = 240
    private val assetId = "gif-backup-${System.nanoTime()}"

    private fun ms(value: Long): Long = value * ticksPerSecond / 1000

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        custodyRoot = context.noBackupFilesDir
        workDir = File(context.cacheDir, "gif_backup_${System.nanoTime()}").apply { mkdirs() }
        outputFile = File(workDir, "restored_export.mp4")

        val gifFile = File(workDir, "fixture.gif")
        gifFile.writeBytes(
            TestGifEncoder.encodeSolidFrames(
                width = gifWidth,
                height = gifHeight,
                framePaletteIndices = listOf(
                    TestGifEncoder.RED,
                    TestGifEncoder.GREEN,
                    TestGifEncoder.BLUE,
                ),
                frameDelaysMs = listOf(200, 300, 500),
                loopCount = 0,
            ),
        )
        prepared = GifAssetPreparer.prepareFromFile(
            gifFile = gifFile,
            outputRoot = custodyRoot,
            assetId = assetId,
        )
        val mediaDir = File(custodyRoot, "media").apply { mkdirs() }
        gifCustodyFile = File(mediaDir, "$assetId.gif").apply { writeBytes(gifFile.readBytes()) }
    }

    @After
    fun tearDown() {
        File(custodyRoot, "gif/$assetId").deleteRecursively()
        for (dir in restoredDirs) dir.deleteRecursively()
        gifCustodyFile.delete()
        workDir.deleteRecursively()
    }

    @Test
    fun backup_and_restore_keep_gif_frames_animating_in_order() {
        val projectJson = """{"metadata":{"id":"proj-gif-backup","name":"GIF Backup"}}"""
        val destination = File(workDir, "backup.cutlyra-backup")

        val manifest = BackupArchive.export(
            context = context,
            destinationUri = Uri.fromFile(destination),
            projectJson = projectJson,
            media = listOf(
                BackupArchive.MediaDescriptor(
                    assetId = assetId,
                    proxyPath = "media/$assetId.gif",
                    sourcePath = null,
                    thumbnailPath = null,
                    name = "fixture.gif",
                    type = "image",
                    sizeBytes = gifCustodyFile.length(),
                    lastModified = 0L,
                    width = prepared.width,
                    height = prepared.height,
                    duration = prepared.totalDurationMs / 1000.0,
                    fps = null,
                    hasAudio = false,
                    sourceRotationDegrees = 0,
                    sourceWidth = prepared.width,
                    sourceHeight = prepared.height,
                    gif = BackupArchive.MediaDescriptor.GifMetadata(
                        width = prepared.width,
                        height = prepared.height,
                        loopCount = prepared.loopCount,
                        frameDelaysMs = prepared.frames.map { it.delayMs.toDouble() },
                    ),
                    gifFrames = prepared.frames.map { it.relativePath },
                ),
            ),
            appVersion = "instrumentation",
        )

        assertTrue("the archive must be written to disk", destination.length() > 0L)

        val archivedAsset = manifest.getJSONArray("projects")
            .getJSONObject(0)
            .getJSONArray("assets")
            .getJSONObject(0)
        val gifJson = archivedAsset.getJSONObject("gif")
        assertEquals(prepared.width, gifJson.getInt("width"))
        assertEquals(prepared.height, gifJson.getInt("height"))
        assertEquals(0, gifJson.getInt("loopCount"))
        val delays = gifJson.getJSONArray("frameDelaysMs")
        assertEquals(
            prepared.frames.map { it.delayMs.toDouble() },
            (0 until delays.length()).map { delays.getDouble(it) },
        )
        // The manifest carries timing, never this device's custody paths.
        assertFalse(gifJson.has("frames"))

        val files = archivedAsset.getJSONArray("files")
        val gifEntries = (0 until files.length())
            .map { files.getJSONObject(it) }
            .filter { it.getString("role") == "gif" }
        assertEquals(prepared.frames.size, gifEntries.size)
        assertEquals(
            (0 until prepared.frames.size).toList(),
            gifEntries.map { it.getInt("frameIndex") },
        )

        // A fresh install: the frames that were archived no longer exist.
        assertTrue(File(custodyRoot, "gif/$assetId").deleteRecursively())

        val imported = BackupArchive.import(context, Uri.fromFile(destination))
        val restoredFrames = imported.restoredFiles
            .filter { it.role == "gif" }
            .sortedBy { it.frameIndex ?: -1 }
        assertEquals(prepared.frames.size, restoredFrames.size)
        assertEquals(
            (0 until prepared.frames.size).toList(),
            restoredFrames.map { it.frameIndex },
        )

        val expectedColors = listOf(
            0xFFFF0000.toInt(),
            0xFF00FF00.toInt(),
            0xFF0000FF.toInt(),
        )
        restoredFrames.forEachIndexed { index, frame ->
            assertFalse(
                "restored frames must use fresh custody paths, got ${frame.newPath}",
                frame.newPath.startsWith("gif/$assetId/"),
            )
            val png = File(custodyRoot, frame.newPath)
            assertTrue("restored frame must exist: ${frame.newPath}", png.isFile)
            frame.newPath.substringBeforeLast('/').let { dir ->
                restoredDirs.add(File(custodyRoot, dir))
            }
            val bitmap = BitmapFactory.decodeFile(png.absolutePath)
            assertTrue("restored frame PNG must decode", bitmap != null)
            assertEquals(
                "restored frame $index must keep its position in the animation",
                expectedColors[index],
                bitmap!!.getPixel(0, 0),
            )
            bitmap.recycle()
        }

        // The restored files are exactly what the exporter feeds into the EDL.
        val edl = buildEdl(
            restoredFrames.map { frame -> File(custodyRoot, frame.newPath) },
        )
        val output = export(edl)
        val probe = MediaProbe.probe(output, mimeTypeHint = "video/mp4")
        assertTrue(
            "restored GIF export duration ${probe.durationMicros}us should be ~1s",
            abs(probe.durationMicros - 1_000_000L) < 250_000L,
        )
        assertColor(output, 100, "red") // 0.0-0.2s
        assertColor(output, 350, "green") // 0.2-0.5s
        assertColor(output, 750, "blue") // 0.5-1.0s
    }

    private fun buildEdl(frameFiles: List<File>): Edl {
        val asset = EdlAsset(
            assetId = assetId,
            kind = EdlAssetKind.IMAGE,
            name = "fixture.gif",
            sourceUri = gifCustodyFile.toURI().toString(),
            codec = null,
            width = prepared.width,
            height = prepared.height,
            durationTicks = ms(prepared.totalDurationMs.toLong()),
            rotationDegrees = 0,
            hasAudio = false,
            gif = EdlGifAsset(
                loopCount = prepared.loopCount,
                frames = frameFiles.mapIndexed { index, file ->
                    EdlGifFrame(
                        uri = file.toURI().toString(),
                        durationTicks = ms(prepared.frames[index].delayMs.toLong()),
                    )
                },
            ),
        )
        val clipDurationMs = prepared.totalDurationMs.toLong()
        val clip = EdlClip(
            clipId = "clip-gif",
            kind = "image",
            assetId = asset.assetId,
            name = "gif",
            startTicks = 0,
            durationTicks = ms(clipDurationMs),
            sourceStartTicks = 0,
            sourceEndTicks = ms(clipDurationMs),
            speed = EdlRational(1, 1),
            maintainPitch = false,
            volumeDb = 0.0,
            muted = false,
            hidden = false,
            transform = EdlTransform(
                positionX = 0.0,
                positionY = 0.0,
                scaleX = 1.0,
                scaleY = 1.0,
                rotateDegrees = 0.0,
            ),
            opacity = 1.0,
            effects = emptyList(),
            hasMasks = false,
            animations = emptyList(),
            params = emptyMap(),
        )
        return Edl(
            meta = EdlMeta(
                edlVersion = 1,
                generator = "cutlyra-gif-backup-test",
                ticksPerSecond = ticksPerSecond,
                frameRate = EdlRational(30, 1),
                canvasWidth = gifWidth,
                canvasHeight = gifHeight,
                projectId = "proj-gif-backup",
                projectName = "GIF Backup",
                sceneId = "scene-1",
                sceneName = "Scene 1",
                durationTicks = ms(clipDurationMs),
            ),
            assets = listOf(asset),
            tracks = listOf(
                EdlTrack(
                    trackId = "track-main",
                    kind = EdlTrackKind.MAIN,
                    trackType = EdlTrackType.VIDEO,
                    name = "Main",
                    zIndex = 0,
                    muted = false,
                    hidden = false,
                    clips = listOf(clip),
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
                resolutionWidth = gifWidth,
                resolutionHeight = gifHeight,
                includeAudio = false,
            ),
        )
    }

    private fun export(edl: Edl): File {
        val latch = CountDownLatch(1)
        val events = mutableListOf<Media3Exporter.Event>()
        Media3Exporter.start(context, edl, outputFile) { event ->
            events.add(event)
            if (event is Media3Exporter.Event.Done || event is Media3Exporter.Event.Error) {
                latch.countDown()
            }
        }
        assertTrue("restored GIF export did not finish within 90s", latch.await(90, TimeUnit.SECONDS))
        val terminal = events.lastOrNull()
        assertTrue("expected restored GIF export to succeed, got: $terminal", terminal is Media3Exporter.Event.Done)
        return (terminal as Media3Exporter.Event.Done).outputFile
    }

    private fun assertColor(file: File, atMs: Long, expected: String) {
        val actual = SolidColorVideoFactory.dominantChannelAt(file, atUs = atMs * 1000)
        assertTrue(
            "frame at ${atMs}ms should be $expected, dominant channel was $actual " +
                "(${SolidColorVideoFactory.centerPixelAt(file, atUs = atMs * 1000)})",
            actual == expected,
        )
    }
}
