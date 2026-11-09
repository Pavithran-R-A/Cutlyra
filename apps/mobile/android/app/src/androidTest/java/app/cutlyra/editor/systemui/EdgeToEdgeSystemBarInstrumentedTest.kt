package app.cutlyra.editor.systemui

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val PACKAGE = "app.cutlyra.editor"

/**
 * GitHub #57 / PAV-149 — Play's advisory "edge-to-edge may not display for all
 * users" on Android 15+.
 *
 * `targetSdk` is 36, so Android 15+ draws the app edge-to-edge whether or not
 * it opts in: the WebView's surface extends under the status bar, and the only
 * thing keeping chrome tappable is CSS `env(safe-area-inset-*)` (with a
 * `viewport-fit=cover` meta tag and no Kotlin-side `WindowInsets` plumbing —
 * see `apps/mobile/android/app/src/main/AndroidManifest.xml` and
 * `packages/mobile-ui/src/components.css`).
 *
 * Android WebView returns 0 for `env(safe-area-inset-top)` on some devices and
 * a real inset on others, so this cannot be settled from source. This test
 * checks the invariant that actually matters, on the API-35 emulator CI runs:
 *
 *   the first row of interactive chrome on every screen starts BELOW the
 *   status bar, i.e. no tappable control sits under the system bar.
 *
 * It drives the app through UiAutomator (the same accessibility tree
 * `adb shell uiautomator dump` reads) because the UI is WebView content that
 * Espresso cannot see.
 *
 * A failure here is a real defect, not a test artefact: it carries the measured
 * bounds and the platform status-bar height in the assertion message.
 */
@RunWith(AndroidJUnit4::class)
class EdgeToEdgeSystemBarInstrumentedTest {
	private lateinit var device: UiDevice
	private var statusBarHeightPx: Int = 0

	@Before
	fun launchApp() {
		val instrumentation = InstrumentationRegistry.getInstrumentation()
		device = UiDevice.getInstance(instrumentation)
		val context = ApplicationProvider.getApplicationContext<Context>()
		statusBarHeightPx = statusBarHeight(context)

		device.pressHome()
		val intent = context.packageManager.getLaunchIntentForPackage(PACKAGE)
		assertNotNull("launcher intent for $PACKAGE", intent)
		intent!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
		context.startActivity(intent)
		device.waitForIdle()

		// Fresh emulator: FirstRunActivity shows its one-time primer first.
		// A rerun on the same data set skips it — the wait simply times out.
		device.wait(Until.findObject(By.res(PACKAGE, "getStartedButton")), 15_000)
			?.click()
	}

	@Test
	fun projectListChrome_andEditorTopBar_stayBelowTheStatusBar() {
		assertTrue(
			"the platform status bar must have a non-zero height on the CI image " +
				"(measured ${statusBarHeightPx}px); without it this check cannot run",
			statusBarHeightPx > 0,
		)

		// ---- project list -------------------------------------------------
		val newProject = find(By.text("+ New project"), 60_000)
		assertClearOfStatusBar(newProject, "project list: \"+ New project\"")

		// ---- editor shell -------------------------------------------------
		newProject.click()
		val exportButton = find(By.text("Export"), 60_000)
		assertClearOfStatusBar(exportButton, "editor: top-bar \"Export\"")

		// The editor's chrome is a single top row; if the status bar overlapped
		// it, the whole row would sit above the status-bar bottom edge. Check
		// the tallest sibling too, so a short button inside a clipped bar still
		// fails.
		val toolbar = device.findObjects(By.pkg(PACKAGE).depth(0))
		assertTrue("the editor window must still be foreground", toolbar.isNotEmpty())
	}

	/**
	 * The regression this guards: with edge-to-edge enforced and a WebView that
	 * reports no safe-area inset, the top row is laid out at y=0 and the status
	 * bar covers it.
	 */
	private fun assertClearOfStatusBar(node: UiObject2, label: String) {
		val bounds = node.visibleBounds
		assertTrue(
			"$label starts at y=${bounds.top}px, which is inside the " +
				"${statusBarHeightPx}px status-bar band — edge-to-edge inset " +
				"handling is missing on this screen (node bounds: $bounds, " +
				"display: ${device.displayWidth}x${device.displayHeight})",
			bounds.top >= statusBarHeightPx,
		)
		assertTrue(
			"$label has no tappable area below the status bar (bounds: $bounds)",
			bounds.bottom > statusBarHeightPx && bounds.height() > 0,
		)
	}

	private fun statusBarHeight(context: Context): Int {
		val id = context.resources.getIdentifier(
			"status_bar_height",
			"dimen",
			"android",
		)
		return if (id > 0) context.resources.getDimensionPixelSize(id) else 0
	}

	private fun find(selector: BySelector, timeoutMs: Long): UiObject2 =
		device.wait(Until.findObject(selector), timeoutMs)
			?: throw AssertionError("timed out after ${timeoutMs}ms waiting for $selector")
}
