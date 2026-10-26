/**
 * GitHub #39 / Linear PAV-103 — RED→GREEN regression: a generated caption
 * PAGE must span its full AUTHORED transcript interval, because the export's
 * prerendered overlay path (`editor-core/export/overlay-frames.ts` →
 * `bridge.exportProject({overlayFrames})` → `PrerenderedOverlay.getBitmap`)
 * renders exactly the window this pipeline produces and nothing else.
 *
 * WHAT BROKE (Stage 12, main `89b1de3`, isolated emulator AND the POCO M4
 * Pro 5G): the exact logcat tokens in `fixtures/stage12-collapsed-dtw-raw.ts`
 * carry `dtwStartMicros: 2560000` on EVERY non-empty token. `smoothWordTimings`
 * used to accept any DTW start inside the *segment* envelope, so both pages'
 * words collapsed onto [2.56 s, 2.64 s]:
 *   - page 1 (clip @ 0 s) → window [2.56, 2.64] → glyphs on encoded frames
 *     77/78/79 of 270 only (the decoded-MP4 frame scan, reproduced on both
 *     devices), and
 *   - page 2 (clip @ 8 s) → window [10.56, 10.64], entirely past the
 *     9.0195 s export → never rendered at all.
 * Four prerendered segments ≠ four visible frames: the segments were
 * faithful; the windows they were given were 80 ms wide.
 *
 * RED on the unmodified baseline (each test's failure mode is spelled out
 * inline); GREEN once DTW starts are trusted only inside their own token's
 * coarse [t0, t1] envelope — the contract caption-smoothing's own module
 * header documents. The native half (windows → media3 → decoded MP4 pixels,
 * incl. cross-fade compression) is pinned separately by
 * `PrerenderedOverlayExportInstrumentedTest` on the emulator.
 */
import { describe, expect, test } from "bun:test";
import { smoothWordTimings, type SmoothingResult } from "../caption-smoothing";
import {
	STAGE12_SEGMENT_BELL_RINGING,
	STAGE12_SEGMENT_PHONE_RINGING,
	STAGE12_TIMELINE,
	type Stage12TranscriptSegment,
} from "./fixtures/stage12-collapsed-dtw-raw";
import {
	buildCaptionElementsFromTranscript,
	getVisibleCaptionWords,
} from "@cutlyra/editor-core/captions";
import {
	buildNominalToOutputRemap,
	computeMainTrackPlacements,
	remapNominalTick,
} from "@cutlyra/editor-core/timeline";
import {
	TICKS_PER_SECOND,
	mediaTime,
	mediaTimeToSeconds,
	type MediaTime,
} from "@cutlyra/editor-core/wasm";

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test-only
 * MediaTime handling: the same branded-integer casts every fixture in this
 * repo uses (transitions.test.ts's `t()`, edl.test.ts). */
const t = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;

interface PageWindow {
	elementCount: number;
	startSec: number;
	endSec: number;
	words: ReturnType<typeof buildCaptionElementsFromTranscript>[number]["words"];
	smoothing: SmoothingResult;
}

/** The exact production sequence: raw native tokens → smoothWordTimings (the
 *  pass `capacitor-bridge.transcribe()` runs) →
 *  buildCaptionElementsFromTranscript (the pass `generateCaptions` runs,
 *  which chunks segments into pages and offsets them onto the timeline). */
function buildPage({
	segment,
	timelineStartSec,
}: {
	segment: Stage12TranscriptSegment;
	timelineStartSec: number;
}): PageWindow {
	const smoothing = smoothWordTimings({
		tokens: segment.tokens,
		segmentStartMicros: segment.startMicros,
		segmentEndMicros: segment.endMicros,
	});
	const elements = buildCaptionElementsFromTranscript({
		segments: [
			{
				startMicros: segment.startMicros,
				endMicros: segment.endMicros,
				text: segment.text,
				words: smoothing.words.map((w) => ({
					text: w.text,
					startMicros: w.startMicros,
					endMicros: w.endMicros,
				})),
			},
		],
		timelineStartTime: mediaTime({ ticks: Math.round(timelineStartSec * TICKS_PER_SECOND) }),
		stylePresetId: "simple",
	});
	const [element] = elements;
	return {
		elementCount: elements.length,
		startSec: mediaTimeToSeconds({ time: element.startTime }),
		endSec:
			mediaTimeToSeconds({ time: element.startTime }) +
			mediaTimeToSeconds({ time: element.duration }),
		words: element.words,
		smoothing,
	};
}

/** Encoded frames whose sample time falls in [startSec, endSec), capped at
 *  endCapSec — the same first-sample-at-0 grid the exporter renders at. */
function framesInWindow({
	startSec,
	endSec,
	fps,
	endCapSec,
}: {
	startSec: number;
	endSec: number;
	fps: number;
	endCapSec?: number;
}): number[] {
	const out: number[] = [];
	const limit = endCapSec === undefined ? endSec : Math.min(endSec, endCapSec);
	for (let frame = 0; frame < 100_000; frame++) {
		const timeSec = frame / fps;
		if (timeSec >= limit) break;
		if (timeSec >= startSec) out.push(frame);
	}
	return out;
}

const page1 = buildPage({
	segment: STAGE12_SEGMENT_BELL_RINGING,
	timelineStartSec: STAGE12_TIMELINE.videoClipStartSec,
});
const page2 = buildPage({
	segment: STAGE12_SEGMENT_PHONE_RINGING,
	timelineStartSec: STAGE12_TIMELINE.audioClipStartSec,
});

describe("GitHub #39: caption pages span their full authored interval", () => {
	test("page 1 (video clip @ 0s) starts at 0 and runs to the transcript's 2.58s end", () => {
		// One PAGE per short segment here (2 words < CHUNK_MAX_WORDS).
		expect(page1.elementCount).toBe(1);
		// RED on baseline: the collapsed DTW put this window at 2.56s, so
		// glyphs first appeared at frame 77 instead of frame 0.
		expect(page1.startSec).toBeLessThanOrEqual(0.001);
		// Authored interval end = segment endMicros 2 580 000 µs.
		expect(page1.endSec).toBeCloseTo(STAGE12_TIMELINE.authoredSegmentSec, 3);
		expect(page1.endSec - page1.startSec).toBeCloseTo(
			STAGE12_TIMELINE.authoredSegmentSec,
			3,
		);
	});

	test("page 2 (audio clip @ 8s) starts under its own clip, inside the 9.0195s export", () => {
		expect(page2.elementCount).toBe(1);
		// RED on baseline: window started at 10.56s — past the export's end,
		// which is why "(phone ringing)" never appeared in ANY frame.
		expect(page2.startSec).toBeCloseTo(STAGE12_TIMELINE.audioClipStartSec, 3);
		expect(page2.startSec).toBeLessThan(STAGE12_TIMELINE.exportDurationSec);
		expect(page2.endSec).toBeCloseTo(
			STAGE12_TIMELINE.audioClipStartSec + STAGE12_TIMELINE.authoredSegmentSec,
			3,
		);
	});

	test("encoded-frame coverage: full spans at 24/30/60 fps, matching the Stage 12 frame scan inverted", () => {
		// 30 fps, page 1: RED on baseline this was [77, 78, 79]; the fix's
		// first/last frames are derived from the authored interval
		// (0 ≤ t < 2.58 → frames 0..77 at 30 fps, 0..61 at 24, 0..154 at 60).
		const p1at30 = framesInWindow({ startSec: page1.startSec, endSec: page1.endSec, fps: 30 });
		expect(p1at30[0]).toBe(0);
		expect(p1at30.at(-1)).toBe(77);
		expect(p1at30).toHaveLength(78);

		const p1at24 = framesInWindow({ startSec: page1.startSec, endSec: page1.endSec, fps: 24 });
		expect(p1at24[0]).toBe(0);
		expect(p1at24.at(-1)).toBe(61);

		const p1at60 = framesInWindow({ startSec: page1.startSec, endSec: page1.endSec, fps: 60 });
		expect(p1at60[0]).toBe(0);
		expect(p1at60.at(-1)).toBe(154);

		// Page 2 enters at 8.0s (frame 240) and holds through the video
		// track's exclusive end (frameCount/fps = 9.0s; the container reports
		// 9.0195s because the muxed audio tail sits just past the last video
		// frame's pts).
		const p2at30 = framesInWindow({
			startSec: page2.startSec,
			endSec: page2.endSec,
			fps: 30,
			endCapSec: STAGE12_TIMELINE.exportFrameCount / 30,
		});
		expect(p2at30[0]).toBe(240);
		expect(p2at30.at(-1)).toBe(269);
		expect(p2at30).toHaveLength(30);

		// No captions anywhere between the two pages (absence outside the
		// authored windows, at the output's own frame grid).
		const anyCaption = new Set([...p1at30, ...p2at30]);
		for (let frame = 78; frame < 240; frame++) expect(anyCaption.has(frame)).toBe(false);

		// The exact inverse of the Stage 12 symptom: glyphs are NOT confined
		// to the three-frame island the decoded scan measured.
		expect(p1at30).not.toEqual(STAGE12_TIMELINE.prefixGlyphFrames30fps);
	});

	test("every word of each page is on screen for the page's whole window (resolve-level guard)", () => {
		// getVisibleCaptionWords is what resolveCaptionNode feeds to
		// measureVisibleCaptionLine: non-empty ⟺ glyphs draw. Word spans stay
		// inside the element window, so first/middle/last samples of the
		// window all render the full line.
		for (const page of [page1, page2]) {
			const visible = getVisibleCaptionWords({
				element: { ...pageElement(page), words: page.words },
			});
			expect(visible).toHaveLength(page.words.length);
			for (const word of page.words) {
				expect(word.startTime).toBeGreaterThanOrEqual(0);
				expect(word.endTime).toBeLessThanOrEqual(
					t(page.endSec - page.startSec),
				);
				expect(word.endTime).toBeGreaterThan(word.startTime);
			}
		}
	});

	test("degenerate DTW bursts are rejected per token (the trust contract)", () => {
		// 3 of the 4 non-empty tokens sit >1.5s outside their own coarse
		// [t0, t1] envelope (")" alone is inside its own). RED on baseline:
		// this counter does not exist and nothing was rejected.
		expect(page1.smoothing.stats.dtwRejectedOutsideCoarseEnvelope).toBe(3);
		expect(page2.smoothing.stats.dtwRejectedOutsideCoarseEnvelope).toBe(3);
		// …while the segment-envelope rule is untouched.
		expect(page1.smoothing.stats.dtwRejectedOutOfSegment).toBe(0);
	});
});

describe("GitHub #39: caption windows survive cross-fade timeline compression", () => {
	// Same numbers as Stage 12 but WITH a 0.5s cross-fade at 8.0s: the
	// preview compresses the main track and remaps overlay starts
	// start-only (duration kept) — the same step function
	// NativeBridgePlugin applies via MainTrackPlacements.remapNominalTick.
	const clipA = { id: "clip-a", startTime: t(0), duration: t(8) };
	const clipB = { id: "clip-b", startTime: t(8), duration: t(4) };

	test("a page before the cross-fade is unshifted; a page after it shifts by the overlap, keeping its full duration", () => {
		const { windows } = computeMainTrackPlacements({
			elements: [clipA, clipB],
			transitions: [
				{ id: "tr-1", afterElementId: "clip-a", kind: "fade", duration: t(0.5) },
			],
		});
		const breakpoints = buildNominalToOutputRemap({
			sortedElements: [clipA, clipB],
			windows,
		});

		const remapPage = (page: PageWindow) => {
			const outStart = remapNominalTick({
				nominalTick: mediaTime({ ticks: Math.round(page.startSec * TICKS_PER_SECOND) }),
				breakpoints,
			});
			const startSec = mediaTimeToSeconds({ time: outStart });
			// Native keeps the duration (endUs = outStart + (end - start)).
			return { startSec, endSec: startSec + (page.endSec - page.startSec) };
		};

		// Page 1 sits before the transition: unchanged, full span.
		const shifted1 = remapPage(page1);
		expect(shifted1.startSec).toBeCloseTo(0, 3);
		expect(shifted1.endSec - shifted1.startSec).toBeCloseTo(
			STAGE12_TIMELINE.authoredSegmentSec,
			3,
		);

		// Page 2 starts exactly at the incoming clip: pulled 0.5s earlier by
		// the overlap — never stretched, shrunk, or dropped.
		const shifted2 = remapPage(page2);
		expect(shifted2.startSec).toBeCloseTo(7.5, 3);
		expect(shifted2.endSec - shifted2.startSec).toBeCloseTo(
			STAGE12_TIMELINE.authoredSegmentSec,
			3,
		);
		// Still inside any output long enough to hold it.
		expect(shifted2.startSec).toBeLessThan(9.0195);
	});
});

/** Minimal CaptionElement shell for getVisibleCaptionWords — the function
 *  reads only trimStart/duration/words (layout.ts). */
function pageElement(page: PageWindow): Parameters<typeof getVisibleCaptionWords>[0]["element"] {
	return {
		trimStart: mediaTime({ ticks: 0 }),
		duration: mediaTime({
			ticks: Math.round((page.endSec - page.startSec) * TICKS_PER_SECOND),
		}),
		words: page.words,
	} as Parameters<typeof getVisibleCaptionWords>[0]["element"];
}