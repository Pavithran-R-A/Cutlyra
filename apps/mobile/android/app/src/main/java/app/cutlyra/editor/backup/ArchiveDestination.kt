package app.cutlyra.editor.backup

/**
 * Ownership + cleanup for a SAF export destination (GitHub #37 / PAV-96).
 *
 * The problem this exists to solve: `ACTION_CREATE_DOCUMENT` hands back a
 * `content://` Uri for a document the system picker has ALREADY created, so a
 * backup that fails afterwards — recipe never built, the ZIP build threw, the
 * copy into SAF was interrupted — leaves a 0-byte or half-written archive at
 * the location the user picked. The next time they open that folder they see a
 * file that Cutlyra will later refuse to restore.
 *
 * Deleting is only safe when we can PROVE the destination was ours and empty:
 *
 *   - the Uri came from our own CREATE_DOCUMENT pick in this operation, and
 *   - the provider reported size 0 at the instant the pick returned, i.e.
 *     before any of our bytes were written.
 *
 * Then every byte in it was written by this backup, so removing it on failure
 * destroys nothing the user owned. Anything else — a pre-existing file the user
 * chose to overwrite, or a provider that refuses to even report a size — is
 * left alone, and the caller is told honestly that a file may remain.
 *
 * Deliberately free of `android.net.Uri` / `ContentResolver` so the decision
 * logic and its messages are unit-testable on the JVM (the plugin adapts a
 * `ContentResolver` into [DocumentOps]).
 */
object ArchiveDestination {

	/** Sentinel for "the provider would not report a size". Any negative
	 *  value means unknown — never treat it as "empty". */
	const val SIZE_UNKNOWN = -1L

	/**
	 * Resolves ownership from the evidence NATIVE recorded at pick time, keyed
	 * to the exact document being cleaned up.
	 *
	 * The size the JS layer echoes back is deliberately not evidence: the web
	 * view is not a trust boundary worth relying on, so a discard/export call
	 * for a URI this operation did not just probe (or whose probe disagrees)
	 * is never ours to delete. A picker that never recorded a probe for this
	 * URI — an app restart, a foreign URI — degrades to [Ownership.UNKNOWN].
	 *
	 * @param recordedUri the document the most recent CREATE pick probed, or
	 *        null when nothing has been probed.
	 * @param recordedSize the size that probe reported.
	 * @param requestUri the document cleanup is being asked to remove.
	 */
	fun ownershipForPick(recordedUri: String?, recordedSize: Long?, requestUri: String): Ownership {
		if (recordedUri == null || recordedUri != requestUri) return Ownership.UNKNOWN
		return ownership(recordedSize, isCreateDestination = true)
	}

	/** Whether the destination provably belonged to this backup attempt. */
	enum class Ownership {
		/** Provider reported a 0-byte document from our CREATE pick: everything
		 *  in it is ours, so it is safe to delete on failure. */
		NEWLY_CREATED,
		/** The document already held content when we picked it (the user chose
		 *  an existing file to overwrite). Never delete. */
		PRE_EXISTING,
		/** Unknown size, or not a destination this operation created. We cannot
		 *  prove it is ours, so never delete. */
		UNKNOWN,
	}

	/**
	 * Classifies a destination from the size the provider reported right after
	 * the pick returned (before we wrote anything).
	 *
	 * @param sizeBytesAtPick `OpenableColumns.SIZE` at pick time, or null /
	 *        [SIZE_UNKNOWN] when the provider would not say.
	 * @param isCreateDestination false for an OPEN_DOCUMENT source (an archive
	 *        we are restoring FROM) — those are never ours to delete.
	 */
	fun ownership(sizeBytesAtPick: Long?, isCreateDestination: Boolean): Ownership {
		if (!isCreateDestination) return Ownership.UNKNOWN
		val size = sizeBytesAtPick ?: return Ownership.UNKNOWN
		if (size < 0) return Ownership.UNKNOWN
		// A document the picker just created is exactly 0 bytes; anything else
		// already had content we must not destroy.
		return if (size == 0L) Ownership.NEWLY_CREATED else Ownership.PRE_EXISTING
	}

	/** The only document operation cleanup needs. Injected so tests can drive
	 *  compliant, refusing and throwing providers without a ContentResolver. */
	interface DocumentOps {
		/** Returns true only when the document is confirmed gone. */
		fun deleteDocument(uri: String): Boolean
	}

	/** What actually happened when cleanup ran. */
	sealed class CleanupOutcome {
		/** We removed the document; nothing of ours is left behind. */
		object Removed : CleanupOutcome()

		/** We deliberately did not attempt a delete (not provably ours). */
		object NotAttempted : CleanupOutcome()

		/** The provider refused or threw: the file may still be there, so the
		 *  operation must NOT be reported as a clean failure. */
		data class Refused(val reason: String) : CleanupOutcome()
	}

	/**
	 * Best-effort removal of a failed export's destination. Never throws and
	 * never lies: a provider that declines to delete yields [CleanupOutcome.Refused].
	 */
	fun cleanup(uri: String, ownership: Ownership, ops: DocumentOps): CleanupOutcome {
		// Only a destination we can prove was empty-and-ours may be deleted.
		if (ownership != Ownership.NEWLY_CREATED) return CleanupOutcome.NotAttempted
		return try {
			if (ops.deleteDocument(uri)) CleanupOutcome.Removed
			else CleanupOutcome.Refused("the storage provider declined the delete request")
		} catch (e: Exception) {
			CleanupOutcome.Refused(e.message?.takeIf { it.isNotBlank() } ?: "the delete failed")
		}
	}

	/**
	 * The user-facing failure sentence, honest about what was left on disk.
	 *
	 * This is where "refused to delete" is kept distinct from "removed": an
	 * interrupted backup that could not clean up itself must never read like a
	 * clean cancellation.
	 */
	fun describeFailure(cause: String, ownership: Ownership, cleanup: CleanupOutcome): String =
		"$cause ${cleanupSuffix(ownership, cleanup)}"

	/**
	 * The "what is left on disk" sentence on its own, so the JS side
	 * (`backup.ts`) can append the same wording to a failure it handled itself
	 * instead of re-inventing a second copy of it.
	 */
	fun cleanupSuffix(ownership: Ownership, cleanup: CleanupOutcome): String =
		when (cleanup) {
			is CleanupOutcome.Removed ->
				"The empty archive file it had created was removed."
			is CleanupOutcome.Refused ->
				"The file it created is still at the location you chose and must be " +
					"deleted by you — the storage provider would not let Cutlyra remove it (${cleanup.reason})."
			CleanupOutcome.NotAttempted ->
				when (ownership) {
					Ownership.PRE_EXISTING ->
						"The file you chose already existed, so it was left in place and " +
							"may now be incomplete — restore it from your own copy if needed."
					else ->
						"It could not be confirmed that the location was a new empty file, " +
							"so nothing there was deleted."
				}
		}
}
