/**
 * Stage 12 / GitHub #39 / Linear PAV-103 — the EXACT raw whisper tokens that
 * produced the "captions visible on only frames 77–79 of 270" defect.
 *
 * PROVENANCE: copied verbatim from the Android logcat capture taken during
 * the Stage 12 Artemis QA autotest (`qa-stage12-artemis/evidence/autotest/
 * run-165625.log.txt`) on the isolated emulator AND the POCO M4 Pro 5G,
 * against main `89b1de36984604a2256d49a75670bb2c0423ab37` (package
 * `app.cutlyra.editor.rc`). The log line is `NativeBridge.transcribe()`'s
 * raw token dump, pre-smoothing: `{"segments":[{"startMicros":0,
 * "endMicros":2580000, ...,"tokens":[...]}]}` — two separate transcribe
 * calls (job 1 = the main-track video's audio at timeline 0s, job 2 = the
 * audio-upload clip at timeline 8s), each returning ONE whisper segment.
 *
 * THE DEFECTIVE SIGNAL every non-empty token shares: `dtwStartMicros:
 * 2560000` — segmentEnd (2 580 000 µs) minus exactly one 20 ms DTW step, i.e.
 * whisper's DTW backtrace collapsed onto the segment's final frame for every
 * token (its documented "moment the model decided to output the token"
 * behavior on hallucinated/non-speech audio). `coarseStartMicros`/
 * `coarseEndMicros` (t0/t1) remain correctly spread across [0, 2 580 000].
 *
 * Untrusted, this value shrank each generated caption PAGE from its full
 * 2.58 s authored interval to an 80 ms window ([2.56 s, 2.64 s)), so:
 *  - page 1 (clip @ 0 s) rendered glyphs on encoded frames 77/78/79 only, and
 *  - page 2 (clip @ 8 s) landed at [10.56 s, 10.64 s] — entirely past the
 *    9.0195 s export — never appearing at all.
 * See `../caption-window-integrity.test.ts` for the regression that pins the
 * full authored intervals.
 */
import type { RawWordTiming } from "../../caption-smoothing";

export interface Stage12TranscriptSegment {
	startMicros: number;
	endMicros: number;
	text: string;
	tokens: RawWordTiming[];
}

/** Job 1 — main-track video clip at timeline 0 s: " (bell ringing)". */
export const STAGE12_SEGMENT_BELL_RINGING: Stage12TranscriptSegment = {
	startMicros: 0,
	endMicros: 2_580_000,
	text: " (bell ringing)",
	tokens: [
		{ text: "", coarseStartMicros: 0, coarseEndMicros: 0, dtwStartMicros: null, confidence: 1 },
		{
			text: " (",
			coarseStartMicros: 0,
			coarseEndMicros: 200_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.669143795967102,
		},
		{
			text: "bell",
			coarseStartMicros: 200_000,
			coarseEndMicros: 990_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.25650253891944885,
		},
		{
			text: " ringing",
			coarseStartMicros: 990_000,
			coarseEndMicros: 2_370_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.5463413596153259,
		},
		{
			text: ")",
			coarseStartMicros: 2_370_000,
			coarseEndMicros: 2_580_000,
			dtwStartMicros: 2_560_000,
			confidence: 1,
		},
		{
			text: "",
			coarseStartMicros: 2_580_000,
			coarseEndMicros: 2_580_000,
			dtwStartMicros: null,
			confidence: 0.9257806539535522,
		},
	],
};

/** Job 2 — audio-upload clip at timeline 8 s: " (phone ringing)". */
export const STAGE12_SEGMENT_PHONE_RINGING: Stage12TranscriptSegment = {
	startMicros: 0,
	endMicros: 2_580_000,
	text: " (phone ringing)",
	tokens: [
		{ text: "", coarseStartMicros: 0, coarseEndMicros: 0, dtwStartMicros: null, confidence: 1 },
		{
			text: " (",
			coarseStartMicros: 0,
			coarseEndMicros: 180_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.8789423704147339,
		},
		{
			text: "phone",
			coarseStartMicros: 180_000,
			coarseEndMicros: 1_100_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.8202760219573975,
		},
		{
			text: " ringing",
			coarseStartMicros: 1_100_000,
			coarseEndMicros: 2_390_000,
			dtwStartMicros: 2_560_000,
			confidence: 0.9618116617202759,
		},
		{
			text: ")",
			coarseStartMicros: 2_390_000,
			coarseEndMicros: 2_580_000,
			dtwStartMicros: 2_560_000,
			confidence: 1,
		},
		{
			text: "",
			coarseStartMicros: 2_580_000,
			coarseEndMicros: 2_580_000,
			dtwStartMicros: null,
			confidence: 0.7201026678085327,
		},
	],
};

/**
 * The Stage 12 autotest timeline facts every assertion below is measured
 * against (from the same logcat + the decoded MP4 `poco-rc-autotest-141550.mp4`
 * and its emulator twin): video clip starts at 0 s, the audio clip (whose
 * captions are job 2) starts at 8 s, the export is 9.0195 s / 270 frames /
 * 30 fps, and the pre-fix frame scan found glyphs at EXACTLY frames 77–79.
 */
export const STAGE12_TIMELINE = {
	videoClipStartSec: 0,
	audioClipStartSec: 8,
	exportDurationSec: 9.0195,
	exportFps: 30,
	exportFrameCount: 270,
	prefixGlyphFrames30fps: [77, 78, 79],
	authoredSegmentSec: 2.58,
} as const;