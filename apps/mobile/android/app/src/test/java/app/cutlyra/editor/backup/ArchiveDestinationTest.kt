package app.cutlyra.editor.backup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GitHub #37 / PAV-96 — SAF export destination cleanup.
 *
 * These cover the decision layer only (which destinations may be deleted, and
 * what the user is told afterwards), with a fake [ArchiveDestination.DocumentOps]
 * standing in for the storage provider so a compliant, a refusing and a
 * throwing provider can all be exercised on the JVM.
 *
 * Two rules the tests exist to pin down:
 *   1. Delete only what we can PROVE this operation created empty.
 *   2. Never report a clean failure when a file was actually left behind.
 */
class ArchiveDestinationTest {

	/** Records every call so a test can assert a delete never happened. */
	private class FakeOps(
		private val deleteResult: Boolean = true,
		private val deleteThrows: Exception? = null,
	) : ArchiveDestination.DocumentOps {
		val deleteCalls = mutableListOf<String>()

		override fun deleteDocument(uri: String): Boolean {
			deleteCalls.add(uri)
			deleteThrows?.let { throw it }
			return deleteResult
		}
	}

	// -- ownership ----------------------------------------------------------

	@Test
	fun `a zero byte create-document pick is ours to clean`() {
		assertEquals(
			ArchiveDestination.Ownership.NEWLY_CREATED,
			ArchiveDestination.ownership(sizeBytesAtPick = 0L, isCreateDestination = true),
		)
	}

	@Test
	fun `an existing file the user chose is never ours`() {
		assertEquals(
			ArchiveDestination.Ownership.PRE_EXISTING,
			ArchiveDestination.ownership(sizeBytesAtPick = 4096L, isCreateDestination = true),
		)
	}

	@Test
	fun `an unknown size is never ours to clean`() {
		// Both "provider would not say" (null) and the SIZE_UNKNOWN sentinel.
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownership(sizeBytesAtPick = null, isCreateDestination = true),
		)
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownership(sizeBytesAtPick = ArchiveDestination.SIZE_UNKNOWN, isCreateDestination = true),
		)
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownership(sizeBytesAtPick = -42L, isCreateDestination = true),
		)
	}

	@Test
	fun `an open-document source is never ours even when empty`() {
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownership(sizeBytesAtPick = 0L, isCreateDestination = false),
		)
	}

	// -- ownershipForPick: native-held evidence, never client-echoed -------

	@Test
	fun `a probe this operation recorded for the same uri is trusted`() {
		assertEquals(
			ArchiveDestination.Ownership.NEWLY_CREATED,
			ArchiveDestination.ownershipForPick(
				recordedUri = "content://docs/7",
				recordedSize = 0L,
				requestUri = "content://docs/7",
			),
		)
	}

	@Test
	fun `a probe recording a non-zero file refuses deletion for that same uri`() {
		assertEquals(
			ArchiveDestination.Ownership.PRE_EXISTING,
			ArchiveDestination.ownershipForPick(
				recordedUri = "content://docs/8",
				recordedSize = 4096L,
				requestUri = "content://docs/8",
			),
		)
	}

	@Test
	fun `a uri the picker never probed is never ours`() {
		// Foreign URI: the client asks to delete something native never saw.
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownershipForPick(
				recordedUri = "content://docs/9",
				recordedSize = 0L,
				requestUri = "content://docs/attacker",
			),
		)
	}

	@Test
	fun `no recorded probe at all is never ours`() {
		// App restart / probe failed / never picked: nothing to prove with.
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownershipForPick(
				recordedUri = null,
				recordedSize = null,
				requestUri = "content://docs/10",
			),
		)
		assertEquals(
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.ownershipForPick(
				recordedUri = "content://docs/10",
				recordedSize = ArchiveDestination.SIZE_UNKNOWN,
				requestUri = "content://docs/10",
			),
		)
	}

	// -- cleanup ------------------------------------------------------------

	@Test
	fun `cleanup removes a newly created destination`() {
		val ops = FakeOps(deleteResult = true)
		val outcome = ArchiveDestination.cleanup("content://docs/1", ArchiveDestination.Ownership.NEWLY_CREATED, ops)
		assertEquals(ArchiveDestination.CleanupOutcome.Removed, outcome)
		assertEquals(listOf("content://docs/1"), ops.deleteCalls)
	}

	@Test
	fun `cleanup does not touch a pre-existing file`() {
		val ops = FakeOps(deleteResult = true)
		val outcome = ArchiveDestination.cleanup("content://docs/2", ArchiveDestination.Ownership.PRE_EXISTING, ops)
		assertEquals(ArchiveDestination.CleanupOutcome.NotAttempted, outcome)
		assertTrue("no delete may be attempted", ops.deleteCalls.isEmpty())
	}

	@Test
	fun `cleanup does not touch a destination whose ownership is unproven`() {
		val ops = FakeOps(deleteResult = true)
		val outcome = ArchiveDestination.cleanup("content://docs/3", ArchiveDestination.Ownership.UNKNOWN, ops)
		assertEquals(ArchiveDestination.CleanupOutcome.NotAttempted, outcome)
		assertTrue(ops.deleteCalls.isEmpty())
	}

	@Test
	fun `a provider that declines the delete reports refusal not success`() {
		val ops = FakeOps(deleteResult = false)
		val outcome = ArchiveDestination.cleanup("content://docs/4", ArchiveDestination.Ownership.NEWLY_CREATED, ops)
		assertTrue(outcome is ArchiveDestination.CleanupOutcome.Refused)
		assertFalse("must not read as a clean removal", outcome is ArchiveDestination.CleanupOutcome.Removed)
	}

	@Test
	fun `a throwing provider is reported as refusal with a reason`() {
		val ops = FakeOps(deleteThrows = UnsupportedOperationException("not supported by this provider"))
		val outcome = ArchiveDestination.cleanup("content://docs/5", ArchiveDestination.Ownership.NEWLY_CREATED, ops)
		assertTrue(outcome is ArchiveDestination.CleanupOutcome.Refused)
		val reason = (outcome as ArchiveDestination.CleanupOutcome.Refused).reason
		assertEquals("not supported by this provider", reason)
	}

	@Test
	fun `a throwing provider with no message still yields a usable reason`() {
		val ops = FakeOps(deleteThrows = RuntimeException(""))
		val outcome = ArchiveDestination.cleanup("content://docs/6", ArchiveDestination.Ownership.NEWLY_CREATED, ops)
		assertTrue(outcome is ArchiveDestination.CleanupOutcome.Refused)
		assertTrue((outcome as ArchiveDestination.CleanupOutcome.Refused).reason.isNotBlank())
	}

	// -- mid-write interruption & partial files ------------------------------

	@Test
	fun `a partial file left by an interrupted write is still removed`() {
		// Ownership was decided at PICK time (empty). The copy then started and
		// was interrupted mid-stream — the doc is now non-empty, but every byte
		// in it is ours, so cleanup must still delete it.
		val ops = FakeOps(deleteResult = true)
		val outcome = ArchiveDestination.cleanup("content://docs/11", ArchiveDestination.Ownership.NEWLY_CREATED, ops)
		assertEquals(ArchiveDestination.CleanupOutcome.Removed, outcome)
		assertEquals(listOf("content://docs/11"), ops.deleteCalls)
	}

	@Test
	fun `describeFailure for an interrupted partial write does not claim success`() {
		val text = ArchiveDestination.describeFailure(
			"The archive could not be read or written. Export interrupted.",
			ArchiveDestination.Ownership.NEWLY_CREATED,
			ArchiveDestination.CleanupOutcome.Removed,
		)
		assertTrue(text, text.contains("Export interrupted."))
		assertTrue(text, text.contains("was removed"))
		assertFalse("a failed export must never read as success", text.lowercase().contains("success"))
	}

	// -- user-facing wording ------------------------------------------------

	@Test
	fun `a removed leftover says it was removed`() {
		val text = ArchiveDestination.describeFailure(
			"The archive could not be read or written. Disk full.",
			ArchiveDestination.Ownership.NEWLY_CREATED,
			ArchiveDestination.CleanupOutcome.Removed,
		)
		assertTrue(text, text.contains("The archive could not be read or written. Disk full."))
		assertTrue(text, text.contains("was removed"))
		assertFalse("a failure must stay a failure", text.contains("succeeded"))
	}

	@Test
	fun `a refused delete tells the user the file is still there`() {
		val text = ArchiveDestination.describeFailure(
			"The archive could not be read or written. Connection lost.",
			ArchiveDestination.Ownership.NEWLY_CREATED,
			ArchiveDestination.CleanupOutcome.Refused("the storage provider declined the delete request"),
		)
		assertTrue(text, text.contains("Connection lost."))
		assertTrue(text, text.contains("still at the location you chose"))
		assertTrue(text, text.contains("the storage provider declined the delete request"))
		// The dangerous wording: never claim the file is gone when it is not.
		assertFalse("must not claim the file was removed", text.contains("was removed."))
	}

	@Test
	fun `a pre-existing file is described as left in place`() {
		val text = ArchiveDestination.describeFailure(
			"The archive could not be read or written. Timeout.",
			ArchiveDestination.Ownership.PRE_EXISTING,
			ArchiveDestination.CleanupOutcome.NotAttempted,
		)
		assertTrue(text, text.contains("already existed"))
		assertTrue(text, text.contains("restore it from your own copy"))
	}

	@Test
	fun `an unproven destination says nothing was deleted`() {
		val text = ArchiveDestination.describeFailure(
			"The archive could not be read or written.",
			ArchiveDestination.Ownership.UNKNOWN,
			ArchiveDestination.CleanupOutcome.NotAttempted,
		)
		assertTrue(text, text.contains("could not be confirmed"))
		assertTrue(text, text.contains("nothing there was deleted"))
	}

	@Test
	fun `cleanupSuffix is the tail of describeFailure`() {
		// The JS side appends this same suffix to a failure it handled itself,
		// so the two wordings must not drift apart.
		val ownership = ArchiveDestination.Ownership.NEWLY_CREATED
		val suffix = ArchiveDestination.cleanupSuffix(ownership, ArchiveDestination.CleanupOutcome.Removed)
		assertEquals(
			"The archive failed. $suffix",
			ArchiveDestination.describeFailure("The archive failed.", ownership, ArchiveDestination.CleanupOutcome.Removed),
		)
	}
}
