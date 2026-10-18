/**
 * Regression tests for the export frame-rate contract (GitHub #21 /
 * Linear PAV-71): "FPS selection is ignored".
 *
 * The native half of the fix is `EdlToComposition` declaring
 * `setFrameRate` for every visual item (see ExportFrameRateInstrumentedTest
 * for the actual MP4-timestamp proof). These tests lock the SHEET half:
 *
 *   1. a reopened sheet starts on the project's own fps — the untouched-sheet
 *      path where a 60-fps project used to export at a hardcoded 30;
 *   2. the capability note appears exactly when media3's asymmetric contract
 *      (cap yes, duplicate no) makes the selection unachievable for some
 *      clip, and states the explicit fallback instead of silently shipping a
 *      30-fps file.
 */
import { describe, expect, test } from "bun:test";
import {
	describeFrameRateCapability,
	FPS_OPTIONS,
	nearestFpsOptionId,
} from "../components/panels/export-frame-rate";

describe("nearestFpsOptionId", () => {
	test("exact option rates round-trip", () => {
		expect(nearestFpsOptionId({ fps: { numerator: 24, denominator: 1 } })).toBe("24");
		expect(nearestFpsOptionId({ fps: { numerator: 25, denominator: 1 } })).toBe("25");
		expect(nearestFpsOptionId({ fps: { numerator: 30, denominator: 1 } })).toBe("30");
		expect(nearestFpsOptionId({ fps: { numerator: 60, denominator: 1 } })).toBe("60");
	});

	test("NTSC rates resolve to their nearest whole option", () => {
		expect(nearestFpsOptionId({ fps: { numerator: 24_000, denominator: 1_001 } })).toBe("24");
		expect(nearestFpsOptionId({ fps: { numerator: 30_000, denominator: 1_001 } })).toBe("30");
		expect(nearestFpsOptionId({ fps: { numerator: 60_000, denominator: 1_001 } })).toBe("60");
	});

	test("an unusual project rate still lands on the closest offered option", () => {
		expect(nearestFpsOptionId({ fps: { numerator: 48, denominator: 1 } })).toBe("60");
		expect(nearestFpsOptionId({ fps: { numerator: 12, denominator: 1 } })).toBe("24");
	});
});

describe("describeFrameRateCapability", () => {
	const fps60 = { numerator: 60, denominator: 1 };
	const fps24 = { numerator: 24, denominator: 1 };

	test("no video clips (stills/text only) is always fully achievable", () => {
		expect(
			describeFrameRateCapability({ requested: fps60, label: "60", sources: [] }),
		).toBeNull();
	});

	test("footage at or above the selection is fully achievable (cap covers it)", () => {
		expect(
			describeFrameRateCapability({
				requested: fps24,
				label: "24",
				sources: [{ fps: 30 }, { fps: 60 }],
			}),
		).toBeNull();
	});

	test("footage below the selection produces the honest fallback note", () => {
		const note = describeFrameRateCapability({
			requested: fps60,
			label: "60",
			sources: [{ fps: 30 }],
		});
		expect(note).toContain("60 FPS is a maximum");
		expect(note).toContain("1 clip(s)");
		expect(note).toContain("slowest 30 FPS");
		expect(note).toContain("does not duplicate frames");
	});

	test("double-speed 30 fps footage counts as effective 60 and needs no note at 60", () => {
		expect(
			describeFrameRateCapability({
				requested: fps60,
				label: "60",
				sources: [{ fps: 30, retimeRate: 2 }],
			}),
		).toBeNull();
	});

	test("half-speed 60 fps footage DOES need the note at 60 (effective 30)", () => {
		const note = describeFrameRateCapability({
			requested: fps60,
			label: "60",
			sources: [{ fps: 60, retimeRate: 0.5 }],
		});
		expect(note).toContain("slowest 30 FPS");
	});

	test("unknown-source fps is skipped, never guessed into a claim", () => {
		expect(
			describeFrameRateCapability({
				requested: fps60,
				label: "60",
				sources: [{}, { fps: undefined }, { fps: Number.NaN }],
			}),
		).toBeNull();
	});

	test("the note counts every slow clip and reports the slowest rate", () => {
		const note = describeFrameRateCapability({
			requested: fps60,
			label: "60",
			sources: [{ fps: 30 }, { fps: 24 }, { fps: 60 }, { fps: 120 }],
		});
		expect(note).toContain("2 clip(s)");
		expect(note).toContain("slowest 24 FPS");
	});

	test("NTSC source rates format without noisy decimals", () => {
		const note = describeFrameRateCapability({
			requested: fps60,
			label: "60",
			sources: [{ fps: 29.97 }],
		});
		expect(note).toContain("slowest 29.97 FPS");
	});

	test("the offered options are exactly 24/25/30/60 (sheet contract)", () => {
		expect(FPS_OPTIONS.map((option) => option.id)).toEqual(["24", "25", "30", "60"]);
	});
});
