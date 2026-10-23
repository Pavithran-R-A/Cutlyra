package app.cutlyra.editor.backup

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * The native half of the project-backup archive (GitHub #35 / Linear PAV-51).
 *
 * This mirrors the TypeScript reference format in
 * `packages/editor-core/src/services/backup/archive-format.ts` exactly, so an
 * archive written on Android can be read by the web build (and vice versa):
 *
 *   manifest.json                          the versioned ArchiveManifest
 *   data/<enc(projectId)>/project.json     the SerializedProject
 *   data/<enc(projectId)>/media/<enc(assetId)>/<role><ext>   media files
 *
 * The media BYTES never cross the bridge (plan §2.2) — this module reads them
 * directly from native custody (`noBackupFilesDir/<subdir>/…`), SHA-256-hashes
 * each while streaming it into the container, and writes to a SAF
 * `content://` destination. Restore is the mirror: it verifies EVERY entry's
 * SHA-256 before committing anything, extracts media to FRESH custody paths
 * (staging dir → atomic rename) so a restore never overwrites an existing
 * file, and returns the fresh-path map for JS to persist.
 *
 * Interrupted-operation recovery: export writes to a temp sibling and only
 * the completed ZIP is copied to the SAF destination; import extracts to a
 * `restore-staging/` dir and only moves files into `media/` after every hash
 * verifies. A crash mid-operation leaves at worst a temp/staging dir that the
 * next import cleans up — never a half-written archive the app would accept.
 *
 * The SAF document itself is created by the system picker BEFORE we write a
 * single byte, so a failed export used to strand a 0-byte (or half-copied)
 * `.cutlyra-backup` in the user's folder. GitHub #37: on failure the
 * destination is deleted when [ArchiveDestination] can prove it was created
 * empty by this operation's picker, and the thrown message states plainly
 * whether that file was removed or is still there.
 */
object BackupArchive {

	class ArchiveException(val code: String, message: String, cause: Throwable? = null) :
		RuntimeException(message, cause)

	private const val MANIFEST_ENTRY = "manifest.json"
	private const val COPY_BUFFER_BYTES = 64 * 1024
	private const val STAGING_SUBDIR = "restore-staging"
	private const val FORMAT = "cutlyra-backup"
	private const val FORMAT_VERSION = 1

	// ---------------------------------------------------------------------
	// Export
	// ---------------------------------------------------------------------

	/** One media descriptor as JS sent it over the bridge (JSON-only). */
	data class MediaDescriptor(
		val assetId: String,
		val proxyPath: String?,
		val sourcePath: String?,
		val thumbnailPath: String?,
		val name: String,
		val type: String,
		val sizeBytes: Long,
		val lastModified: Long,
		val width: Int?,
		val height: Int?,
		val duration: Double?,
		val fps: Double?,
		val hasAudio: Boolean?,
		val sourceRotationDegrees: Int?,
		val sourceWidth: Int?,
		val sourceHeight: Int?,
	)

	/**
	 * Assembles a complete archive and writes it to [destinationUri]. Returns
	 * the authoritative manifest JSON (with the SHA-256 values computed here).
	 * Throws [ArchiveException] with code `IO_ERROR` on any read/write failure
	 * — the caller (NativeBridgePlugin) maps it to a Capacitor rejection.
	 *
	 * GitHub #37: [destinationOwnership] records whether the SAF document was
	 * created empty by this operation's picker. On any failure the destination
	 * is cleaned up when that ownership is proven (and only then), and the
	 * thrown message says plainly whether the leftover file was removed or is
	 * still sitting in the user's folder.
	 */
	fun export(
		context: Context,
		destinationUri: Uri,
		projectJson: String,
		media: List<MediaDescriptor>,
		appVersion: String,
		destinationOwnership: ArchiveDestination.Ownership = ArchiveDestination.Ownership.UNKNOWN,
	): JSONObject {
		val custodyRoot = context.noBackupFilesDir
		val projectId = readProjectId(projectJson)
		val projectPath = "data/${UriComponent.encode(projectId)}/project.json"

		// Build the ZIP in memory (project + media are bounded by device
		// storage; streaming straight to SAF is fine too, but building here
		// lets us hash everything and only touch SAF once complete).
		val tmpFile = File.createTempFile("cutlyra-archive-", ".zip", context.cacheDir)
		try {
			val projectBytes = projectJson.toByteArray(Charsets.UTF_8)
			val projectSha = sha256Hex(projectBytes)

			val assetJson = JSONArray()
			lateinit var manifest: JSONObject

			ZipOutputStream(tmpFile.outputStream().buffered()).use { zip ->
				// Project JSON entry.
				zip.putNextEntry(ZipEntry(projectPath))
				zip.write(projectBytes)
				zip.closeEntry()

				for (desc in media) {
					val filesArr = JSONArray()
					val roles = listOf(
						Triple("proxy", desc.proxyPath, extensionOf(desc.proxyPath, desc.name, desc.type)),
						Triple("source", desc.sourcePath, extensionOf(desc.sourcePath, desc.name, desc.type)),
						Triple("thumbnail", desc.thumbnailPath, ".jpg"),
					)
					for ((role, relPath, ext) in roles) {
						if (relPath == null) continue
						val abs = File(custodyRoot, relPath)
						if (!abs.isFile) continue
						val entryPath =
							"data/${UriComponent.encode(projectId)}/media/${UriComponent.encode(desc.assetId)}/${role}${ext}"
						val (sha, size) = writeEntry(zip, entryPath, abs)
						val fileObj = JSONObject()
						fileObj.put("role", role)
						fileObj.put("path", entryPath)
						fileObj.put("sizeBytes", size)
						fileObj.put("sha256", sha)
						fileObj.put("extension", ext)
						filesArr.put(fileObj)
					}
					assetJson.put(assetToJson(desc, filesArr))
				}

				// Manifest written LAST so its hashes reflect everything; it is
				// also what gets returned to JS below (one build, not two).
				manifest = buildManifest(projectId, projectJson, projectPath, projectSha, assetJson, appVersion)
				zip.putNextEntry(ZipEntry(MANIFEST_ENTRY))
				zip.write(manifest.toString().toByteArray(Charsets.UTF_8))
				zip.closeEntry()
			}

			// Copy the finished ZIP to the SAF destination. A failure here
			// leaves the temp file (cleaned below) and never a partial SAF doc
			// the app would later accept — and because the SAF document itself
			// was created empty by the picker, it is removed in the catch below.
			tmpFile.inputStream().use { input ->
				context.contentResolver.openOutputStream(destinationUri, "wt")?.use { out ->
					copy(input, out)
				} ?: throw ArchiveException("IO_ERROR", "contentResolver.openOutputStream returned null for $destinationUri")
			}

			return manifest
		} catch (e: ArchiveException) {
			throw withDestinationCleanup(e, context, destinationUri, destinationOwnership)
		} catch (e: Exception) {
			val wrapped = ArchiveException("IO_ERROR", "Archive export failed", e)
			throw withDestinationCleanup(wrapped, context, destinationUri, destinationOwnership)
		} finally {
			tmpFile.delete()
		}
	}

	/**
	 * Runs destination cleanup for a failed export and rewrites the message so
	 * the caller learns what was left behind. Never converts a failure into a
	 * success and never swallows the original cause or its error code.
	 */
	private fun withDestinationCleanup(
		failure: ArchiveException,
		context: Context,
		destinationUri: Uri,
		ownership: ArchiveDestination.Ownership,
	): ArchiveException {
		val outcome = ArchiveDestination.cleanup(
			uri = destinationUri.toString(),
			ownership = ownership,
			ops = ContentResolverDocumentOps(context),
		)
		return ArchiveException(
			failure.code,
			ArchiveDestination.describeFailure(failure.message ?: "Archive export failed", ownership, outcome),
			failure,
		)
	}

	/** [ArchiveDestination.DocumentOps] over the real SAF provider. */
	private class ContentResolverDocumentOps(private val context: Context) : ArchiveDestination.DocumentOps {
		override fun deleteDocument(uri: String): Boolean =
			android.provider.DocumentsContract.deleteDocument(context.contentResolver, android.net.Uri.parse(uri))
	}

	// ---------------------------------------------------------------------
	// Import
	// ---------------------------------------------------------------------

	data class RestoredFile(val assetId: String, val role: String, val newPath: String, val sha256: String)

	data class ImportResult(
		val manifest: JSONObject,
		val projectJson: String,
		val restoredFiles: List<RestoredFile>,
	)

	/**
	 * Reads the archive at [sourceUri], verifies EVERY entry's SHA-256 against
	 * the manifest, extracts media to FRESH custody paths, and returns the
	 * manifest + project JSON + restore map. Throws [ArchiveException] with
	 * code `CORRUPT_ARCHIVE` on any integrity failure (nothing committed) or
	 * `UNSUPPORTED_FORMAT` for an unknown formatVersion.
	 */
	fun import(context: Context, sourceUri: Uri): ImportResult {
		val custodyRoot = context.noBackupFilesDir
		val staging = File(custodyRoot, "${STAGING_SUBDIR}/${UUID.randomUUID()}")
		staging.mkdirs()
		try {
			val entries = LinkedHashMap<String, ByteArray>()
			val input = context.contentResolver.openInputStream(sourceUri)
				?: throw ArchiveException("IO_ERROR", "contentResolver.openInputStream returned null for $sourceUri")
			input.use { stream ->
				ZipInputStream(stream.buffered()).use { zip ->
					while (true) {
						val entry = zip.nextEntry ?: break
						if (entry.isDirectory) continue
						entries[entry.name] = zip.readBytes()
					}
				}
			}

			val manifestBytes = entries[MANIFEST_ENTRY]
				?: throw ArchiveException("CORRUPT_ARCHIVE", "Archive is missing manifest.json")
			val manifest = JSONObject(String(manifestBytes, Charsets.UTF_8))
			validateManifest(manifest)

			// Verify every declared data entry's SHA-256 before writing.
			val projects = manifest.getJSONArray("projects")
			if (projects.length() != 1) {
				throw ArchiveException("UNSUPPORTED_FORMAT", "Expected exactly one project per archive")
			}
			val project = projects.getJSONObject(0)
			val projectEntry = project.getJSONObject("projectEntry")
			verifyEntry(entries, projectEntry.getString("path"), projectEntry.getString("sha256"), projectEntry.getLong("sizeBytes"))
			val projectJson = String(entries[projectEntry.getString("path")]!!, Charsets.UTF_8)

			// Extract media to staging under FRESH names. Nothing is moved into
			// final custody until EVERY entry has verified, so a failure on a
			// later entry cannot leave orphan media behind.
			val mediaDir = File(custodyRoot, "media")
			if (!mediaDir.exists()) mediaDir.mkdirs()
			val restored = mutableListOf<RestoredFile>()
			val pendingMoves = mutableListOf<Pair<File, File>>()
			val assets = project.getJSONArray("assets")
			for (i in 0 until assets.length()) {
				val asset = assets.getJSONObject(i)
				val assetId = asset.getString("id")
				val files = asset.getJSONArray("files")
				for (j in 0 until files.length()) {
					val f = files.getJSONObject(j)
					val role = f.getString("role")
					val path = f.getString("path")
					verifyEntry(entries, path, f.getString("sha256"), f.getLong("sizeBytes"))
					val bytes = entries[path]!!
					val ext = f.optString("extension", ".bin")
					val newFileName = "${UUID.randomUUID()}$ext"
					val staged = File(staging, newFileName)
					staged.writeBytes(bytes)
					pendingMoves.add(staged to File(mediaDir, newFileName))
					val relPath = "media/$newFileName"
					restored.add(RestoredFile(assetId, role, relPath, f.getString("sha256")))
				}
			}

			// Every hash verified: commit the extracted media into custody.
			for ((staged, dest) in pendingMoves) {
				if (!staged.renameTo(dest)) {
					staged.copyTo(dest, overwrite = true)
					staged.delete()
				}
			}

			return ImportResult(manifest, projectJson, restored)
		} catch (e: ArchiveException) {
			throw e
		} catch (e: java.util.zip.ZipException) {
			// A damaged/tampered container surfaces as an inflate or entry-name
			// failure; report it as damage rather than an I/O fault, and never
			// echo the raw decoder message to the user.
			throw ArchiveException("CORRUPT_ARCHIVE", "Archive is damaged and could not be read", e)
		} catch (e: EOFException) {
			throw ArchiveException("CORRUPT_ARCHIVE", "Archive is truncated and could not be read", e)
		} catch (e: JSONException) {
			throw ArchiveException("CORRUPT_ARCHIVE", "Archive manifest is not valid JSON", e)
		} catch (e: IOException) {
			throw ArchiveException("IO_ERROR", "Archive could not be read from or written to storage", e)
		} catch (e: Exception) {
			throw ArchiveException("IO_ERROR", "Archive import failed", e)
		} finally {
			staging.deleteRecursively()
			// Best-effort cleanup of any orphaned staging dirs from a prior crash.
			File(custodyRoot, STAGING_SUBDIR).listFiles()?.forEach { it.deleteRecursively() }
		}
	}

	// ---------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------

	private fun buildManifest(
		projectId: String,
		projectJson: String,
		projectPath: String,
		projectSha: String,
		assets: JSONArray,
		appVersion: String,
	): JSONObject {
		val projectEntry = JSONObject()
		projectEntry.put("path", projectPath)
		projectEntry.put("sizeBytes", projectJson.toByteArray(Charsets.UTF_8).size.toLong())
		projectEntry.put("sha256", projectSha)
		val archivedProject = JSONObject()
		archivedProject.put("id", projectId)
		archivedProject.put("name", readProjectName(projectJson))
		archivedProject.put("projectEntry", projectEntry)
		archivedProject.put("assets", assets)
		val projects = JSONArray()
		projects.put(archivedProject)
		val manifest = JSONObject()
		manifest.put("format", FORMAT)
		manifest.put("formatVersion", FORMAT_VERSION)
		manifest.put("appVersion", appVersion)
		manifest.put("createdAt", java.time.Instant.now().toString())
		manifest.put("projects", projects)
		return manifest
	}

	private fun assetToJson(desc: MediaDescriptor, files: JSONArray): JSONObject {
		val o = JSONObject()
		o.put("id", desc.assetId)
		o.put("name", desc.name)
		o.put("type", desc.type)
		o.put("sizeBytes", desc.sizeBytes)
		o.put("lastModified", desc.lastModified)
		desc.width?.let { o.put("width", it) }
		desc.height?.let { o.put("height", it) }
		desc.duration?.let { o.put("duration", it) }
		desc.fps?.let { o.put("fps", it) }
		desc.hasAudio?.let { o.put("hasAudio", it) }
		desc.sourceRotationDegrees?.let { o.put("sourceRotationDegrees", it) }
		desc.sourceWidth?.let { o.put("sourceWidth", it) }
		desc.sourceHeight?.let { o.put("sourceHeight", it) }
		o.put("files", files)
		return o
	}

	/** Streams [file] into [zip] at [entryPath], returning (sha256, size). */
	private fun writeEntry(zip: ZipOutputStream, entryPath: String, file: File): Pair<String, Long> {
		val digest = MessageDigest.getInstance("SHA-256")
		var size = 0L
		zip.putNextEntry(ZipEntry(entryPath))
		FileInputStream(file).use { input ->
			val buffer = ByteArray(COPY_BUFFER_BYTES)
			while (true) {
				val read = input.read(buffer)
				if (read == -1) break
				digest.update(buffer, 0, read)
				zip.write(buffer, 0, read)
				size += read
			}
		}
		zip.closeEntry()
		return Pair(digest.digest().joinToString("") { "%02x".format(it) }, size)
	}

	private fun verifyEntry(entries: Map<String, ByteArray>, path: String, expectedSha: String, expectedSize: Long) {
		verifySafePath(path)
		val bytes = entries[path]
			?: throw ArchiveException("CORRUPT_ARCHIVE", "Archive is missing declared entry $path")
		if (bytes.size.toLong() != expectedSize) {
			throw ArchiveException(
				"CORRUPT_ARCHIVE",
				"Size mismatch for $path: manifest says $expectedSize, archive holds ${bytes.size}",
			)
		}
		val actual = sha256Hex(bytes)
		if (actual != expectedSha) {
			throw ArchiveException("CORRUPT_ARCHIVE", "SHA-256 mismatch for $path: archive is corrupt or tampered")
		}
	}

	private fun validateManifest(m: JSONObject) {
		if (m.optString("format") != FORMAT) {
			throw ArchiveException("CORRUPT_ARCHIVE", "Unrecognized archive format marker")
		}
		if (m.optInt("formatVersion", -1) != FORMAT_VERSION) {
			throw ArchiveException(
				"UNSUPPORTED_FORMAT",
				"Archive format version ${m.optInt("formatVersion")} is not supported (expected $FORMAT_VERSION)",
			)
		}
		if (!m.has("projects") || m.get("projects") !is JSONArray) {
			throw ArchiveException("CORRUPT_ARCHIVE", "Invalid archive manifest: projects must be an array")
		}
	}

	private fun verifySafePath(path: String) {
		// Zip-slip guard: reject any path that could escape the extraction root.
		if (path.contains("..") || path.startsWith("/") || path.contains("\\") || path.contains("\u0000")) {
			throw ArchiveException("CORRUPT_ARCHIVE", "Unsafe archive path rejected: $path")
		}
	}

	private fun readProjectId(projectJson: String): String {
		return try {
			val id = JSONObject(projectJson).getJSONObject("metadata").getString("id")
			if (id.isBlank()) throw ArchiveException("CORRUPT_ARCHIVE", "project.json is missing metadata.id")
			id
		} catch (e: ArchiveException) {
			throw e
		} catch (e: Exception) {
			throw ArchiveException("CORRUPT_ARCHIVE", "project.json is not valid JSON", e)
		}
	}

	private fun readProjectName(projectJson: String): String {
		return try {
			JSONObject(projectJson).getJSONObject("metadata").optString("name", "")
		} catch (_: Exception) {
			""
		}
	}

	private fun extensionOf(relPath: String?, name: String, type: String): String {
		// Prefer the source file's own extension; fall back by type.
		val fromRel = relPath?.substringAfterLast('.', "")
		if (!fromRel.isNullOrBlank() && fromRel.length <= 5) return ".$fromRel"
		val fromName = name.substringAfterLast('.', "")
		if (fromName.isNotBlank() && fromName.length <= 5) return ".$fromName"
		return when (type) {
			"image" -> ".jpg"
			"audio" -> ".m4a"
			else -> ".mp4"
		}
	}

	private fun sha256Hex(bytes: ByteArray): String =
		MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

	private fun copy(input: InputStream, out: OutputStream) {
		val buffer = ByteArray(COPY_BUFFER_BYTES)
		while (true) {
			val read = input.read(buffer)
			if (read == -1) break
			out.write(buffer, 0, read)
		}
		out.flush()
	}
}
