/**
 * GitHub #40 / PAV-104 — pure tests for the consumer-facing export failure
 * classification. The headline case is Stage 12's EXACT observed diagnostic
 * from the POCO M4 Pro 5G 4K run (STAGE12-ARTEMIS-POCO-RELEASE-QA.md, F-5):
 *
 *   `Codec exception ... c2.mtk.avc.encoder, width=3840, height=2160,
 *    bitrate=34836480`
 *
 * which must reach the customer as an accurate, actionable sentence and
 * NEVER as the raw codec string — while non-codec failures keep their
 * detail, and no resolution/fps is ever changed silently (the message only
 * SUGGESTS the alternative).
 */
import { describe, expect, test } from "bun:test";
import { codecFailureMessage, exportErrorMessage } from "../editor/export-errors";

/** Minimal inline console.warn capture — the repo has no console-spy
 *  helper, and these assertions only prove the raw diagnostic still
 *  reaches developer logs after the dialog copy is replaced. */
function captureWarnings<T>(body: () => T): { result: T; warnings: string } {
	const original = console.warn;
	const collected: unknown[][] = [];
	console.warn = (...args: unknown[]) => {
		collected.push(args);
	};
	try {
		return { result: body(), warnings: collected.flat().map(String).join("\n") };
	} finally {
		console.warn = original;
	}
}

/** The verbatim Stage 12 physical failure string (Progress notes / F-5). */
const STAGE12_4K_RAW =
	"Codec exception (errorCode=0x10010006) c2.mtk.avc.encoder, width=3840, height=2160, bitrate=34836480";

describe("exportErrorMessage — codec failures become actionable copy", () => {
	test("Stage 12's exact 4K diagnostic never reaches the customer, and suggests 1080p", () => {
		const { result: message, warnings } = captureWarnings(() =>
			exportErrorMessage({
				value: STAGE12_4K_RAW,
				resolution: { width: 3840, height: 2160 },
			}),
		);
		expect(message).toBe(
			"4K export isn't supported on this device with these settings. Try 1080p.",
		);
		// The raw diagnostic never reaches the dialog…
		expect(message).not.toContain("c2.mtk.avc.encoder");
		expect(message).not.toContain("bitrate=34836480");
		// …but is preserved verbatim for developer logs.
		expect(warnings).toContain("c2.mtk.avc.encoder");
	});

	test("a 1080p-class failure suggests 720p, not an already-tried resolution", () => {
		const { result: message } = captureWarnings(() =>
			exportErrorMessage({
				value: STAGE12_4K_RAW,
				resolution: { width: 1920, height: 1080 },
			}),
		);
		expect(message).toBe(
			"1920×1080 export isn't supported on this device with these settings. Try 720p.",
		);
	});

	test("a sub-1080p failure never recommends 1080p (which already failed)", () => {
		const { result: message } = captureWarnings(() =>
			exportErrorMessage({
				value: "MediaCodec encoder rejected 1280x720",
				resolution: { width: 1280, height: 720 },
			}),
		);
		expect(message).toBe(
			"1280×720 export isn't supported on this device with these settings. Try a different resolution or frame rate.",
		);
	});

	test("without caller context the size is parsed from the diagnostic itself", () => {
		const { result: fourK } = captureWarnings(() =>
			exportErrorMessage({ value: STAGE12_4K_RAW }),
		);
		expect(fourK).toBe(
			"4K export isn't supported on this device with these settings. Try 1080p.",
		);
		const { result: vga } = captureWarnings(() =>
			exportErrorMessage({ value: "encoder failed for 1280x720 stream" }),
		);
		expect(vga).toBe(
			"1280×720 export isn't supported on this device with these settings. Try a different resolution or frame rate.",
		);
	});

	test("codec failures with no known size still avoid the raw diagnostic", () => {
		const { result: message, warnings } = captureWarnings(() =>
			exportErrorMessage({ value: "video encoder not supported on this device" }),
		);
		expect(message).toBe(
			"Video encoding isn't supported on this device with these settings. Try 1080p.",
		);
		expect(message.toLowerCase()).not.toContain("encoder not supported");
		expect(warnings).toContain("video encoder not supported");
	});

	test("iOS-style AVFoundation codec errors are classified too", () => {
		const { result: message } = captureWarnings(() =>
			exportErrorMessage({
				value:
					"AVFoundationErrorDomain -11800: Cannot encode video with the selected settings",
				resolution: { width: 3840, height: 2160 },
			}),
		);
		expect(message).toBe(
			"4K export isn't supported on this device with these settings. Try 1080p.",
		);
	});
});

describe("exportErrorMessage — non-codec failures keep their detail", () => {
	test("Gallery publication failures pass through untouched", () => {
		expect(
			exportErrorMessage({
				value: "Video encoded but Save to Gallery failed: Permission denied",
			}),
		).toBe("Video encoded but Save to Gallery failed: Permission denied");
	});

	test("the sheet's own validation messages pass through untouched", () => {
		expect(
			exportErrorMessage({
				value: "Add at least one video or image clip before exporting a video.",
			}),
		).toBe("Add at least one video or image clip before exporting a video.");
	});

	test("Error instances use their message; empty values get the documented fallback", () => {
		expect(exportErrorMessage({ value: new Error("Transformer timed out") })).toBe(
			"Transformer timed out",
		);
		expect(exportErrorMessage({ value: "" })).toBe(
			"The native exporter failed without a diagnostic. Check Cutlyra logs for details.",
		);
		expect(exportErrorMessage({ value: undefined })).toBe(
			"The native exporter failed without a diagnostic. Check Cutlyra logs for details.",
		);
	});

	test("unrelated failures are not misclassified (weak codec terms alone don't match)", () => {
		const message = exportErrorMessage({
			value: "database error while loading the project",
		});
		expect(message).toBe("database error while loading the project");
	});
});

describe("codecFailureMessage — the message table itself", () => {
	test("4K boundary is height 2160 OR width 3840; null gets the 1080p default", () => {
		expect(codecFailureMessage({ resolution: { width: 3840, height: 2160 } })).toContain("4K");
		expect(codecFailureMessage({ resolution: { width: 4096, height: 2160 } })).toContain("4K");
		expect(codecFailureMessage({ resolution: { width: 7680, height: 4320 } })).toContain("4K");
		expect(codecFailureMessage({ resolution: null })).toContain("Try 1080p");
	});
});
