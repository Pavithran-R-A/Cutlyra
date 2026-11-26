package app.cutlyra.editor

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject
import app.cutlyra.editor.backup.ArchiveDestination
import app.cutlyra.editor.backup.BackupArchive
import app.cutlyra.editor.edl.EdlParseException
import app.cutlyra.editor.edl.EdlParser
import app.cutlyra.editor.export.GalleryExportPublisher
import app.cutlyra.editor.export.MainTrackPlacements
import app.cutlyra.editor.export.Media3Exporter
import app.cutlyra.editor.export.PrerenderedOverlay
import app.cutlyra.editor.export.ticksToUs
import app.cutlyra.editor.media.MediaImporter
import app.cutlyra.editor.media.MediaPickerIntents
import app.cutlyra.editor.media.MediaProbe
import app.cutlyra.editor.media.FreezeFrameCapture
import app.cutlyra.editor.media.voiceover.AudioRecordPcmSource
import app.cutlyra.editor.media.voiceover.VoiceoverRecorder
import app.cutlyra.editor.media.voiceover.VoiceoverRecordingException
import app.cutlyra.editor.media.voiceover.VoiceoverTakeCleanup
import app.cutlyra.editor.media.gif.GifAssetPreparer
import app.cutlyra.editor.media.gif.GifExportPreflight
import app.cutlyra.editor.media.gif.GifFrameCleanup
import app.cutlyra.editor.media.reverse.ReverseMediaGenerator
import app.cutlyra.editor.media.ProxyTranscoder
import app.cutlyra.editor.media.ThumbnailStripGenerator
import app.cutlyra.editor.stt.WhisperTranscriber
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Cutlyra M3 (`getDeviceInfo`) + M4 (`pickMedia`/`generateProxy`/
 * `generateThumbnails`) + M9 (`exportProject`/`exportCancel`) — the native
 * half of `NativeBridge`
 * (`packages/native-bridge/src/{types,capacitor-bridge}.ts`). Ported from
 * Java to Kotlin in M4 (see `apps/mobile/android/build.gradle`'s Kotlin
 * toolchain addition) — the media pipeline is materially easier to express
 * correctly in Kotlin (sealed `ProxyTranscoder.Event`, data classes for
 * probed/imported media, null-safety on every `content://` round trip) than
 * repeating M3's Java style would have been.
 *
 * Deliberate architecture note (corpus 08 §6): this app never renders an
 * `<input type="file">` in the WebView, so `WebChromeClient
 * .onShowFileChooser()` — the mechanism 08 §6 documents as the standard fix
 * for "WebView doesn't wire file inputs to the Photo Picker" — is not
 * needed here. `pickMedia` is called directly from JS via this plugin
 * method and launches the native picker itself
 * (`MediaPickerIntents.buildLibraryPickIntent`). Same underlying problem
 * (native must own the picker), one layer earlier in the stack.
 *
 * `generateProxy`/`generateThumbnails` are async but Capacitor
 * `PluginCall`s resolve once — `generateProxy` therefore resolves
 * immediately with `{assetId}` once the transcode has *started*, and
 * streams `ProxyProgress` updates via `notifyListeners("proxyProgress",
 * ...)`; the TS side's `AsyncGenerator<ProxyProgress>`
 * (`capacitor-bridge.ts`) is what turns that event stream back into pulled
 * values. `generateThumbnails` is fast enough (a handful of JPEGs) that it
 * stays a plain resolve-when-done call.
 */
@CapacitorPlugin(
	name = "NativeBridge",
	permissions = [
		Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
		Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
	],
)
class NativeBridgePlugin : Plugin() {

	/** The one in-flight voiceover take. Recording streams from AudioRecord
	 * into custody on its own thread; `stop`/`cancel` are the only ways out,
	 * so a take cannot be left half-written behind the JS layer's back. */
	@Volatile
	private var voiceoverRecorder: VoiceoverRecorder? = null

	/** Take id of the recording in flight, for the elapsed-time poll. */
	@Volatile
	private var voiceoverTakeId: String? = null

	/** Set by `cancelReverseVideo`; checked by `ReverseMediaGenerator` between
	 * frames. A cancelled run deletes its partial file and rejects `CANCELLED`. */
	@Volatile
	private var reverseCancelRequested = false

	/** Bridges `MediaPickerIntents.buildCameraCaptureIntent`'s output across
	 * the permission-request and/or activity-result round trip — Capacitor
	 * re-delivers the ORIGINAL `PluginCall` (same `kinds`/`source` params) to
	 * both `@PermissionCallback` and `@ActivityCallback` methods, but the
	 * `FileProvider` output URI is generated only once, here, so it must be
	 * stashed rather than recomputed. */
	private var pendingCameraCapture: MediaPickerIntents.CameraCapture? = null

	/** The `exportId` of the one in-flight export, or null when idle. See
	 * `exportProject`'s doc comment: `Media3Exporter` is single-export-by
	 * -design, so this is a single field rather than the iOS side's
	 * `activeExportHandles` map, but the JS-facing wire contract (every
	 * `exportProgress` event carries the caller's id) is identical on both
	 * platforms. */
	private var activeExportId: String? = null

	/**
	 * Voiceover recording is foreground-only. Capacitor calls this when the
	 * activity is stopped (app backgrounded, screen locked), which can happen
	 * after the WebView is already suspended and the JS visibility listener
	 * can no longer run. Cancel here too so a hidden take can never keep
	 * capturing audio or leave a partial file behind.
	 */
	override fun handleOnStop() {
		super.handleOnStop()
		val recorder = voiceoverRecorder ?: return
		voiceoverRecorder = null
		voiceoverTakeId = null
		Thread { recorder.cancel() }.start()
	}

	/** Native preview-audio router — iOS-only for now: the webview-silence
	 *  bug is device-verified on iOS, while Android WebView WebAudio is
	 *  expected functional (untested on hardware). Android reports
	 *  available:false so the JS AudioManager keeps its WebAudio path. */
	@PluginMethod
	fun audioStart(call: PluginCall) {
		call.reject("native preview audio not implemented on android", "UNSUPPORTED")
	}

	@PluginMethod
	fun audioStop(call: PluginCall) {
		call.resolve(JSObject())
	}

	@PluginMethod
	fun audioLevel(call: PluginCall) {
		val ret = JSObject()
		ret.put("rms", 0.0)
		call.resolve(ret)
	}

	/** Native tone bisector — parity with iOS playTestTone (see the iOS
	 *  pluginMethods comment). */
	@PluginMethod
	fun playTestTone(call: PluginCall) {
		Thread {
			try {
				val tone = android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 80)
				tone.startTone(android.media.ToneGenerator.TONE_DTMF_1, 800)
				Thread.sleep(900)
				tone.release()
			} catch (_: Exception) {
				// Best effort — the bisector's answer is audible or not.
			}
		}.start()
		val ret = JSObject()
		ret.put("ok", true)
		call.resolve(ret)
	}

	/** The media-custody root, so the webview persists container-RELATIVE
	 *  media paths. On iOS the data-container UUID rotates every
	 *  update/reinstall, killing persisted absolute paths; Android's data
	 *  dir is stable, but the same relative scheme keeps the two platforms'
	 *  persistence identical. Root here = `noBackupFilesDir`, the parent of
	 *  MediaImporter/ProxyTranscoder/ThumbnailStripGenerator's subdirs. */
	@PluginMethod
	fun getMediaRoot(call: PluginCall) {
		val result = JSObject()
		result.put("root", context.noBackupFilesDir.absolutePath)
		call.resolve(result)
	}

	/** GitHub #63 — persists a JS-generated library sound (a base64 WAV)
	 *  into the media custody root so it becomes a real asset the Media3
	 *  exporter can read. `assetId` is the caller's content-derived id
	 *  (the same bundled sound always derives the same id), so retries and
	 *  repeat inserts overwrite the same path with the same bytes. */
	@PluginMethod
	fun saveGeneratedAudio(call: PluginCall) {
		val assetId = call.getString("assetId")
		val base64 = call.getString("base64")
		if (assetId.isNullOrBlank() || base64.isNullOrBlank()) {
			call.reject("saveGeneratedAudio requires {assetId, base64}", "IO_ERROR")
			return
		}
		val bytes = try {
			android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
		} catch (e: IllegalArgumentException) {
			call.reject("saveGeneratedAudio: base64 did not decode: ${e.message}", "IO_ERROR")
			return
		}
		// A WAV opens with "RIFF", has "WAVE" at offset 8, and carries the
		// payload size in bytes 4-7; anything smaller is not one.
		val riffOk = bytes.size >= 44 &&
			bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
			bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
			bytes[8] == 'W'.code.toByte() && bytes[9] == 'A'.code.toByte() &&
			bytes[10] == 'V'.code.toByte() && bytes[11] == 'E'.code.toByte()
		if (!riffOk) {
			call.reject("saveGeneratedAudio: decoded bytes are not a RIFF/WAVE file", "IO_ERROR")
			return
		}

		val dir = File(context.noBackupFilesDir, "generated")
		if (!dir.exists()) dir.mkdirs()
		val dest = File(dir, "$assetId.wav")
		val tmp = File(dir, "$assetId.wav.tmp")
		try {
			java.io.FileOutputStream(tmp).use { out -> out.write(bytes) }
			if (!tmp.renameTo(dest)) {
				tmp.delete()
				call.reject("saveGeneratedAudio: could not publish $assetId.wav", "IO_ERROR")
				return
			}
		} catch (e: Exception) {
			tmp.delete()
			call.reject("saveGeneratedAudio failed: ${e.message}", "IO_ERROR")
			return
		}

		val result = JSObject()
		result.put("relativePath", "generated/$assetId.wav")
		result.put("sizeBytes", bytes.size)
		call.resolve(result)
	}

	// -- Voiceover recording ---------------------------------------------------
	//
	// The microphone is requested AT THE POINT OF USE (not at launch), a take
	// streams to `generated/voiceover-<takeId>.wav` on its own thread, and the
	// file is only published once `stop` finalizes it — so a denied permission,
	// a cancel or a killed app can never leave an empty take behind the
	// project's back. `Stop`/`cancel` run off the main thread because the
	// recorder joins its capture thread.

	@PluginMethod
	fun requestMicrophonePermission(call: PluginCall) {
		if (getPermissionState("microphone") == PermissionState.GRANTED) {
			resolveMicrophonePermission(call)
			return
		}
		requestPermissionForAlias("microphone", call, "microphonePermissionCallback")
	}

	@PermissionCallback
	private fun microphonePermissionCallback(call: PluginCall) {
		resolveMicrophonePermission(call)
	}

	private fun resolveMicrophonePermission(call: PluginCall) {
		val state = getPermissionState("microphone")
		val result = JSObject()
		result.put("granted", state == PermissionState.GRANTED)
		// DENIED is the permanent state on Android (the user ticked "don't
		// ask again" or dismissed twice); PROMPT means a later retry can
		// still show the system dialog.
		result.put("canAskAgain", state != PermissionState.DENIED)
		call.resolve(result)
	}

	@PluginMethod
	fun startVoiceoverRecording(call: PluginCall) {
		val takeId = call.getString("takeId")
		val maxDurationMs = call.getLong("maxDurationMs") ?: 0L
		if (takeId.isNullOrBlank()) {
			call.reject("startVoiceoverRecording requires {takeId, maxDurationMs}", "INVALID_ARGUMENT")
			return
		}
		if (maxDurationMs <= 0L) {
			call.reject("startVoiceoverRecording requires a positive maxDurationMs", "INVALID_ARGUMENT")
			return
		}
		if (getPermissionState("microphone") != PermissionState.GRANTED) {
			call.reject("microphone permission is not granted", "PERMISSION_DENIED")
			return
		}
		if (voiceoverRecorder != null) {
			call.reject("a voiceover take is already in progress", "ALREADY_RECORDING")
			return
		}
		val generated = File(context.noBackupFilesDir, "generated")
		if (generated.exists() && generated.usableSpace < MIN_FREE_BYTES_FOR_TAKE) {
			call.reject("not enough free storage to record a voiceover", "LOW_STORAGE")
			return
		}
		Thread {
			val recorder = try {
				VoiceoverRecorder(context.noBackupFilesDir, AudioRecordPcmSource())
			} catch (error: VoiceoverRecordingException) {
				call.reject(error.message ?: "microphone unavailable", error.code)
				return@Thread
			} catch (error: Exception) {
				call.reject("could not start voiceover recording: ${error.message}", "MIC_UNAVAILABLE")
				return@Thread
			}
			try {
				recorder.start(takeId, maxDurationMs)
			} catch (error: VoiceoverRecordingException) {
				call.reject(error.message ?: "could not start recording", error.code)
				return@Thread
			}
			voiceoverRecorder = recorder
			voiceoverTakeId = takeId
			val result = JSObject()
			result.put("started", true)
			result.put("takeId", takeId)
			result.put("sampleRate", VoiceoverRecorder.SAMPLE_RATE)
			call.resolve(result)
		}.start()
	}

	@PluginMethod
	fun voiceoverRecordingState(call: PluginCall) {
		val recorder = voiceoverRecorder
		val result = JSObject()
		result.put("recording", recorder?.isRecording == true)
		result.put("elapsedMs", recorder?.elapsedMs() ?: 0L)
		result.put("takeId", voiceoverTakeId)
		// The take hit its duration limit and is waiting for `stop` to collect
		// it — the UI keeps the recorder visible until it resolves.
		result.put("awaitingTake", recorder?.awaitingTake == true)
		result.put("error", recorder?.failureMessage)
		result.put("errorCode", recorder?.failureCode)
		call.resolve(result)
	}

	@PluginMethod
	fun stopVoiceoverRecording(call: PluginCall) {
		val recorder = voiceoverRecorder
		if (recorder == null) {
			call.reject("no voiceover take is in progress", "NO_TAKE")
			return
		}
		voiceoverRecorder = null
		voiceoverTakeId = null
		Thread {
			try {
				val take = recorder.stop()
				val result = JSObject()
				result.put("relativePath", take.relativePath)
				result.put("durationMs", take.durationMs)
				result.put("sizeBytes", take.sizeBytes)
				result.put("sampleRate", take.sampleRate)
				call.resolve(result)
			} catch (error: VoiceoverRecordingException) {
				call.reject(error.message ?: "voiceover recording failed", error.code)
			} catch (error: Exception) {
				call.reject("voiceover recording failed: ${error.message}", "IO_ERROR")
			}
		}.start()
	}

	@PluginMethod
	fun cancelVoiceoverRecording(call: PluginCall) {
		val recorder = voiceoverRecorder
		voiceoverRecorder = null
		voiceoverTakeId = null
		if (recorder == null) {
			val result = JSObject()
			result.put("cancelled", false)
			call.resolve(result)
			return
		}
		Thread {
			recorder.cancel()
			val result = JSObject()
			result.put("cancelled", true)
			call.resolve(result)
		}.start()
	}

	/** Deletes voiceover takes the project no longer references. Only this
	 *  feature's namespace is touched (see `VoiceoverTakeCleanup`). */
	@PluginMethod
	fun pruneVoiceoverTakes(call: PluginCall) {
		if (voiceoverRecorder != null) {
			call.reject("cannot prune voiceover takes while a take exists", "BUSY")
			return
		}
		val array = call.getArray("referencedPaths")
		val referenced = (0 until (array?.length() ?: 0)).mapNotNull { array?.getString(it) }
		val removed = VoiceoverTakeCleanup.pruneTakes(context.noBackupFilesDir, referenced)
		val result = JSObject()
		val list = JSArray()
		removed.forEach { list.put(it) }
		result.put("removed", list)
		call.resolve(result)
	}

	@PluginMethod
	fun getDeviceInfo(call: PluginCall) {
		val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
		val memoryInfo = ActivityManager.MemoryInfo()
		var ramTierMb = 0L
		activityManager?.getMemoryInfo(memoryInfo)
		if (activityManager != null) {
			ramTierMb = memoryInfo.totalMem / (1024 * 1024)
		}

		val result = JSObject()
		result.put("osVersion", Build.VERSION.RELEASE)
		result.put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
		result.put("ramTierMb", ramTierMb)
		call.resolve(result)
	}

	// -- pickMedia --------------------------------------------------------

	@PluginMethod
	fun pickMedia(call: PluginCall) {
		val kinds = readKinds(call)
		val allowMultiple = call.getBoolean("allowMultiple", false) ?: false
		val source = call.getString("source", "library")

		if (source == "camera") {
			val kind = if (kinds.contains("video")) "video" else "image"
			if (getPermissionState("camera") != PermissionState.GRANTED) {
				requestPermissionForAlias("camera", call, "cameraPermissionCallback")
				return
			}
			launchCameraCapture(call, kind)
			return
		}

		val intent = MediaPickerIntents.buildLibraryPickIntent(
			context.packageManager,
			kinds,
			allowMultiple,
		)
		startActivityForResult(call, intent, "handleLibraryPickResult")
	}

	private fun readKinds(call: PluginCall): List<String> {
		return try {
			call.getArray("kinds")?.toList<String>() ?: listOf("video")
		} catch (_: org.json.JSONException) {
			listOf("video")
		}
	}

	@PermissionCallback
	private fun cameraPermissionCallback(call: PluginCall) {
		if (getPermissionState("camera") == PermissionState.GRANTED) {
			val kinds = readKinds(call)
			val kind = if (kinds.contains("video")) "video" else "image"
			launchCameraCapture(call, kind)
		} else {
			call.reject("Camera permission denied", "PERMISSION_DENIED")
		}
	}

	private fun launchCameraCapture(call: PluginCall, kind: String) {
		val capture = MediaPickerIntents.buildCameraCaptureIntent(context, kind)
		pendingCameraCapture = capture
		startActivityForResult(call, capture.intent, "handleCameraCaptureResult")
	}

	@ActivityCallback
	private fun handleLibraryPickResult(call: PluginCall, result: ActivityResult) {
		if (result.resultCode != Activity.RESULT_OK) {
			call.reject("User cancelled media selection", "USER_CANCELLED")
			return
		}
		val data = result.data
		val uris = mutableListOf<Uri>()
		val clipData = data?.clipData
		if (clipData != null) {
			for (i in 0 until clipData.itemCount) {
				uris.add(clipData.getItemAt(i).uri)
			}
		} else {
			data?.data?.let { uris.add(it) }
		}
		if (uris.isEmpty()) {
			call.reject("No media selected", "USER_CANCELLED")
			return
		}
		importAndProbeAsync(call, uris)
	}

	@ActivityCallback
	private fun handleCameraCaptureResult(call: PluginCall, result: ActivityResult) {
		val capture = pendingCameraCapture
		pendingCameraCapture = null
		if (result.resultCode != Activity.RESULT_OK || capture == null) {
			call.reject("Camera capture cancelled", "USER_CANCELLED")
			return
		}
		importAndProbeAsync(call, listOf(capture.outputUri))
	}

	/** Copy-then-probe touches disk I/O and `MediaMetadataRetriever`/
	 * `MediaExtractor` — real work, kept off Capacitor's calling thread (which
	 * is itself already a background thread, but `startActivityForResult`'s
	 * callback is documented as running on the main thread, so this still
	 * matters). */
	private fun importAndProbeAsync(call: PluginCall, uris: List<Uri>) {
		Thread {
			val handles = JSArray()
			// Per-item isolation + pickProgress events, matching iOS: one
			// failing item must neither lose the batch (the old behavior
			// here) nor vanish silently (the old iOS behavior) — and the
			// copy of a cloud-backed picker item is real wall-clock work
			// the UI needs to show (2026-08-19).
			for ((index, uri) in uris.withIndex()) {
				emitPickProgress(index, uris.size, "loading", 0.0, null)
				try {
					val imported = MediaImporter.importInto(context, uri)
					try {
						val probed = MediaProbe.probe(imported.file, imported.mimeType)
						handles.put(mediaHandleToJson(imported, probed))
						emitPickProgress(index, uris.size, "loaded", 1.0, null)
					} catch (e: Exception) {
						MediaImporter.delete(imported.file)
						throw e
					}
				} catch (e: Exception) {
					emitPickProgress(index, uris.size, "error", 1.0, e.message ?: "media import failed")
				}
			}
			val result = JSObject()
			result.put("handles", handles)
			call.resolve(result)
		}.start()
	}

	private fun emitPickProgress(index: Int, total: Int, stage: String, fraction: Double, error: String?) {
		val payload = JSObject()
		payload.put("index", index)
		payload.put("total", total)
		payload.put("stage", stage)
		payload.put("fraction", fraction)
		if (error != null) payload.put("error", error)
		notifyListeners("pickProgress", payload)
	}

	private fun mediaHandleToJson(imported: MediaImporter.ImportedFile, probed: MediaProbe.ProbedMedia): JSObject {
		val json = JSObject()
		json.put("id", UUID.randomUUID().toString())
		// A native app-sandbox file path, never a blob: URL — the exact
		// contract `MediaHandle.uri` documents (packages/native-bridge/src/
		// types.ts).
		json.put("uri", Uri.fromFile(imported.file).toString())
		json.put("kind", probed.kind)
		json.put("fileName", imported.fileName)
		json.put("sizeBytes", imported.sizeBytes)
		json.put("durationMicros", probed.durationMicros)
		json.put("width", probed.width)
		json.put("height", probed.height)
		json.put("rotationDegrees", probed.rotationDegrees)
		json.put("hasAudio", probed.hasAudio)
		json.put("codec", probed.codec)
		val frameRate = probed.frameRate
		if (frameRate != null) {
			val frameRateJson = JSObject()
			frameRateJson.put("numerator", frameRate.numerator)
			frameRateJson.put("denominator", frameRate.denominator)
			json.put("frameRate", frameRateJson)
		} else {
			json.put("frameRate", JSONObject.NULL)
		}
		return json
	}

	// -- generateProxy ------------------------------------------------------

	@PluginMethod
	fun generateProxy(call: PluginCall) {
		val handleObj = call.getObject("handle")
		val specObj = call.getObject("spec")
		if (handleObj == null || specObj == null) {
			call.reject("generateProxy requires {handle, spec}", "IO_ERROR")
			return
		}
		val assetId = handleObj.getString("id")
		val uriString = handleObj.getString("uri")
		if (assetId == null || uriString == null) {
			call.reject("handle.id and handle.uri are required", "IO_ERROR")
			return
		}
		val sourceFile = fileFromNativeUri(uriString)
		if (sourceFile == null) {
			call.reject("handle.uri must be a native file:// handle", "UNSUPPORTED")
			return
		}
		// Same guard as iOS: this is a VIDEO transcoder (Media3 Transformer);
		// stills never come through here — the JS orchestration uses the
		// source as the proxy for kind=="image" (2026-08-19).
		if (handleObj.getString("kind") == "image") {
			call.reject("generateProxy is video-only; image assets use their source as the proxy", "UNSUPPORTED")
			return
		}
		val targetShortEdgePx = specObj.optInt("targetHeight", 540)
		val shortGop = specObj.optBoolean("shortGop", true)

		// Resolves the KICKOFF call now; the transcode itself streams via
		// `proxyProgress` events — see this class's doc comment.
		val ack = JSObject()
		ack.put("assetId", assetId)
		call.resolve(ack)

		ProxyTranscoder.start(
			context = context,
			assetId = assetId,
			sourceFile = sourceFile,
			targetShortEdgePx = targetShortEdgePx,
			shortGop = shortGop,
		) { event -> notifyListeners("proxyProgress", proxyEventToJson(assetId, event)) }
	}

	private fun proxyEventToJson(assetId: String, event: ProxyTranscoder.Event): JSObject {
		val payload = JSObject()
		payload.put("assetId", assetId)
		when (event) {
			is ProxyTranscoder.Event.Progress -> {
				payload.put("stage", "transcoding")
				payload.put("fraction", event.fraction.toDouble())
			}
			is ProxyTranscoder.Event.Done -> {
				payload.put("stage", "done")
				payload.put("fraction", 1.0)
				payload.put("proxyUri", Uri.fromFile(event.outputFile).toString())
			}
			is ProxyTranscoder.Event.Error -> {
				payload.put("stage", "error")
				payload.put("fraction", 1.0)
				payload.put("error", event.message)
			}
		}
		return payload
	}

	// -- generateThumbnails -------------------------------------------------

	@PluginMethod
	fun generateThumbnails(call: PluginCall) {
		val handleObj = call.getObject("handle")
		val specObj = call.getObject("spec")
		if (handleObj == null || specObj == null) {
			call.reject("generateThumbnails requires {handle, spec}", "IO_ERROR")
			return
		}
		val assetId = handleObj.getString("id")
		val uriString = handleObj.getString("uri")
		if (assetId == null || uriString == null) {
			call.reject("handle.id and handle.uri are required", "IO_ERROR")
			return
		}
		val sourceFile = fileFromNativeUri(uriString)
		if (sourceFile == null) {
			call.reject("handle.uri must be a native file:// handle", "UNSUPPORTED")
			return
		}
		val durationMicros = handleObj.optLong("durationMicros", 0L)
		val count = specObj.optInt("count", 10)
		val maxEdgePx = specObj.optInt("maxEdgePx", 200)

		Thread {
			try {
				val thumbnails = ThumbnailStripGenerator.generate(
					context = context,
					assetId = assetId,
					file = sourceFile,
					durationMicros = durationMicros,
					count = count,
					maxEdgePx = maxEdgePx,
				)
				val uris = JSArray()
				val timestamps = JSArray()
				for (thumbnail in thumbnails) {
					uris.put(Uri.fromFile(File(thumbnail.filePath)).toString())
					timestamps.put(thumbnail.timestampMicros)
				}
				val result = JSObject()
				result.put("assetId", assetId)
				result.put("uris", uris)
				result.put("timestampsMicros", timestamps)
				call.resolve(result)
			} catch (e: Exception) {
				call.reject(e.message ?: "thumbnail generation failed", "IO_ERROR")
			}
		}.start()
	}

	// -- exportProject --------------------------------------------------------

	/**
	 * M9 (plan §M9, corpus `08` §8, `10` §2.1/§2.2): `edl` -> a Media3
	 * `Composition` (`EdlToComposition`) -> `Transformer.start`
	 * (`Media3Exporter`). Same "resolve on kickoff, stream the rest as
	 * events" shape as `generateProxy` above — see that method's doc
	 * comment — because `ExportProgress` (like `ProxyProgress`) is
	 * inherently a stream, not a single return value.
	 *
	 * The JS-side `Edl` object is already all-JSON-safe (plan §2.2: "nothing
	 * crosses the bridge except JSON control messages") and, unlike
	 * `MediaHandle`, is producer-generated and `validateEdl()`-checked
	 * before it ever reaches here — `EdlParser` still re-validates every
	 * field's shape (never trusts a cross-language JSON payload blindly),
	 * but there is no separate "wire type" the way `capacitor-bridge.ts`
	 * needed for `MediaHandle`.
	 */
	/**
	 * `exportId` (merge note, capacitor-bridge.ts): the unified JS<->native
	 * export contract routes every `exportProgress` event by the id the JS
	 * caller minted, because `capacitor-bridge.ts`'s generator filters on
	 * it. `Media3Exporter` is single-export-at-a-time by design (its own doc
	 * comment), so this class simply remembers the one live id and stamps it
	 * onto each event rather than keeping a map the way the iOS side's
	 * `activeExportHandles` does.
	 */
	@PluginMethod
	fun exportProject(call: PluginCall) {
		val exportId = call.getString("exportId")
		if (exportId == null) {
			call.reject("exportProject requires exportId", "IO_ERROR")
			return
		}
		val edlObj = call.getObject("edl")
		if (edlObj == null) {
			call.reject("exportProject requires {edl}", "IO_ERROR")
			return
		}
		val edl = try {
			EdlParser.parse(edlObj)
		} catch (e: EdlParseException) {
			call.reject(e.message ?: "invalid EDL", "IO_ERROR")
			return
		}

		val outputDir = File(context.noBackupFilesDir, "exports")
		if (!outputDir.exists()) outputDir.mkdirs()
		val extension = if (edl.output.container == "webm") "webm" else "mp4"
		val outputFile = File(outputDir, "export-${UUID.randomUUID()}.$extension")

		activeExportId = exportId

		val ack = JSObject()
		ack.put("started", true)
		ack.put("exportId", exportId)
		call.resolve(ack)

		// PRERENDERED OVERLAYS (round 37): full-frame text/caption images the
		// PREVIEW rendered with its own drawing code. Compositing these
		// removes `EdlTextOverlay` — a second, drifting implementation of the
		// editor's text rendering — from the export path. A frame that fails
		// to decode is skipped rather than failing the export.
		// Nominal -> output clock for overlay timings (Stage 18): prerendered
		// frames are rendered against the NOMINAL scene, while cross-fades
		// compress the timeline (`MainTrackPlacements`) — shift each frame's
		// window by the cumulative overlaps ahead of it, start-only, exactly
		// as the preview remaps overlay elements.
		val placements = MainTrackPlacements.build(
			edl.mainTrack()?.clips?.filter { it.kind == "video" || it.kind == "image" } ?: emptyList(),
			edl.transitions,
		)
		val overlayFrames = mutableListOf<PrerenderedOverlay.Frame>()
		call.getArray("overlayFrames")?.let { array ->
			for (index in 0 until array.length()) {
				val entry = array.optJSONObject(index) ?: continue
				val base64 = entry.optString("pngBase64", "")
				val startTicks = entry.optLong("startTicks", -1)
				val endTicks = entry.optLong("endTicks", -1)
				if (base64.isEmpty() || endTicks <= startTicks) continue
				val bytes = try {
					android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
				} catch (error: IllegalArgumentException) {
					null
				} ?: continue
				var bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
					?: continue
				// Normalize to the export resolution. The preview renders its
				// overlay canvas at the device pixel ratio, so these PNGs
				// routinely arrive at 2x the project canvas, and media3 draws a
				// BitmapOverlay at the bitmap's OWN pixel size — which put
				// double-size, edge-cropped captions in the exported file even
				// though the frames themselves were pixel-correct.
				val targetWidth = edl.output.resolutionWidth
				val targetHeight = edl.output.resolutionHeight
				if (targetWidth > 0 && targetHeight > 0 &&
					(bitmap.width != targetWidth || bitmap.height != targetHeight)
				) {
					bitmap = android.graphics.Bitmap.createScaledBitmap(
						bitmap, targetWidth, targetHeight, /* filter= */ true,
					)
				}
				val outStartTicks = placements.remapNominalTick(startTicks)
				overlayFrames.add(
					PrerenderedOverlay.Frame(
						startUs = ticksToUs(outStartTicks, edl.meta.ticksPerSecond),
						endUs = ticksToUs(outStartTicks + (endTicks - startTicks), edl.meta.ticksPerSecond),
						bitmap = bitmap,
					),
				)
			}
		}

		android.util.Log.i(
			"cutlyra-export",
			"overlay frames decoded=${overlayFrames.size} " +
				"target=${edl.output.resolutionWidth}x${edl.output.resolutionHeight}",
		)

		Media3Exporter.start(
			context = context,
			edl = edl,
			outputFile = outputFile,
			overlayFrames = overlayFrames,
		) { event ->
			if (event is Media3Exporter.Event.Done) {
				// Media3 invokes this callback on the main looper. MediaStore
				// publication copies the whole file, so NEVER do it on that
				// looper: the device would freeze on longer exports.
				val publishing = JSObject()
				publishing.put("exportId", exportId)
				publishing.put("stage", "muxing")
				publishing.put("fraction", 0.99)
				notifyListeners("exportProgress", publishing)
				Thread {
					try {
						val galleryUri = GalleryExportPublisher.publish(context, event.outputFile)
						// Avoid retaining a second, invisible copy indefinitely.
						if (!event.outputFile.delete()) {
							android.util.Log.w("cutlyra-export", "temporary export cleanup deferred")
						}
						notifyListeners("exportProgress", exportEventToJson(exportId, event, galleryUri))
					} catch (error: Exception) {
						android.util.Log.e("cutlyra-export", "failed to save encoded video to Gallery", error)
						val message = error.message?.trim().takeUnless { it.isNullOrEmpty() }
								?: error.javaClass.simpleName
						notifyListeners(
							"exportProgress",
							exportEventToJson(
								exportId,
								Media3Exporter.Event.Error("Video encoded but Save to Gallery failed: $message"),
							),
							)
					}
				}.start()
			} else {
				notifyListeners("exportProgress", exportEventToJson(exportId, event))
			}
		}
	}

	/** Not part of the `NativeBridge` TS interface (that abstraction expresses
	 * cancellation as the JS caller simply stopping iteration of the
	 * `AsyncGenerator<ExportProgress>` `exportProject` returns) — this is the
	 * plugin-private method `capacitor-bridge.ts`'s generator adapter calls
	 * from its `finally` block so stopping iteration actually stops the
	 * native encoder too, not just the JS-side listener.
	 *
	 * Named `exportCancel` (not `cancelExport`) and taking an `exportId` to
	 * match the iOS plugin's method exactly — one wire contract, one TS call
	 * site. A mismatched id is a deliberate no-op rather than an error: the
	 * only way to get one is a cancel racing a just-finished export, which
	 * `Media3Exporter.cancel()` already treats as a no-op anyway. */
	@PluginMethod
	fun exportCancel(call: PluginCall) {
		val exportId = call.getString("exportId")
		if (exportId == null) {
			call.reject("exportCancel requires exportId", "IO_ERROR")
			return
		}
		if (activeExportId == null || activeExportId == exportId) {
			Media3Exporter.cancel()
			activeExportId = null
		}
		val ack = JSObject()
		ack.put("accepted", true)
		call.resolve(ack)
	}

	private fun exportEventToJson(exportId: String, event: Media3Exporter.Event, publishedUri: Uri? = null): JSObject {
		val payload = JSObject()
		payload.put("exportId", exportId)
		when (event) {
			is Media3Exporter.Event.Progress -> {
				payload.put("stage", "encoding")
				payload.put("fraction", event.fraction.toDouble())
			}
			is Media3Exporter.Event.Done -> {
				payload.put("stage", "done")
				payload.put("fraction", 1.0)
				payload.put("outputUri", (publishedUri ?: Uri.fromFile(event.outputFile)).toString())
				// Terminal — a later `exportCancel` for this id must not tear
				// down whatever export started after it.
				if (activeExportId == exportId) activeExportId = null
			}
			is Media3Exporter.Event.Error -> {
				payload.put("stage", "error")
				payload.put("fraction", 1.0)
				payload.put("error", event.message)
				if (activeExportId == exportId) activeExportId = null
			}
		}
		return payload
	}

	// -- transcribe (M10) ---------------------------------------------------

	/**
	 * Cutlyra M10. Ported from the captions track's `NativeBridgePlugin.java`
	 * when that file was superseded by this Kotlin one (the M4 Java->Kotlin
	 * port and the M10 STT work happened on separate tracks and met at the
	 * merge) — same behavior, same `WhisperTranscriber` call, same error
	 * codes.
	 *
	 * Real plumbing, honestly incomplete native depth — see
	 * `app.cutlyra.editor.stt.WhisperTranscriber`'s class doc comment for
	 * exactly what is and isn't wired yet. Runs off the main thread: even
	 * once the two gaps documented there are closed, `whisper_full()` is a
	 * synchronous, CPU-bound native call that must never block Capacitor's
	 * (UI-thread-adjacent) plugin call dispatch — plan M10 item 7, "Async
	 * job with progress. Never block the UI."
	 */
	@PluginMethod
	fun transcribe(call: PluginCall) {
		val audioUri = call.getString("audioUri")
		if (audioUri == null) {
			call.reject("audioUri is required", "IO_ERROR")
			return
		}
		val modelSize = call.getString("modelSize", "tiny") ?: "tiny"
		val languageHint = call.getString("languageHint")

		Thread {
			try {
				val result = WhisperTranscriber.transcribe(context, audioUri, modelSize, languageHint)
				call.resolve(result)
			} catch (e: WhisperTranscriber.NotYetWiredException) {
				call.reject(e.message, "NOT_IMPLEMENTED")
			} catch (e: Exception) {
				call.reject("transcribe failed: ${e.message}", "IO_ERROR", e)
			}
		}.start()
	}

	// -- Project backup (GitHub #35 / Linear PAV-51) -------------------------

	/** The `PluginCall` waiting on the SAF create/open-document round trip.
	 *  Capacitor re-delivers the ORIGINAL call to the `@ActivityCallback`,
	 *  but the suggested name / pick mode live only in that original call's
	 *  params — the field exists so at most ONE archive picker is in flight
	 *  (mirrors `pendingCameraCapture`). */
	private var pendingArchivePick: PluginCall? = null

	/** True when the in-flight pick is a CREATE (export destination), false
	 *  for an OPEN (import source) — used to take the right persistable grant
	 *  flag in the shared result callback. Capacitor's `PluginCall` does not
	 *  expose its own method name, so the mode is tracked here. */
	private var pendingArchivePickIsDestination = false

	/** GitHub #37 — the ownership evidence NATIVE itself recorded at pick
	 *  time: the document our CREATE pick probed and the size it reported
	 *  before any byte was written. Cleanup decisions read ONLY this, never a
	 *  value echoed back through the web view, so a tampered JS layer cannot
	 *  talk the plugin into deleting a file it does not own. A single slot is
	 *  enough because at most one archive pick can be in flight. */
	@Volatile
	private var lastDestinationProbeUri: String? = null

	@Volatile
	private var lastDestinationProbeSize: Long = ArchiveDestination.SIZE_UNKNOWN

	/** SAF `ACTION_CREATE_DOCUMENT` for a NEW archive. Resolves with
	 *  `{uri}` (a `content://` the caller passes straight to
	 *  `exportArchive`) or rejects `USER_CANCELLED` when the user backs out —
	 *  `capacitor-bridge.ts` turns that rejection into the `null` its
	 *  "cancelled = not an error" contract expects. */
	@PluginMethod
	fun pickArchiveDestination(call: PluginCall) {
		val suggestedName = call.getString("suggestedName") ?: "cutlyra-backup.cutlyra-backup"
		if (pendingArchivePick != null) {
			call.reject("An archive picker is already open", "IO_ERROR")
			return
		}
		val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
			addCategory(Intent.CATEGORY_OPENABLE)
			type = "application/octet-stream"
			putExtra(Intent.EXTRA_TITLE, suggestedName)
		}
		pendingArchivePick = call
		pendingArchivePickIsDestination = true
		startActivityForResult(call, intent, "handleArchivePickResult")
	}

	/** SAF `ACTION_OPEN_DOCUMENT` for an EXISTING archive. Resolves with
	 *  `{uri}` or rejects `USER_CANCELLED` (same contract as above). */
	@PluginMethod
	fun pickArchiveSource(call: PluginCall) {
		if (pendingArchivePick != null) {
			call.reject("An archive picker is already open", "IO_ERROR")
			return
		}
		val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
			addCategory(Intent.CATEGORY_OPENABLE)
			type = "*/*"
			putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/zip"))
		}
		pendingArchivePick = call
		pendingArchivePickIsDestination = false
		startActivityForResult(call, intent, "handleArchivePickResult")
	}

	@ActivityCallback
	private fun handleArchivePickResult(call: PluginCall, result: ActivityResult) {
		val isDestination = pendingArchivePickIsDestination
		pendingArchivePick = null
		pendingArchivePickIsDestination = false
		if (result.resultCode != Activity.RESULT_OK) {
			call.reject("User cancelled archive selection", "USER_CANCELLED")
			return
		}
		val uri = result.data?.data
		if (uri == null) {
			call.reject("No archive location selected", "USER_CANCELLED")
			return
		}
		// Persist the grant so a multi-minute export isn't cut off by a
		// transient read/write permission — SAF revokes non-persisted grants
		// when the returning Activity finishes.
		try {
			context.contentResolver.takePersistableUriPermission(
				uri,
				if (isDestination) {
					Intent.FLAG_GRANT_WRITE_URI_PERMISSION
				} else {
					Intent.FLAG_GRANT_READ_URI_PERMISSION
				},
			)
		} catch (_: SecurityException) {
			// Some providers don't offer persistable grants; the ephemeral one
			// is still valid for the immediate call below.
		}

		// GitHub #37: capture the destination's size NOW, before any of our
		// bytes are written. A CREATE pick that reports 0 is a document this
		// operation just created, so a failed export may delete it again; a
		// non-zero size means the user pointed us at an existing file, which we
		// must never delete. Reading the provider can block (cloud providers),
		// so it happens off the main thread before resolving.
		Thread {
			val ret = JSObject()
			ret.put("uri", uri.toString())
			if (isDestination) {
				val (size, name) = probeDestination(context.contentResolver, uri)
				// Record the evidence HERE, in native memory, before JS learns
				// the URI — see lastDestinationProbeUri. The echoed copy in the
				// pick result is convenience for the UI, not evidence.
				lastDestinationProbeUri = uri.toString()
				lastDestinationProbeSize = size
				ret.put("sizeBytesAtPick", size)
				ret.put("displayName", name)
				ret.put("isNewlyCreated", ArchiveDestination.ownership(size, true) == ArchiveDestination.Ownership.NEWLY_CREATED)
			}
			call.resolve(ret)
		}.start()
	}

	/** Reads `OpenableColumns.SIZE` / `DISPLAY_NAME` for a picked document.
	 *  SIZE returns [ArchiveDestination.SIZE_UNKNOWN] when the provider will not
	 *  answer — which (deliberately) makes the destination not provably ours. */
	private fun probeDestination(resolver: android.content.ContentResolver, uri: android.net.Uri): Pair<Long, String?> {
		return try {
			var size = ArchiveDestination.SIZE_UNKNOWN
			var name: String? = null
			resolver.query(uri, arrayOf(OpenableColumns.SIZE, OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
				if (c.moveToFirst()) {
					val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
					if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
					val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
					if (nameIdx >= 0 && !c.isNull(nameIdx)) name = c.getString(nameIdx)
				}
			}
			size to name
		} catch (_: Exception) {
			// Unknown is safe: it just means we will not delete on failure.
			ArchiveDestination.SIZE_UNKNOWN to null
		}
	}

	/**
	 * GitHub #37: removes an archive destination that was created empty by this
	 * operation but never got written (the JS side failed before reaching
	 * `exportArchive`, e.g. building the recipe threw).
	 *
	 * Always resolves — a provider that declines to delete is a normal answer,
	 * not an exception, because the caller must be able to report "the empty
	 * file is still there" honestly rather than claim a clean failure.
	 */
	@PluginMethod
	fun discardArchiveDestination(call: PluginCall) {
		val uri = call.getString("uri")
		if (uri == null) {
			call.reject("discardArchiveDestination requires {uri}", "IO_ERROR")
			return
		}
		// Ownership comes from the probe NATIVE recorded, matched against the
		// exact URI being discarded — the client-sent sizeBytesAtPick is
		// deliberately ignored (see lastDestinationProbeUri).
		val ownership = ArchiveDestination.ownershipForPick(
			recordedUri = lastDestinationProbeUri,
			recordedSize = lastDestinationProbeSize,
			requestUri = uri,
		)
		val outcome = ArchiveDestination.cleanup(
			uri = uri,
			ownership = ownership,
			ops = object : ArchiveDestination.DocumentOps {
				override fun deleteDocument(target: String): Boolean =
					android.provider.DocumentsContract.deleteDocument(context.contentResolver, android.net.Uri.parse(target))
			},
		)
		val ret = JSObject()
		ret.put("deleted", outcome is ArchiveDestination.CleanupOutcome.Removed)
		ret.put("outcome", outcomeLabel(outcome))
		// Just the "what is left on disk" sentence: JS prefixes the original
		// failure itself, so the wording lives in exactly one place.
		ret.put("message", ArchiveDestination.cleanupSuffix(ownership, outcome))
		call.resolve(ret)
	}

	private fun outcomeLabel(outcome: ArchiveDestination.CleanupOutcome): String = when (outcome) {
		is ArchiveDestination.CleanupOutcome.Removed -> "removed"
		is ArchiveDestination.CleanupOutcome.Refused -> "refused"
		ArchiveDestination.CleanupOutcome.NotAttempted -> "not-attempted"
	}

	/** Native archive assembly: reads real media bytes from custody, hashes
	 *  them, streams a STORE ZIP to the SAF destination. Runs off the calling
	 *  thread (disk I/O); resolves with `{manifestJson}` or rejects with
	 *  `IO_ERROR`/`CORRUPT_ARCHIVE` (see `BackupArchive.ArchiveException`). */
	@PluginMethod
	fun exportArchive(call: PluginCall) {
		val destinationUri = call.getString("destinationUri")
		val projectJson = call.getString("projectJson")
		val mediaArr = call.getArray("media")
		val appVersion = call.getString("appVersion") ?: "0"
		if (destinationUri == null || projectJson == null || mediaArr == null) {
			call.reject("exportArchive requires {destinationUri, projectJson, media}", "IO_ERROR")
			return
		}
		val media = try {
			parseMediaDescriptors(mediaArr)
		} catch (e: Exception) {
			call.reject("Invalid media descriptors: ${e.message}", "IO_ERROR")
			return
		}
		// GitHub #37 — ownership evidence is the native probe of THIS pick,
		// matched to the destination URI. The client-echoed size is ignored.
		val ownership = ArchiveDestination.ownershipForPick(
			recordedUri = lastDestinationProbeUri,
			recordedSize = lastDestinationProbeSize,
			requestUri = destinationUri,
		)
		Thread {
			try {
				val manifest = BackupArchive.export(
					context,
					Uri.parse(destinationUri),
					projectJson,
					media,
					appVersion,
					destinationOwnership = ownership,
				)
				val ret = JSObject()
				ret.put("manifestJson", manifest.toString())
				call.resolve(ret)
			} catch (e: BackupArchive.ArchiveException) {
				call.reject(e.message, e.code, e)
			} catch (e: Exception) {
				call.reject("Archive export failed: ${e.message}", "IO_ERROR", e)
			}
		}.start()
	}

	/** Native archive import: verifies EVERY entry's SHA-256, extracts media
	 *  to fresh custody paths (staging → atomic move), resolves with the
	 *  manifest + project JSON + fresh-path restore map. Nothing is committed
	 *  on an integrity failure. */
	@PluginMethod
	fun importArchive(call: PluginCall) {
		val sourceUri = call.getString("sourceUri")
		if (sourceUri == null) {
			call.reject("importArchive requires {sourceUri}", "IO_ERROR")
			return
		}
		Thread {
			try {
				val result = BackupArchive.import(context, Uri.parse(sourceUri))
				val ret = JSObject()
				ret.put("manifestJson", result.manifest.toString())
				ret.put("projectJson", result.projectJson)
				val files = JSArray()
				for (f in result.restoredFiles) {
					val one = JSObject()
					one.put("assetId", f.assetId)
					one.put("role", f.role)
					one.put("newPath", f.newPath)
					one.put("sha256", f.sha256)
					f.frameIndex?.let { index -> one.put("frameIndex", index) }
					files.put(one)
				}
				ret.put("restoredFiles", files)
				call.resolve(ret)
			} catch (e: BackupArchive.ArchiveException) {
				call.reject(e.message, e.code, e)
			} catch (e: Exception) {
				call.reject("Archive import failed: ${e.message}", "IO_ERROR", e)
			}
		}.start()
	}

	private fun parseMediaDescriptors(arr: JSArray): List<BackupArchive.MediaDescriptor> {
		val out = mutableListOf<BackupArchive.MediaDescriptor>()
		for (i in 0 until arr.length()) {
			val o = arr.optJSONObject(i) ?: continue
			out.add(
				BackupArchive.MediaDescriptor(
					assetId = o.getString("assetId"),
					proxyPath = o.optString("proxyPath", "").takeIf { it.isNotEmpty() && it != "null" },
					sourcePath = o.optString("sourcePath", "").takeIf { it.isNotEmpty() && it != "null" },
					thumbnailPath = o.optString("thumbnailPath", "").takeIf { it.isNotEmpty() && it != "null" },
					name = o.optString("name", ""),
					type = o.optString("type", "video"),
					sizeBytes = o.optLong("sizeBytes", 0L),
					lastModified = o.optLong("lastModified", 0L),
					width = if (o.has("width")) o.optInt("width") else null,
					height = if (o.has("height")) o.optInt("height") else null,
					duration = if (o.has("duration")) o.optDouble("duration") else null,
					fps = if (o.has("fps")) o.optDouble("fps") else null,
					hasAudio = if (o.has("hasAudio")) o.optBoolean("hasAudio") else null,
					sourceRotationDegrees = if (o.has("sourceRotationDegrees")) o.optInt("sourceRotationDegrees") else null,
					sourceWidth = if (o.has("sourceWidth")) o.optInt("sourceWidth") else null,
					sourceHeight = if (o.has("sourceHeight")) o.optInt("sourceHeight") else null,
					gif = o.optJSONObject("gif")?.let { gif ->
						BackupArchive.MediaDescriptor.GifMetadata(
							width = gif.optInt("width"),
							height = gif.optInt("height"),
							loopCount = gif.optInt("loopCount"),
							frameDelaysMs = gif.optJSONArray("frameDelaysMs")?.let { delays ->
								(0 until delays.length()).map { delays.optDouble(it) }
							}.orEmpty(),
						)
					},
					gifFrames = o.optJSONArray("gifFrames")?.let { frames ->
						(0 until frames.length())
							.map { frames.optString(it) }
							.filter { it.isNotBlank() }
					}.orEmpty(),
					freezeFrame = o.optJSONObject("freezeFrame")?.let { freeze ->
						BackupArchive.MediaDescriptor.FreezeFrameBlock(
							sourceElementId = freeze.optString("sourceElementId"),
							sourceMediaId = freeze.optString("sourceMediaId"),
							sourceTimestampMicros = freeze.optLong("sourceTimestampMicros"),
							holdDurationMicros = freeze.optLong("holdDurationMicros"),
							width = freeze.optInt("width"),
							height = freeze.optInt("height"),
							capturedAt = freeze.optString("capturedAt"),
						)
					},
				),
			)
		}
		return out
	}

	// -- shared -----------------------------------------------------------

	/** Every `MediaHandle.uri` this plugin ever hands to JS is a
	 * `Uri.fromFile(...)`-shaped `file://` path into app-private storage
	 * (see `mediaHandleToJson`) — so this is the one place that contract is
	 * decoded back into a `File` for a follow-up call (`generateProxy`/
	 * `generateThumbnails`). Any other scheme is rejected as `UNSUPPORTED`
	 * rather than guessed at. */
	/** `handle.uri` reaches native in TWO shapes and both are legitimate: this
	 *  plugin's own `pickMedia` emits `Uri.fromFile(...)` (`file:///data/...`),
	 *  while iOS emits — and the JS contract documents (types.ts) — a RAW
	 *  absolute path with no scheme, which is what iOS's
	 *  `URL(fileURLWithPath:)` consumes. Accepting only the scheme'd form made
	 *  every raw-path handle fail `generateProxy`/`generateThumbnails` with
	 *  UNSUPPORTED (caught on the emulator: video import died while image and
	 *  audio, which skip this path, sailed through). */
	private fun fileFromNativeUri(uriString: String): File? {
		if (uriString.startsWith("/")) return File(uriString)
		val uri = Uri.parse(uriString)
		if (uri.scheme != "file") return null
		val path = uri.path ?: return null
		return File(path)
	}

	// -- Freeze Frame / GIF export (M10 sprint) -----------------------------

	/** Captures the SOURCE frame at `timestampMicros` for a Freeze Frame.
	 *
	 *  The JS side maps timeline time to source time (trim + retime) and passes
	 *  the resulting instant; this method extracts exactly that instant with
	 *  MediaMetadataRetriever (`OPTION_CLOSEST`, never a keyframe seek), writes
	 *  it as a real PNG in MEDIA CUSTODY (not cache — the still must persist and
	 *  be backed up), and returns its custody-relative path + dimensions.
	 *
	 *  Failures are typed (`CAPTURE_OUT_OF_RANGE`, `CAPTURE_FAILED`, `IO_ERROR`).
	 *  There is NO fallback frame: a freeze that cannot be extracted at the
	 *  requested instant is refused rather than silently showing another frame.
	 *  `referencedFreezePaths` lets the same call prune stills the project no
	 *  longer references. */
	@PluginMethod
	fun captureFreezeFrame(call: PluginCall) {
		val sourceElementId = call.getString("sourceElementId")
		val timestampMicros = call.getLong("timestampMicros") ?: 0L
		val sourcePath = call.getString("sourceMediaPath") ?: call.getString("sourceUri")
		if (sourceElementId.isNullOrBlank()) {
			call.reject("sourceElementId is required", "INVALID_ARGS")
			return
		}
		if (sourcePath.isNullOrBlank()) {
			call.reject("sourceMediaPath or sourceUri is required", "INVALID_ARGS")
			return
		}
		val referencedPaths = call.getArray("referencedFreezePaths")?.let { array ->
			(0 until array.length())
				.map { array.optString(it) }
				.filter { it.isNotBlank() }
		}.orEmpty()
		Thread {
			try {
				val sourceFile = fileFromNativeUri(sourcePath)
					?: throw FreezeFrameCapture.CaptureException(
						"CAPTURE_FAILED",
						"Source media is not a local file: $sourcePath",
					)
				// Prune FIRST: the list is the project's referenced set, which does
				// not yet contain the still this call is about to write.
				FreezeFrameCapture.pruneUnreferenced(
					custodyRoot = context.noBackupFilesDir,
					referencedPaths = referencedPaths,
				)
				val frame = FreezeFrameCapture.capture(
					sourceFile = sourceFile,
					timestampMicros = timestampMicros,
					custodyRoot = context.noBackupFilesDir,
				)
				val result = JSObject()
				result.put("captured", true)
				result.put("relativePath", frame.relativePath)
				result.put("uri", Uri.fromFile(frame.file).toString())
				result.put("sourceElementId", sourceElementId)
				result.put("timestampMicros", frame.timestampMicros)
				result.put("width", frame.width)
				result.put("height", frame.height)
				call.resolve(result)
			} catch (e: FreezeFrameCapture.CaptureException) {
				call.reject(e.message, e.code, e)
			} catch (e: Exception) {
				call.reject("freeze-frame capture failed: ${e.message}", "CAPTURE_FAILED", e)
			}
		}.start()
	}

	/**
	 * Decodes an imported GIF into per-frame PNGs inside media custody and
	 * returns its timing metadata. Called during native import so the project
	 * carries the same dimensions, per-frame delays and loop count the shared
	 * renderer uses — native-custody assets have a zero-byte JS stub, so the
	 * JS decoder can never see the bytes.
	 */
	@PluginMethod
	fun decodeGifAsset(call: PluginCall) {
		val uri = call.getString("uri")
		val assetId = call.getString("assetId")
		if (uri.isNullOrBlank() || assetId.isNullOrBlank()) {
			call.reject("assetId and uri are required", "INVALID_ARGS")
			return
		}
		try {
			val file = fileFromNativeUri(uri)
			if (file == null || !file.isFile) {
				call.reject("GIF file not found: $uri", "IO_ERROR")
				return
			}
			if (!GifAssetPreparer.isGifFile(file)) {
				call.reject("Not a GIF: ${file.name}", "NOT_A_GIF")
				return
			}
			val prepared = GifAssetPreparer.prepareFromFile(
				gifFile = file,
				outputRoot = context.noBackupFilesDir,
				assetId = assetId,
			)
			// A re-import of the same asset can decode a different frame count;
			// stale PNGs from the previous decode would otherwise linger in
			// custody forever. The frames just written are the referenced set.
			GifFrameCleanup.pruneAssetFrames(
				custodyRoot = context.noBackupFilesDir,
				assetId = assetId,
				referencedPaths = prepared.frames.map { it.relativePath },
			)
			val frames = JSArray()
			for (frame in prepared.frames) {
				frames.put(
					JSObject().apply {
						put("relativePath", frame.relativePath)
						put("delayMs", frame.delayMs)
					}
				)
			}
			call.resolve(
				JSObject().apply {
					put("assetId", assetId)
					put("width", prepared.width)
					put("height", prepared.height)
					put("loopCount", prepared.loopCount)
					put("totalDurationMs", prepared.totalDurationMs)
					put("frames", frames)
				}
			)
		} catch (e: Exception) {
			call.reject("Could not decode GIF: ${e.message}", "GIF_DECODE_FAILED")
		}
	}

	/**
	 * Export preflight for a GIF asset: proves every frame the EDL is about to
	 * reference really decodes, before Media3 starts encoding.
	 *
	 * This used to only check that the paths existed, which cannot tell a real
	 * frame from a truncated PNG — the exporter would then die mid-encode with
	 * an opaque "Asset loader error". Each frame is now DECODED (and its
	 * dimensions checked against the first frame), so a corrupt or inconsistent
	 * frame fails HERE with a typed code and the offending path:
	 * `GIF_FRAMES_MISSING`, `GIF_FRAME_UNREADABLE`,
	 * `GIF_FRAME_DIMENSION_MISMATCH`, `INVALID_ARGS`.
	 */
	@PluginMethod
	fun prepareGifExport(call: PluginCall) {
		val assetId = call.getString("assetId")
		val frames = call.getArray("frames")
		if (assetId.isNullOrBlank() || frames == null || frames.length() == 0) {
			call.reject(
				"assetId and at least one frames[{relativePath, delayMs}] are required",
				"INVALID_ARGS",
			)
			return
		}
		val refs = mutableListOf<GifExportPreflight.FrameRef>()
		for (index in 0 until frames.length()) {
			val frame = frames.optJSONObject(index)
			val relativePath = frame?.optString("relativePath").orEmpty()
			val delayMs = frame?.optLong("delayMs", -1L) ?: -1L
			if (relativePath.isBlank() || delayMs < 0L) {
				call.reject(
					"frame[$index] needs a relativePath and a non-negative delayMs",
					"INVALID_ARGS",
				)
				return
			}
			refs.add(GifExportPreflight.FrameRef(relativePath, delayMs))
		}
		try {
			val report = GifExportPreflight.verify(
				custodyRoot = context.noBackupFilesDir,
				frames = refs,
			)
			call.resolve(
				JSObject().apply {
					put("assetId", assetId)
					put("ready", true)
					put("frameCount", report.frameCount)
					put("width", report.width)
					put("height", report.height)
					put("totalDurationMs", report.totalDurationMs)
				}
			)
		} catch (e: GifExportPreflight.Refusal) {
			call.reject(e.message ?: "GIF export preflight failed", e.code)
		}
	}

	// -- Reverse Video ------------------------------------------------------

	/**
	 * Generates a real reversed MP4 for the source range `[startMs, endMs)` and
	 * returns its custody-relative path plus dimensions.
	 *
	 * This is the whole native half of Reverse: [`ReverseMediaGenerator`] samples
	 * the clip's own source frames backwards and encodes them into an ordinary
	 * forward-playing file. Nothing about playback, preview or export needs to
	 * understand "reverse"; the clip simply points at this file.
	 *
	 * The file is video-only by construction (the reversed clip is silent; the
	 * JS side records and displays that). Progress is streamed as
	 * `reverseProgress` (`{assetId, done, total, progress}`), and
	 * `cancelReverseVideo` aborts between frames. Partial output is deleted on
	 * both failure and cancellation, and stale generated files the project no
	 * longer references are pruned before generation starts.
	 */
	@PluginMethod
	fun reverseVideo(call: PluginCall) {
		val assetId = call.getString("assetId")
		val sourcePath = call.getString("sourceMediaPath") ?: call.getString("sourceUri")
		val startMs = call.getLong("startMs")
		val endMs = call.getLong("endMs")
		if (assetId.isNullOrBlank()) {
			call.reject("assetId is required", "INVALID_ARGS")
			return
		}
		if (sourcePath.isNullOrBlank()) {
			call.reject("sourceMediaPath is required", "INVALID_ARGS")
			return
		}
		if (startMs == null || endMs == null) {
			call.reject("startMs and endMs are required", "INVALID_ARGS")
			return
		}
		val fps = call.getInt("fps") ?: 30
		val referencedPaths = call.getArray("referencedReversePaths")?.let { array ->
			(0 until array.length())
				.map { array.optString(it) }
				.filter { it.isNotBlank() }
		}.orEmpty()
		reverseCancelRequested = false
		Thread {
			try {
				val sourceFile = fileFromNativeUri(sourcePath)
					?: throw ReverseMediaGenerator.ReverseException(
						"SOURCE_UNREADABLE",
						"Source media is not a local file: $sourcePath",
					)
				ReverseMediaGenerator.pruneUnreferenced(
					custodyRoot = context.noBackupFilesDir,
					referencedPaths = referencedPaths,
				)
				val generated = ReverseMediaGenerator.generate(
					sourceFile = sourceFile,
					startMs = startMs,
					endMs = endMs,
					fps = fps,
					custodyRoot = context.noBackupFilesDir,
					isCancelled = { reverseCancelRequested },
					onProgress = { done, total ->
						notifyListeners(
							"reverseProgress",
							JSObject().apply {
								put("assetId", assetId)
								put("done", done)
								put("total", total)
								put("progress", done.toDouble() / total.toDouble())
							},
						)
					},
				)
				call.resolve(
					JSObject().apply {
						put("assetId", assetId)
						put("relativePath", generated.relativePath)
						put("uri", Uri.fromFile(generated.file).toString())
						put("width", generated.width)
						put("height", generated.height)
						put("durationMs", generated.durationMs)
						put("frameCount", generated.frameCount)
						put("hasAudio", generated.hasAudio)
						put("startMs", startMs)
						put("endMs", endMs)
					}
				)
			} catch (e: ReverseMediaGenerator.ReverseException) {
				call.reject(e.message, e.code, e)
			} catch (e: Exception) {
				call.reject("reverse generation failed: ${e.message}", "REVERSE_FAILED", e)
			}
		}.start()
	}

	/** Requests cancellation of the in-flight [reverseVideo]. The generator
	 *  checks this between frames and rejects `CANCELLED`. */
	@PluginMethod
	fun cancelReverseVideo(call: PluginCall) {
		reverseCancelRequested = true
		call.resolve(JSObject().apply { put("cancelled", true) })
	}

	private companion object {
		/** Refuse to start a take when custody has less than this free: a
		 *  5-minute 44.1kHz mono take is ~26 MB, so 8 MB is a floor that
		 *  still fails fast instead of filling the disk mid-recording. */
		const val MIN_FREE_BYTES_FOR_TAKE = 8L * 1024L * 1024L
	}
}

