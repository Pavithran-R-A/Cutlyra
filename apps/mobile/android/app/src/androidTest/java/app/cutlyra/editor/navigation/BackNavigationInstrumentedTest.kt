package app.cutlyra.editor.navigation

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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val PACKAGE = "app.cutlyra.editor"

/**
 * Issue #13 end-to-end regression — Android system Back ordering:
 *
 *   1. Back with an open modal sheet (PanelSheet) dismisses ONLY the sheet;
 *      the app must stay in the foreground. (Pre-fix this backgrounded the
 *      app or dropped the editor while the sheet was still mounted.)
 *   2. The next Back leaves the editor for the project list (same
 *      fire-and-forget save + navigate as the top bar's X).
 *   3. Back on the project list follows normal Android behaviour and exits
 *      the app (Capacitor App plugin's documented default, performed by the
 *      bridge because the root handler reports the press unhandled).
 *
 * Driven with UiAutomator because the app's screens are WebView content:
 * Espresso cannot see or click nodes inside the WebView's accessibility
 * subtree, while UiAutomator reads exactly the node tree the system
 * exposes (the same tree `adb shell uiautomator dump` reported during the
 * POCO acceptance sessions).
 *
 * The Export sheet is used as the modal under test because it is reachable
 * from a brand-new EMPTY project (no media import needed), keeping this
 * test deterministic on a fresh CI emulator.
 */
@RunWith(AndroidJUnit4::class)
class BackNavigationInstrumentedTest {
    private lateinit var device: UiDevice

    @Before
    fun launchApp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.pressHome()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val intent = context.packageManager.getLaunchIntentForPackage(PACKAGE)
        assertNotNull("launcher intent for $PACKAGE", intent)
        intent!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        context.startActivity(intent)
        device.waitForIdle()

        // Fresh emulator: FirstRunActivity (the launcher activity) shows its
        // one-time primer before MainActivity. A rerun on the same data set
        // skips it — the wait just times out and we continue.
        val primer = device.wait(Until.findObject(By.res(PACKAGE, "getStartedButton")), 15_000)
        primer?.click()
    }

    @Test
    fun systemBack_dismissesSheet_thenLeavesEditor_thenExitsApp() {
        // Boot to the project list (WebView; wasm + fonts load on first run).
        val newProject = find(By.text("+ New project"), 60_000)

        // Open a project -> editor shell. The top bar's Export button mounts
        // with the shell chrome, so an empty project is enough.
        newProject.click()
        val exportButton = find(By.text("Export"), 60_000)

        // Open a modal PanelSheet (the Export sheet: Resolution / Frame rate /
        // Quality controls).
        exportButton.click()
        find(By.text("Resolution"), 30_000)

        // (1) Back dismisses ONLY the sheet — this is the issue's core
        // assertion: pre-fix, Back backgrounded the app or closed the editor
        // while the sheet stayed open.
        device.pressBack()
        assertTrue(
            "Back must dismiss the open sheet",
            device.wait(Until.gone(By.text("Resolution")), 10_000),
        )
        assertEquals(
            "Back with a sheet open must not background or leave the app",
            PACKAGE,
            device.currentPackageName,
        )
        assertNotNull(
            "the editor must still be mounted after the sheet closes",
            device.wait(Until.findObject(By.text("Export")), 5_000),
        )

        // (2) Next Back leaves the editor for the project list.
        device.pressBack()
        assertNotNull(
            "the next Back must return to the project list",
            device.wait(Until.findObject(By.text("+ New project")), 15_000),
        )
        assertEquals(PACKAGE, device.currentPackageName)

        // (3) Back on the project list exits the app (normal Android
        // behaviour — no sheet, no editor, nothing left to navigate).
        device.pressBack()
        assertTrue(
            "Back on the project list must exit the app",
            device.wait(Until.gone(By.pkg(PACKAGE).depth(0)), 15_000),
        )
    }

    private fun find(selector: BySelector, timeoutMs: Long): UiObject2 =
        device.wait(Until.findObject(selector), timeoutMs)
            ?: throw AssertionError("timed out after ${timeoutMs}ms waiting for $selector")
}
