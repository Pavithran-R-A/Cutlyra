/**
 * Regression tests for the `PanelSheet` back registry (issue #13: Android
 * Back must dismiss the TOPMOST open sheet before any screen navigation).
 *
 * The registry is a deliberate module singleton (see sheet-registry.ts's
 * header), so every test cleans up its own registrations — an escaped entry
 * would leak into the next test exactly like a leaked listener would leak
 * into the app.
 */
import { describe, expect, mock, test } from "bun:test";
import {
	handleSystemBack,
	openSheetCount,
	registerSheet,
} from "../lib/sheet-registry";

/** Every test starts from a guaranteed-empty stack; a leak fails loudly. */
function expectEmpty() {
	expect(openSheetCount()).toBe(0);
}

describe("sheet-registry", () => {
	test("no open sheet: Back falls through to screen navigation", () => {
		expect(handleSystemBack()).toBe("none");
		expectEmpty();
	});

	test("one open sheet: Back invokes exactly its dismiss handler", () => {
		const dismiss = mock(() => {});
		const remove = registerSheet({ dismiss: () => dismiss });
		expect(handleSystemBack()).toBe("dismissed");
		expect(dismiss).toHaveBeenCalledTimes(1);
		remove();
		expectEmpty();
	});

	test("topmost-first: stacked sheets dismiss LIFO", () => {
		const bottom = mock(() => {});
		const top = mock(() => {});
		const removeBottom = registerSheet({ dismiss: () => bottom });
		const removeTop = registerSheet({ dismiss: () => top });

		// First press hits only the top sheet (e.g. a Transition sheet over
		// an editor sheet) — never both, never the bottom one first. The
		// dismissed entry is popped immediately (the sheet's unmount will
		// run its no-op disposer), leaving the bottom sheet topmost.
		expect(handleSystemBack()).toBe("dismissed");
		expect(top).toHaveBeenCalledTimes(1);
		expect(bottom).not.toHaveBeenCalled();
		expect(openSheetCount()).toBe(1);

		// Second press reaches the now-topmost bottom sheet.
		expect(handleSystemBack()).toBe("dismissed");
		expect(bottom).toHaveBeenCalledTimes(1);
		expect(top).toHaveBeenCalledTimes(1);

		removeTop();
		removeBottom();
		expectEmpty();
	});

	test("unregister removes only its own entry (StrictMode-style cycles)", () => {
		const dismissA = mock(() => {});
		const dismissB = mock(() => {});

		// Simulate React StrictMode's mount cycle for sheet A: effect,
		// cleanup, effect again — the stack must hold exactly ONE live A
		// entry, not a ghost from the first effect.
		const removeAFirstMount = registerSheet({ dismiss: () => dismissA });
		removeAFirstMount();
		const removeA = registerSheet({ dismiss: () => dismissA });
		expect(openSheetCount()).toBe(1);

		// Sheet B opens on top afterwards.
		const removeB = registerSheet({ dismiss: () => dismissB });
		expect(openSheetCount()).toBe(2);

		// The stale disposer from A's first mount must NOT remove the live
		// entry (identity-keyed removal, not "pop something").
		removeAFirstMount();
		expect(openSheetCount()).toBe(2);

		// Topmost-first still holds: B (opened last) answers first, then A.
		expect(handleSystemBack()).toBe("dismissed");
		expect(dismissB).toHaveBeenCalledTimes(1);
		expect(dismissA).not.toHaveBeenCalled();
		expect(handleSystemBack()).toBe("dismissed");
		expect(dismissA).toHaveBeenCalledTimes(1);
		expect(openSheetCount()).toBe(0);

		// Both live disposers run on unmount — already-popped entries make
		// them no-ops rather than double-removals.
		removeA();
		removeB();
		expectEmpty();
	});

	test("guarded sheet (active export): Back is swallowed, nothing dismisses", () => {
		const dismiss = mock(() => {});
		let exporting = true;
		const remove = registerSheet({
			dismiss: () => dismiss,
			blocksBack: () => exporting,
		});

		expect(handleSystemBack()).toBe("blocked");
		expect(dismiss).not.toHaveBeenCalled();

		// Once the guard lifts, Back behaves like a scrim tap again.
		exporting = false;
		expect(handleSystemBack()).toBe("dismissed");
		expect(dismiss).toHaveBeenCalledTimes(1);

		remove();
		expectEmpty();
	});

	test("sheet without a dismiss handler is blocked, not bypassed", () => {
		const remove = registerSheet({ dismiss: () => undefined });
		// Blocked (swallowed) — never "none", which would let Back fall
		// through to editor exit behind a modal the user cannot close.
		expect(handleSystemBack()).toBe("blocked");
		remove();
		expectEmpty();
	});
});
