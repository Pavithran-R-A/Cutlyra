/**
 * Issue #13 regression tests — Android system Back routing:
 * topmost sheet first, then screen navigation, then platform default exit.
 *
 * `decideBackPress` is the pure ordering contract; the install tests drive
 * the REAL listener wiring through an injected fake bridge (same
 * narrow-cast fixture style as `packages/native-bridge/src/__tests__/
 * capacitor-bridge.test.ts`), asserting the handler's boolean — which is
 * exactly what decides "swallowed" vs "let Capacitor exit the app".
 */
import { describe, expect, mock, test } from "bun:test";
import { handleSystemBack, openSheetCount, registerSheet } from "@cutlyra/mobile-ui";
import type { NativeBridge } from "@cutlyra/native-bridge";
import {
	decideBackPress,
	installSystemBackNavigation,
	type BackScreenName,
} from "../back-navigation";

/** Fake bridge that captures the registered `onBack` callback so tests can
 *  fire a system Back press the way the native plugin would. */
function fakeBridge() {
	let captured: (() => boolean) | null = null;
	const remove = mock(async () => undefined);
	const bridge = {
		onBackButton: mock(async ({ onBack }: { onBack: () => boolean }) => {
			captured = onBack;
			return { remove };
		}),
	} as unknown as NativeBridge;
	return {
		bridge,
		remove,
		/** Fires one Back press; returns the handler's result (true =
		 *  handled/swallowed, false = bridge performs default exit). */
		press(): boolean {
			if (!captured) throw new Error("no onBack registered");
			return captured();
		},
	};
}

describe("decideBackPress", () => {
	test("an open sheet consumes the press regardless of screen", () => {
		for (const sheet of ["dismissed", "blocked"] as const) {
			for (const screen of ["home", "editor", "privacy", "legal"] as const) {
				expect(decideBackPress({ sheet, screen })).toBe("stay");
			}
		}
	});

	test("no sheet: editor leaves to the project list", () => {
		expect(decideBackPress({ sheet: "none", screen: "editor" })).toBe(
			"leave-editor",
		);
	});

	test("no sheet: home exits via platform default", () => {
		expect(decideBackPress({ sheet: "none", screen: "home" })).toBe("exit");
	});

	test("no sheet: privacy and legal return home", () => {
		expect(decideBackPress({ sheet: "none", screen: "privacy" })).toBe(
			"go-home",
		);
		expect(decideBackPress({ sheet: "none", screen: "legal" })).toBe(
			"go-home",
		);
	});

	test("screen not published yet (boot/teardown): swallow, never exit", () => {
		expect(decideBackPress({ sheet: "none", screen: null })).toBe("stay");
	});
});

describe("installSystemBackNavigation", () => {
	test("registers exactly one listener and disposes it", async () => {
		const fake = fakeBridge();
		const registration = await installSystemBackNavigation({
			getScreen: () => "home",
			onLeaveEditor: () => {},
			onGoHome: () => {},
			bridge: fake.bridge,
		});
		expect(fake.bridge.onBackButton).toHaveBeenCalledTimes(1);
		await registration.remove();
		expect(fake.remove).toHaveBeenCalledTimes(1);
	});

	test("sheet dismissal wins over screen navigation on the same press", async () => {
		expect(openSheetCount()).toBe(0);
		const dismiss = mock(() => {});
		const removeSheet = registerSheet({ dismiss: () => dismiss });
		const onLeaveEditor = mock(() => {});
		const fake = fakeBridge();
		const registration = await installSystemBackNavigation({
			getScreen: () => "editor",
			onLeaveEditor,
			onGoHome: () => {},
			bridge: fake.bridge,
		});

		// Back with the Transition sheet open: sheet dismissed, editor
		// STAYS (the press must not also navigate), result handled.
		expect(fake.press()).toBe(true);
		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(onLeaveEditor).not.toHaveBeenCalled();

		removeSheet();
		expect(openSheetCount()).toBe(0);
		await registration.remove();
	});

	test("second press with no sheet open leaves the editor (save+home)", async () => {
		const onLeaveEditor = mock(() => {});
		const onGoHome = mock(() => {});
		const fake = fakeBridge();
		const registration = await installSystemBackNavigation({
			getScreen: () => "editor" as BackScreenName,
			onLeaveEditor,
			onGoHome,
			bridge: fake.bridge,
		});

		expect(fake.press()).toBe(true);
		expect(onLeaveEditor).toHaveBeenCalledTimes(1);
		expect(onGoHome).not.toHaveBeenCalled();

		await registration.remove();
	});

	test("home reports unhandled so the bridge performs the default exit", async () => {
		const onLeaveEditor = mock(() => {});
		const fake = fakeBridge();
		const registration = await installSystemBackNavigation({
			getScreen: () => "home",
			onLeaveEditor,
			onGoHome: () => {},
			bridge: fake.bridge,
		});

		expect(fake.press()).toBe(false);
		expect(onLeaveEditor).not.toHaveBeenCalled();

		await registration.remove();
	});

	test("guarded sheet (exporting) swallows Back even on the editor screen", async () => {
		const dismiss = mock(() => {});
		const removeSheet = registerSheet({
			dismiss: () => dismiss,
			blocksBack: () => true,
		});
		const onLeaveEditor = mock(() => {});
		const fake = fakeBridge();
		const registration = await installSystemBackNavigation({
			getScreen: () => "editor",
			onLeaveEditor,
			onGoHome: () => {},
			bridge: fake.bridge,
		});

		expect(fake.press()).toBe(true);
		expect(dismiss).not.toHaveBeenCalled();
		expect(onLeaveEditor).not.toHaveBeenCalled();

		removeSheet();
		expect(openSheetCount()).toBe(0);
		await registration.remove();
	});
});

// Kept honest: the pure-decision tests above assume "stay" for both
// non-"none" sheet results — handleSystemBack must actually produce them.
describe("registry integration", () => {
	test("handleSystemBack reports none/dismissed/blocked as designed", () => {
		expect(handleSystemBack()).toBe("none");

		const removeDismissable = registerSheet({ dismiss: () => () => {} });
		expect(handleSystemBack()).toBe("dismissed");
		removeDismissable();

		const removeGuarded = registerSheet({
			dismiss: () => () => {},
			blocksBack: () => true,
		});
		expect(handleSystemBack()).toBe("blocked");
		removeGuarded();

		expect(openSheetCount()).toBe(0);
	});
});
