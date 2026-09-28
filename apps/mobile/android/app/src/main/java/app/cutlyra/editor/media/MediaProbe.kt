package app.cutlyra.editor.media

import android.graphics.BitmapFactory
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.File

/**
 * Cutlyra M4 (plan M4 item 1) — probes a copied-into-custody local file for
 * exactly the fields `MediaHandle` needs
 * (`packages/native-bridge/src/types.ts`). Runs entirely against the local
 * `File` produced by `MediaImporter`, never the original `content://` URI —
 * so probing works identically whether the source was the Photo Picker, SAF,
 * or the camera intent.
 *
 * `MediaMetadataRetriever` supplies duration/rotation/has-audio (simple,
 * well-covered API); `MediaExtractor` supplies the codec MIME type and frame
 * rate, which `MediaMetadataRetriever` either lacks or reports unreliably
 * (`METADATA_KEY_CAPTURE_FRAMERATE` is the *capture* rate, not always the
 * container's encoded rate, and is frequently absent). No
 * `androidx.media3.exoplayer` dependency — both classes are plain
 * `android.media`, already on every device at minSdk 29.
 */
object MediaProbe {

	data class ProbedMedia(
		val kind: String,
		val durationMicros: Long,
		val width: Int,
		val height: Int,
		val rotationDegrees: Int,
		val hasAudio: Boolean,
		val codec: String,
		val frameRate: Rational?,
	)

	/** Finds the first track whose MIME type starts with [prefix] ("video/" or
	 * "audio/"), or null if the container has none. */
	private fun findTrackFormat(extractor: MediaExtractor, prefix: String): MediaFormat? {
		for (i in 0 until extractor.trackCount) {
			val format = extractor.getTrackFormat(i)
			val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
			if (mime.startsWith(prefix)) return format
		}
		return null
	}

	private fun readFloat(format: MediaFormat, key: String): Float? {
		if (!format.containsKey(key)) return null
		return try {
			format.getFloat(key)
		} catch (_: Exception) {
			// Some encoders write KEY_FRAME_RATE as an Integer, not a Float;
			// MediaFormat has no type-agnostic getter, so fall back explicitly.
			try {
				format.getInteger(key).toFloat()
			} catch (_: Exception) {
				null
			}
		}
	}

	fun probe(file: File, mimeTypeHint: String?): ProbedMedia {
		val retriever = MediaMetadataRetriever()
		val extractor = MediaExtractor()
		// MediaExtractor parses A/V containers only and THROWS on still
		// images (JPEG/HEIC) — seen live on an iQOO I2221 / Android 16
		// device in Stage 11 physical QA as `setDataSource failed: status =
		// 0x80000000`, which failed EVERY image import (the emulator's
		// autotest harness bypassed this path with pre-built handles, so
		// it never surfaced there).
		// On that device the RETRIEVER also rejects stills (same exception
		// text — only one framework parser is honest enough to say why),
		// so still-image dimensions fall back to BitmapFactory bounds (the
		// image-decoder path, always available) and every other still
		// field keeps its already-neutral default (0 duration, no
		// rotation, no audio).
		var extractorReady = false
		var retrieverReady = false
		try {
			try {
				retriever.setDataSource(file.absolutePath)
				retrieverReady = true
			} catch (_: Exception) {
				// Some devices' retriever refuses stills too — BitmapFactory below.
			}
			try {
				extractor.setDataSource(file.absolutePath)
				extractorReady = true
			} catch (_: Exception) {
				// Not an A/V container (a still image) — proceed without tracks.
			}

			// Guard every retriever read: extractMetadata before a successful
			// setDataSource is itself an exception on some framework versions.
			val durationMs: Long
			val rawWidth: Int
			val rawHeight: Int
			val rawRotation: Int
			val hasAudio: Boolean
			val mimeType: String?
			if (retrieverReady) {
				durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
					?.toLongOrNull() ?: 0L
				rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
					?.toIntOrNull() ?: 0
				rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
					?.toIntOrNull() ?: 0
				rawRotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
					?.toIntOrNull() ?: 0
				hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
				mimeType = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
					?: mimeTypeHint
			} else {
				// Still image on a device whose retriever refuses stills: every
				// field keeps its neutral default; dimensions come from
				// BitmapFactory in the kind=="image" branch below.
				durationMs = 0L
				rawWidth = 0
				rawHeight = 0
				rawRotation = 0
				hasAudio = false
				mimeType = mimeTypeHint
			}

			val kind = inferKindFromMime(mimeType)

			var codec = "unknown"
			var frameRate: Rational? = null
			var width = rawWidth
			var height = rawHeight

			val videoFormat = if (extractorReady) findTrackFormat(extractor, "video/") else null
			if (videoFormat != null) {
				codec = videoFormat.getString(MediaFormat.KEY_MIME) ?: codec
				readFloat(videoFormat, MediaFormat.KEY_FRAME_RATE)?.let {
					frameRate = frameRateToRational(it)
				}
				if (width == 0 && videoFormat.containsKey(MediaFormat.KEY_WIDTH)) {
					width = videoFormat.getInteger(MediaFormat.KEY_WIDTH)
				}
				if (height == 0 && videoFormat.containsKey(MediaFormat.KEY_HEIGHT)) {
					height = videoFormat.getInteger(MediaFormat.KEY_HEIGHT)
				}
			} else if (kind == "audio") {
				val audioFormat = findTrackFormat(extractor, "audio/")
				codec = audioFormat?.getString(MediaFormat.KEY_MIME) ?: codec
			} else if (kind == "image") {
				// Stills have no extractor tracks; the MIME (retriever where it
				// could parse the still, else the importer's content-type hint)
				// is the honest codec — a probe of `unknown` would mislabel
				// every image asset.
				codec = mimeType ?: mimeTypeHint ?: codec
				// Dimensions: the retriever supplies them where it can parse
				// the still; where it refused (this device), BitmapFactory's
				// bounds decode is the image-decoder path and always available.
				if (width == 0 && height == 0) {
					val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
					BitmapFactory.decodeFile(file.absolutePath, bounds)
					if (bounds.outWidth > 0 && bounds.outHeight > 0) {
						width = bounds.outWidth
						height = bounds.outHeight
					}
				}
			}

			return ProbedMedia(
				kind = kind,
				durationMicros = durationMs * 1000L,
				width = width,
				height = height,
				rotationDegrees = normalizeRotationDegrees(rawRotation),
				hasAudio = hasAudio || (kind == "audio"),
				codec = codec,
				frameRate = frameRate,
			)
		} finally {
			retriever.release()
			extractor.release()
		}
	}
}
// Kotlin's stdlib already provides String.toLongOrNull()/toIntOrNull() —
// used directly above, no local redeclaration needed.
