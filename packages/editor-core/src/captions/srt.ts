import type { CaptionElement } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm/media-time";

/** Convert a tick count to an SRT timestamp `HH:MM:SS,mmm`. */
function formatSrtTime(ticks: number): string {
	const totalMs = Math.max(0, Math.round((ticks / TICKS_PER_SECOND) * 1000));
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const seconds = Math.floor((totalMs % 60_000) / 1000);
	const millis = totalMs % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/** A caption element's on-screen text (all words). */
function captionText(element: CaptionElement): string {
	return element.words.map((w) => w.text).join(" ").trim();
}

/**
 * Serialise the given caption elements into an SRT document. Cues are
 * ordered by their timeline start time. Elements with no text are skipped.
 */
export function buildSrtFromCaptions(captions: readonly CaptionElement[]): string {
	const cues = captions
		.filter((c) => captionText(c).length > 0)
		.map((c) => ({
			start: c.startTime,
			end: c.startTime + c.duration,
			text: captionText(c),
		}))
		.sort((a, b) => a.start - b.start);

	let index = 1;
	const blocks: string[] = [];
	for (const cue of cues) {
		blocks.push(`${index}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`);
		index += 1;
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

/** Convert a tick count to a WebVTT timestamp `HH:MM:SS.mmm`. */
function formatVttTime(ticks: number): string {
	const totalMs = Math.max(0, Math.round((ticks / TICKS_PER_SECOND) * 1000));
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const seconds = Math.floor((totalMs % 60_000) / 1000);
	const millis = totalMs % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * Serialise the given caption elements into a WebVTT document. Cues are
 * ordered by their timeline start time. Elements with no text are skipped.
 * A `WEBVTT` header is always emitted so the result is a valid VTT file.
 */
export function buildVttFromCaptions(captions: readonly CaptionElement[]): string {
	const cues = captions
		.filter((c) => captionText(c).length > 0)
		.map((c) => ({
			start: c.startTime,
			end: c.startTime + c.duration,
			text: captionText(c),
		}))
		.sort((a, b) => a.start - b.start);

	const lines: string[] = ["WEBVTT", ""];
	for (const cue of cues) {
		lines.push(`${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}`);
		lines.push(cue.text);
		lines.push("");
	}
	return `${lines.join("\n")}`.replace(/\n+$/, "\n");
}
