package app.cutlyra.editor.media.voiceover

import java.io.File

/**
 * Cleanup for voiceover takes in media custody.
 *
 * A take is a GENERATED artefact: the project's media rows are the only
 * authority on which takes are in use (undoing an insert removes the row but
 * not the file; a killed app leaves a `.tmp`). Left alone these accumulate in
 * custody forever, exactly like decoded GIF frames did before
 * `GifFrameCleanup`.
 *
 * The rule is the app-wide one for generated media: delete ONLY files the
 * project no longer references, never touch a referenced file, and never
 * touch a file outside this feature's namespace (`generated/voiceover-*`) —
 * library sounds and freeze frames share `generated/` and are not ours to
 * sweep. Paths are treated as data (normalized, no `..` resolution).
 *
 * Pure `java.io` so it runs as a plain JVM unit test.
 */
object VoiceoverTakeCleanup {

    private const val DIR_NAME = "generated"
    private const val PREFIX = "voiceover-"

    /**
     * Deletes `generated/voiceover-*` files under [custodyRoot] that are not
     * in [referencedPaths] (custody-root-relative, as stored on media rows).
     * Also removes leftover `<name>.wav.tmp` partials: an unfinished take is
     * never referenceable, so it is garbage by definition.
     */
    fun pruneTakes(custodyRoot: File, referencedPaths: Collection<String>): List<String> {
        val directory = File(custodyRoot, DIR_NAME)
        if (!directory.isDirectory) return emptyList()
        val keep = referencedPaths.map { normalize(it) }.toSet()
        val removed = mutableListOf<String>()
        for (child in directory.listFiles().orEmpty()) {
            if (!child.isFile) continue
            val name = child.name
            if (!name.startsWith(PREFIX)) continue
            val relativePath = "$DIR_NAME/$name"
            val isPartial = name.endsWith(".tmp")
            if (!isPartial && relativePath in keep) continue
            if (child.delete()) removed.add(relativePath)
        }
        return removed
    }

    private fun normalize(path: String): String = path.replace('\\', '/')
}
