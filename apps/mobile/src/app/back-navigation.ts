/**
 * Android system Back routing (GitHub issue #13 — "Android Back must
 * dismiss an open editing sheet before exiting editor").
 *
 * LAYERING: this is the app-shell layer, so it may reach native — but ONLY
 * through `@cutlyra/native-bridge` (the bridge-import gate forbids
 * `@capacitor/*` imports anywhere outside that package; the actual
 * `App.addListener('backButton')` + `App.exitApp()` calls live in
 * `capacitor-bridge.ts`). Exactly ONE native listener exists, installed
 * once by the root component's mount effect and removed on unmount —
 * Capacitor's App plugin documents that a `backButton` listener DISABLES
 * the default back behaviour, so this router must account for every state
 * (it does: unhandled exits via the bridge's documented default).
 *
 * ORDERING CONTRACT (issue #13 acceptance criteria):
 *   1. Topmost open `PanelSheet` wins — dismissed exactly like a scrim tap
 *      (cancel semantics; a commit/confirm control is never invoked), or
 *      swallowed outright when the sheet is guarded (active export).
 *   2. Otherwise the editor leaves to the project list with the same
 *      fire-and-forget save the top bar's X performs.
 *   3. Privacy/legal screens return home.
 *   4. Home performs the platform default exit (normal Android behaviour).
 */
import { handleSystemBack, type SystemBackResult } from "@cutlyra/mobile-ui";
import { getNativeBridge, type NativeBridge } from "@cutlyra/native-bridge";

export type BackScreenName = "home" | "editor" | "privacy" | "legal" | "backup";

export type BackPressAction =
	| "stay"
	| "leave-editor"
	| "go-home"
	| "exit";

/**
 * Pure decision for one Back press — extracted for unit tests
 * (`__tests__/back-navigation.test.ts`). `screen === null` means "the React
 * tree hasn't published a screen yet" (boot/teardown race): swallow the
 * press rather than exiting an app that is still coming up.
 */
export function decideBackPress({
	sheet,
	screen,
}: {
	sheet: SystemBackResult;
	screen: BackScreenName | null;
}): BackPressAction {
	// An open sheet (dismissed or guarded) fully consumes the press —
	// screen navigation must not happen in the same event.
	if (sheet !== "none") return "stay";
	if (screen === null) return "stay";
	if (screen === "editor") return "leave-editor";
	if (screen === "home") return "exit";
	// privacy / legal
	return "go-home";
}

/**
 * Registers the single native Back listener. Resolves with a disposer the
 * caller MUST invoke on unmount (StrictMode's effect cycle included) —
 * listeners are cheap but stacking them would re-fire dismissed screens.
 */
export async function installSystemBackNavigation({
	getScreen,
	onLeaveEditor,
	onGoHome,
	bridge,
}: {
	getScreen: () => BackScreenName | null;
	/** editor -> project list: SAME semantics as `EditorShell`'s `onBack`
	 *  (fire-and-forget save, then show the home screen). */
	onLeaveEditor: () => void;
	/** privacy/legal -> home. */
	onGoHome: () => void;
	/** Test seam: the resolved `NativeBridge` to register on. Omitted in
	 *  production — `getNativeBridge()` selects it (web fallback on web,
	 *  Capacitor on device). */
	bridge?: NativeBridge;
}): Promise<{ remove: () => Promise<void> }> {
	const resolved = bridge ?? (await getNativeBridge());
	return resolved.onBackButton({
		onBack: () => {
			const action = decideBackPress({
				sheet: handleSystemBack(),
				screen: getScreen(),
			});
			if (action === "exit") {
				// Report unhandled: the bridge performs the documented
				// default (`App.exitApp()`), i.e. normal Android
				// home-screen Back behaviour.
				return false;
			}
			if (action === "leave-editor") onLeaveEditor();
			else if (action === "go-home") onGoHome();
			return true;
		},
	});
}
