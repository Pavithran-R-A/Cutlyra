package app.cutlyra.editor.media.voiceover

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A pull-based source of 16-bit mono PCM samples for a voiceover take.
 *
 * The production implementation wraps `AudioRecord` (see
 * `AudioRecordPcmSource`); tests inject a deterministic source so the whole
 * record -> custody -> WAV path can be exercised on an emulator with no
 * microphone. `read` returns the number of samples written into `buffer`
 * (0 at a clean end, negative on error) — the same contract AudioRecord
 * itself uses.
 */
interface VoiceoverPcmSource {
    fun read(buffer: ShortArray, offset: Int, count: Int): Int

    /**
     * Releases the underlying capture resource. Deliberately abstract: a
     * default body compiles into `VoiceoverPcmSource$DefaultImpls`, which lives
     * only for external implementors, so the minified app build shrinks it and
     * any implementor outside the module (the instrumented tone source) crashes
     * with `NoClassDefFoundError` at `release()`. Implement it instead.
     */
    fun release()
}

/** Thrown for a take the recorder refused to publish. */
class VoiceoverRecordingException(
    message: String,
    /** Stable wire code for the bridge (`EMPTY_TAKE`, `TOO_SHORT`, ...). */
    val code: String,
) : Exception(message)

/** A finalized take, already published into custody. */
data class VoiceoverTake(
    /** Custody-root-relative path, e.g. `generated/voiceover-<id>.wav`. */
    val relativePath: String,
    val durationMs: Long,
    val sizeBytes: Long,
    val sampleRate: Int,
)

/**
 * Records one voiceover take into the media custody root.
 *
 * Design constraints this class exists to satisfy:
 *
 *  - **Bounded memory.** One `chunkSamples` buffer is reused for the whole
 *    take; nothing grows with take length. A 5-minute mono take is ~26 MB on
 *    disk and ~8 KB in the heap.
 *  - **Atomic publication.** Samples stream into `<name>.wav.tmp`; the WAV
 *    header sizes are patched and the file renamed only on `stop()`. A
 *    cancelled, crashed or killed take therefore never leaves a file the
 *    project can reference — it leaves garbage a prune pass may remove.
 *  - **No silently empty takes.** A take shorter than [MIN_TAKE_MS] is
 *    deleted and reported as an error rather than inserted as a clip the
 *    user cannot hear.
 *  - **Bounded duration.** `maxDurationMs` is enforced by the recording
 *    thread itself (the UI limit), so an unattended recorder cannot fill the
 *    disk. `stop()` returns the auto-finalized take.
 *
 * Pure `java.io`/`java.nio` on purpose: this is JVM-unit-tested with a
 * synthetic PCM source, and the Android-only AudioRecord wiring lives in
 * `AudioRecordPcmSource`.
 */
class VoiceoverRecorder(
    private val custodyRoot: File,
    private val source: VoiceoverPcmSource,
    private val sampleRate: Int = SAMPLE_RATE,
    generatedDirName: String = "generated",
    private val chunkSamples: Int = CHUNK_SAMPLES,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val generatedDir = File(custodyRoot, generatedDirName)

    private var thread: Thread? = null
    private var takeName: String? = null
    private var startedAtMs = 0L
    private var maxDurationMs = 0L
    private var writtenSamples = 0L
    private var failure: Throwable? = null
    private var finalized: VoiceoverTake? = null
    private var cancelled = false

    @Volatile
    private var running = false

    /** True while the capture thread is alive. */
    val isRecording: Boolean
        get() = running

    fun elapsedMs(): Long =
        if (startedAtMs == 0L) 0L else (clock() - startedAtMs).coerceAtLeast(0L)

    /**
     * Starts capture. `takeId` is caller-chosen and becomes the file name, so
     * a take is identifiable before it finishes.
     */
    fun start(takeId: String, maxDurationMs: Long) {
        require(takeId.isNotBlank()) { "takeId is required" }
        check(thread == null) { "a take is already in progress" }
        require(maxDurationMs > 0) { "maxDurationMs must be positive" }
        if (!generatedDir.isDirectory && !generatedDir.mkdirs()) {
            throw VoiceoverRecordingException(
                "could not create media custody dir ${generatedDir.absolutePath}",
                "IO_ERROR",
            )
        }
        val name = sanitize(takeId)
        takeName = name
        this.maxDurationMs = maxDurationMs
        startedAtMs = clock()
        writtenSamples = 0
        failure = null
        finalized = null
        cancelled = false
        running = true

        val tmp = File(generatedDir, "$name.wav.tmp")
        val worker = Thread({ capture(tmp) }, "voiceover-recorder")
        worker.isDaemon = true
        thread = worker
        worker.start()
    }

    /** Set when the capture thread died without publishing a take. */
    val failureCode: String?
        get() = (failure as? VoiceoverRecordingException)?.code ?: failure?.let { "IO_ERROR" }

    val failureMessage: String?
        get() = failure?.message

    /** True when the thread finished but `stop()` has not collected the take
     *  yet — the auto-stop-at-limit path. */
    val awaitingTake: Boolean
        get() = thread != null && !running && failure == null && !cancelled

    private fun capture(tmp: File) {
        val buffer = ShortArray(chunkSamples)
        val bytes = ByteArray(chunkSamples * 2)
        var out: java.io.FileOutputStream? = null
        try {
            out = java.io.FileOutputStream(tmp)
            out.write(emptyWavHeader())
            while (running) {
                if (elapsedMs() >= maxDurationMs) break
                val read = source.read(buffer, 0, buffer.size)
                if (read < 0) {
                    throw VoiceoverRecordingException(
                        "microphone read failed ($read)",
                        "MIC_ERROR",
                    )
                }
                if (read == 0) {
                    // End of source. AudioRecord in blocking mode returns >0
                    // or negative, so 0 only means an explicit end (the
                    // deterministic test source) — finalize what we have.
                    break
                }
                encodeLittleEndian(buffer, read, bytes)
                out.write(bytes, 0, read * 2)
                writtenSamples += read
            }
            out.flush()
            out.close()
            out = null
            val durationMs = (writtenSamples * 1000L) / sampleRate
            if (writtenSamples == 0L || durationMs < MIN_TAKE_MS) {
                throw VoiceoverRecordingException(
                    "take is too short to keep (${durationMs}ms)",
                    "TOO_SHORT",
                )
            }
            patchWavHeader(tmp, (writtenSamples * 2).toInt(), sampleRate)
            val target = File(generatedDir, "${takeName}.wav")
            if (!tmp.renameTo(target)) {
                throw VoiceoverRecordingException(
                    "could not publish ${target.name}",
                    "IO_ERROR",
                )
            }
            finalized = VoiceoverTake(
                relativePath = "${generatedDir.name}/${target.name}",
                durationMs = durationMs,
                sizeBytes = target.length(),
                sampleRate = sampleRate,
            )
        } catch (error: Throwable) {
            failure = error
            tmp.delete()
        } finally {
            running = false
            try {
                out?.close()
            } catch (_: Exception) {
                // Best effort: the take is already a failure.
            }
            source.release()
        }
    }

    /** Finalizes the take. Returns the published file, or throws. */
    fun stop(): VoiceoverTake {
        val worker = thread ?: throw VoiceoverRecordingException("no take is in progress", "NO_TAKE")
        running = false
        worker.join(STOP_JOIN_MS)
        if (worker.isAlive) {
            // A blocking read that never returned: do not hang the caller.
            worker.interrupt()
            throw VoiceoverRecordingException("recorder did not stop in time", "TIMEOUT")
        }
        thread = null
        if (cancelled) throw VoiceoverRecordingException("take was cancelled", "CANCELLED")
        failure?.let { error ->
            throw error as? VoiceoverRecordingException
                ?: VoiceoverRecordingException(error.message ?: "recording failed", "IO_ERROR")
        }
        return finalized
            ?: throw VoiceoverRecordingException("take was never finalized", "NO_TAKE")
    }

    /** Stops and deletes the partial take; nothing is published. */
    fun cancel() {
        cancelled = true
        running = false
        val worker = thread
        if (worker != null) {
            worker.join(STOP_JOIN_MS)
            if (worker.isAlive) worker.interrupt()
            thread = null
        }
        takeName?.let { name ->
            File(generatedDir, "$name.wav").delete()
            File(generatedDir, "$name.wav.tmp").delete()
        }
        finalized = null
        startedAtMs = 0
    }

    private fun sanitize(id: String): String =
        id.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun emptyWavHeader(): ByteArray {
        val header = ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(0) // patched on finalize
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(1) // mono
        header.putInt(sampleRate)
        header.putInt(sampleRate * 2) // byte rate
        header.putShort(2) // block align
        header.putShort(16) // bits per sample
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(0) // patched on finalize
        return header.array()
    }

    private fun patchWavHeader(file: File, dataBytes: Int, rate: Int) {
        RandomAccessFile(file, "rw").use { raf ->
            raf.seek(4)
            raf.write(intLe(36 + dataBytes))
            raf.seek(40)
            raf.write(intLe(dataBytes))
        }
    }

    private fun intLe(value: Int): ByteArray =
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()

    private fun encodeLittleEndian(samples: ShortArray, count: Int, out: ByteArray) {
        var i = 0
        var j = 0
        while (i < count) {
            val value = samples[i].toInt()
            out[j] = (value and 0xFF).toByte()
            out[j + 1] = ((value shr 8) and 0xFF).toByte()
            i++
            j += 2
        }
    }

    companion object {
        /** 44.1 kHz mono 16-bit — the format the preview decodes and every
         *  generated clip uses (library sounds included). */
        const val SAMPLE_RATE = 44_100

        /** ~93 ms of audio: big enough to avoid syscall churn, small enough
         *  that memory never scales with take length. */
        const val CHUNK_SAMPLES = 4096

        /** Below this a take is a mis-tap, not a voiceover. */
        const val MIN_TAKE_MS = 250L

        private const val WAV_HEADER_BYTES = 44
        private const val STOP_JOIN_MS = 3_000L
    }
}
