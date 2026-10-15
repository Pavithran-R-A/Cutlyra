/**
 * Module-level registry of open `PanelSheet` modals (GitHub issue #13:
 * "Android Back must dismiss an open editing sheet before exiting editor").
 *
 * WHY A MODULE SINGLETON: the Android system Back press arrives through
 * `@cutlyra/native-bridge`'s single native `backButton` listener, which is
 * installed by the app shell OUTSIDE the React tree — so the open-sheet
 * state it needs must be reachable without drilling context from
 * `EditorShell` down through every sheet host. `PanelSheet` is the one
 * component every modal bottom sheet already renders (transition, audio,
 * text, captions, ratio, background, graph, export, ...), so registering
 * there covers the whole family at a single choke point — no per-sheet
 * wiring, and a future sheet gets Back support by construction.
 *
 * ORDERING: registrations form a LIFO stack (topmost = most recently
 * mounted), so Back dismisses sheets in proper topmost-first order. A
 * successful dismiss pops the entry IMMEDIATELY — the sheet's unmount
 * cleanup (the disposer `registerSheet` returns) is idempotent and
 * normally becomes a no-op. Popping eagerly means a second Back arriving
 * in the same frame as the first (before React commits the unmount) still
 * reaches the sheet underneath instead of re-firing a dismiss on a sheet
 * that is already closing.
 *
 * SEMANTICS deliberately MIRROR THE SCRIM: Back calls exactly the handler
 * the sheet passed as `onScrimClick` — the cancel/dismiss path — never a
 * confirm handler, so pressing Back can never commit a transition or any
 * other pending edit (issue #13 acceptance: "dismisses ... without
 * committing or discarding the underlying persisted transition").
 *
 * A sheet can also be *blocked* from Back (`blocksBack`, used by the export
 * sheet while an export is encoding): Back is then swallowed entirely —
 * neither dismissed nor navigated — so an active export is never
 * interrupted or hidden without an explicit user decision.
 */

export type SystemBackResult = "dismissed" | "blocked" | "none";

export interface SheetBackEntry {
	/** The sheet's current dismiss (scrim) handler; `undefined` when the
	 *  sheet cannot be dismissed by Back/scrim (non-dismissable modal). */
	dismiss: () => (() => void) | undefined;
	/** Dynamic guard — true swallows Back without dismissing (e.g. export
	 *  encoding in progress). Checked BEFORE `dismiss`. */
	blocksBack?: () => boolean;
}

const stack: SheetBackEntry[] = [];

/** Mount-time registration; the returned function unregisters (call from the
 *  effect cleanup). Re-registration on StrictMode double-invoke is expected
 *  and harmless: register/unregister pairs leave the stack as-is. */
export function registerSheet(entry: SheetBackEntry): () => void {
	stack.push(entry);
	return () => {
		const index = stack.lastIndexOf(entry);
		if (index !== -1) stack.splice(index, 1);
	};
}

/**
 * Dismiss the topmost open sheet, mirroring a scrim tap. Returns:
 * - `"dismissed"` — top sheet's dismiss handler ran;
 * - `"blocked"`   — a sheet is open but refused dismissal (guard active or
 *                   no dismiss handler); the caller must swallow the Back
 *                   press without navigating;
 * - `"none"`      — no sheet open; the caller should fall through to
 *                   screen-level navigation.
 */
export function handleSystemBack(): SystemBackResult {
	const top = stack[stack.length - 1];
	if (!top) return "none";
	if (top.blocksBack?.()) return "blocked";
	const dismiss = top.dismiss();
	if (!dismiss) return "blocked";
	// Dismissal pops the entry now; the eventual unmount calls the same
	// disposer, which is a no-op for an entry already gone.
	stack.pop();
	dismiss();
	return "dismissed";
}

/** Test/debug introspection — how many sheets are currently registered. */
export function openSheetCount(): number {
	return stack.length;
}
