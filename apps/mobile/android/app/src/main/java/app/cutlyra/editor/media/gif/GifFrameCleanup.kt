package app.cutlyra.editor.media.gif

import java.io.File

/**
 * Safe cleanup for generated GIF frame files.
 *
 * Decoded frames are a DERIVED artefact: the project's metadata is the only
 * authority on which ones are in use. Re-importing the same asset can produce
 * a different frame count, and nothing else in the app knows the old PNGs are
 * dead — left alone they accumulate in media custody forever.
 *
 * The rule is the same one the rest of the app follows for generated media:
 * delete ONLY files the project no longer references, and never touch a file
 * that is still referenced. Paths are treated as data (normalized, never
 * resolved through `..`), and the asset's own directory is removed only once
 * it is empty, so an unrelated asset's frames can never be swept up.
 *
 * Pure `java.io.File` on purpose: it runs as a plain JVM unit test.
 */
object GifFrameCleanup {

    /**
     * Deletes frame files under `<custodyRoot>/gif/<assetId>/` that are not in
     * [referencedPaths], returning the removed custody-relative paths.
     *
     * Referenced paths OUTSIDE this asset's directory are ignored rather than
     * deleted: they belong to someone else.
     */
    fun pruneAssetFrames(
        custodyRoot: File,
        assetId: String,
        referencedPaths: Collection<String>,
    ): List<String> {
        if (assetId.isBlank()) return emptyList()
        val dirName = "gif/${sanitize(assetId)}"
        val directory = File(custodyRoot, dirName)
        if (!directory.isDirectory) return emptyList()

        val keep = referencedPaths.map { normalize(it) }.toSet()
        val removed = mutableListOf<String>()
        for (child in directory.listFiles().orEmpty()) {
            if (!child.isFile) continue
            val relativePath = "$dirName/${child.name}"
            if (relativePath in keep) continue
            if (child.delete()) removed.add(relativePath)
        }
        // The directory itself is unreferenced once nothing inside survives.
        if (directory.listFiles().isNullOrEmpty()) directory.delete()
        return removed
    }

    /** Matches the directory naming `GifAssetPreparer.prepare` writes. */
    private fun sanitize(assetId: String): String =
        assetId.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun normalize(path: String): String = path.replace('\\', '/')
}
