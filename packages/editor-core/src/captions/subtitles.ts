/**
 * SRT / WebVTT import — the missing counterpart to `buildSrtFromCaptions`
 * (`./srt.ts`). `apps/web`'s dev harness has had a subtitle parser since
 * before this module existed, but it lives in the web app (and imports
 * `@/text/layout`, i.e. DOM canvas measurement), so the phone could only
 * export captions, never import them. This module is the same feature
 * implemented where both shells can reach it: plain data in, real
 * `CreateCaptionElement[]` out.
 *
 * Two responsibilities, deliberately separate:
 *
 *   1. `parseSubtitleText` — text -> `SubtitleCue[]` (integer milliseconds).
 *      Pure, no DOM, no editor, no wasm time helpers. Handles both SRT
 *      (`00:00:01,000`) and WebVTT (`00:00:01.000`, plus VTT's short
 *      `MM:SS.mmm` form), cue identifiers, VTT cue settings after the end
 *      timestamp, VTT `NOTE`/`STYLE`/`REGION` blocks, SRT position data,
 *      ASS-style `{\an8}` override tags, HTML-ish inline tags, and the
 *      entities those files actually contain. Malformed blocks are counted
 *      and skipped rather than throwing away the whole file — a subtitle
 *      someone exported from another tool is rarely perfectly clean.
 *
 *   2. `buildCaptionElementsFromCues` — cues -> `CreateCaptionElement[]`.
 *      One caption element per cue (no re-chunking: a cue's text and timing
 *      are the file's own, so splitting it would silently retime imported
 *      subtitles). Words get SYNTHETIC per-word times spread across the cue
 *      proportionally to word length, because caption elements — and the
 *      karaoke/active-word renderer, EDL `captionWords` and the per-word
 *      text editor — require `words`, and a subtitle file only carries cue
 *      timing. Export side (`buildSrtFromCaptions`) joins the words back, so
 *      import -> export is lossless for text and cue timing.
 */

import { DEFAULT_TRACK_NAMES } from "@/timeline/tracks";
import type { CaptionWord, CreateCaptionElement } from "@/timeline/types";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { buildCaptionStyleParamsPatch, DEFAULT_CAPTION_STYLE_PRESET_ID } from "./styles";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { TICKS_PER_SECOND } from "@/wasm/media-time";

export type SubtitleFormat = "srt" | "vtt";

export interface SubtitleCue {
	/** Cue text with inline tags/entities resolved; lines joined with `\n`. */
	text: string;
	/** Cue start, integer milliseconds from the media/timeline origin. */
	startMs: number;
	/** Cue end, integer milliseconds; always greater than `startMs`. */
	endMs: number;
}

export interface ParseSubtitlesResult {
	format: SubtitleFormat;
	cues: SubtitleCue[];
	/** Blocks that looked like cues but had no usable timestamp/text. */
	skippedCueCount: number;
	warnings: string[];
}

const TIMESTAMP_SEPARATOR = /\s*-->\s*/;
/**
 * One timestamp token: optional hours, minutes, seconds and a 1-3 digit
 * fraction, separated by `.` or `,`. VTT allows `MM:SS.mmm`; SRT requires
 * the hours component but accepting both costs nothing and keeps one
 * timestamp reader for both formats.
 */
const TIMESTAMP_PATTERN = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;

function parseTimestampToken({ token }: { token: string }): number | null {
	const match = token.trim().match(TIMESTAMP_PATTERN);
	if (!match) return null;
	const [, rawHours, rawMinutes, rawSeconds, rawFraction] = match;
	const hours = rawHours === undefined ? 0 : Number.parseInt(rawHours, 10);
	const minutes = Number.parseInt(rawMinutes, 10);
	const seconds = Number.parseInt(rawSeconds, 10);
	if (minutes > 59 || seconds > 59) return null;
	const millis = Number.parseInt(rawFraction.padEnd(3, "0"), 10);
	return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** Resolve the few entities subtitle files actually contain. */
function decodeEntities({ text }: { text: string }): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/**
 * Strip what the caption renderer would otherwise draw literally: SRT/ASS
 * override tags (`{\an8}`, `{\i1}`), VTT inline tags (`<b>`, `<c.yellow>`,
 * `<v Speaker>`, `<00:00:01.000>`), and stray HTML. Entities are decoded
 * after tags so `&lt;i&gt;` survives as text.
 */
function cleanCueText({ raw }: { raw: string }): string {
	const withoutBraces = raw.replace(/\{[^}]*\}/g, "");
	const withoutTags = withoutBraces.replace(/<[^>]*>/g, "");
	const decoded = decodeEntities({ text: withoutTags });
	const lines = decoded
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter((line) => line.length > 0);
	return lines.join("\n");
}

/** Split one block's timestamp line from the rest; `null` if unusable. */
function readTiming({ line }: { line: string }): { startMs: number; endMs: number } | null {
	// VTT cue settings follow the end timestamp: "…--> 00:00:04.000 align:start".
	const [rawStart, rawRest] = line.split(TIMESTAMP_SEPARATOR);
	if (!rawStart || !rawRest) return null;
	const rawEnd = rawRest.trim().split(/\s+/)[0] ?? "";
	const startMs = parseTimestampToken({ token: rawStart });
	const endMs = parseTimestampToken({ token: rawEnd });
	if (startMs === null || endMs === null || endMs <= startMs) return null;
	return { startMs, endMs };
}

function isTimestampLine({ line }: { line: string }): boolean {
	return TIMESTAMP_SEPARATOR.test(line) && line.includes("-->");
}

/**
 * Parse an SRT or WebVTT document. Format is detected from the `WEBVTT`
 * header; a file without one is treated as SRT (the only other format
 * either shell writes today).
 */
export function parseSubtitleText({ input }: { input: string }): ParseSubtitlesResult {
	const withoutBom = input.replace(/^\uFEFF/, "");
	const normalized = withoutBom.replace(/\r\n?/g, "\n").trim();
	const warnings: string[] = [];

	if (!normalized) {
		return { format: "srt", cues: [], skippedCueCount: 0, warnings };
	}

	const firstLine = normalized.split("\n")[0]?.trim() ?? "";
	const format: SubtitleFormat = /^WEBVTT\b/.test(firstLine) ? "vtt" : "srt";

	const blocks = normalized.split(/\n{2,}/);
	const cues: SubtitleCue[] = [];
	let skippedCueCount = 0;

	for (const block of blocks) {
		const lines = block.split("\n");
		const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
		if (firstContentIndex === -1) continue;
		const firstContent = lines[firstContentIndex].trim();

		// Header + non-cue VTT blocks.
		if (format === "vtt" && /^WEBVTT\b/.test(firstContent)) {
			// The header block may also carry the first cue if the file has no
			// blank line between them; drop just the header line and re-read.
			const remainder = lines.slice(firstContentIndex + 1);
			const cueLineIndex = remainder.findIndex((line) => isTimestampLine({ line }));
			if (cueLineIndex === -1) continue;
			const timing = readTiming({ line: remainder[cueLineIndex].trim() });
			const text = cleanCueText({
				raw: remainder.slice(cueLineIndex + 1).join("\n"),
			});
			if (!timing || !text) {
				skippedCueCount += 1;
				continue;
			}
			cues.push({ ...timing, text });
			continue;
		}
		if (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(firstContent)) {
			continue;
		}

		const timestampIndex = isTimestampLine({ line: firstContent })
			? firstContentIndex
			: lines.findIndex((line, index) => index > firstContentIndex && isTimestampLine({ line }));
		if (timestampIndex === -1) {
			skippedCueCount += 1;
			continue;
		}

		const timing = readTiming({ line: lines[timestampIndex].trim() });
		const text = cleanCueText({ raw: lines.slice(timestampIndex + 1).join("\n") });
		if (!timing || !text) {
			skippedCueCount += 1;
			continue;
		}
		cues.push({ ...timing, text });
	}

	if (cues.length === 0) {
		warnings.push("No timed subtitle cues were found.");
	}

	return { format, cues, skippedCueCount, warnings };
}

export interface BuildCaptionElementsFromCuesParams {
	cues: readonly SubtitleCue[];
	/** Where the imported subtitles land on the timeline (ticks). Import
	 *  normally starts at 0; a caller importing into a later region passes
	 *  that offset. */
	timelineStartTime: MediaTime;
	/** Defaults to `DEFAULT_CAPTION_STYLE_PRESET_ID`. */
	stylePresetId?: string;
}

/**
 * Spread a cue's duration across its words. Proportional to word length so
 * karaoke highlighting advances at a human-ish pace; every word gets at
 * least one tick, and the last word ends exactly on the cue end.
 */
function buildSyntheticWords({
	text,
	durationTicks,
}: {
	text: string;
	durationTicks: number;
}): CaptionWord[] {
	const tokens = text.split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return [];

	const weights = tokens.map((token) => Math.max(1, token.length));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const ticksPerWeight = durationTicks / totalWeight;

	const words: CaptionWord[] = [];
	let consumedWeight = 0;
	let cursor = 0;
	for (let index = 0; index < tokens.length; index++) {
		const isLast = index === tokens.length - 1;
		consumedWeight += weights[index];
		const end = isLast
			? durationTicks
			: Math.max(cursor + 1, Math.round(consumedWeight * ticksPerWeight));
		words.push({
			text: tokens[index],
			startTime: mediaTime({ ticks: cursor }),
			endTime: mediaTime({ ticks: Math.max(cursor + 1, end) }),
		});
		cursor = words[words.length - 1].endTime;
	}
	return words;
}

function nameFromCueText({ text }: { text: string }): string {
	const singleLine = text.replace(/\n/g, " ").trim();
	if (singleLine.length <= 40) return singleLine || "Caption";
	return `${singleLine.slice(0, 37)}...`;
}

/**
 * One caption element per cue. Unlike `buildCaptionElementsFromTranscript`,
 * this does NOT run `chunkTranscriptSegments`: an imported cue is already a
 * deliberate page with its own timing, and re-chunking would retime the
 * file's subtitles. Export via `buildSrtFromCaptions` returns the same cue
 * boundaries because the element's start/duration are the cue's own.
 */
export function buildCaptionElementsFromCues({
	cues,
	timelineStartTime,
	stylePresetId = DEFAULT_CAPTION_STYLE_PRESET_ID,
}: BuildCaptionElementsFromCuesParams): CreateCaptionElement[] {
	const params = {
		...buildDefaultParamValues(getBuiltInElementParams({ type: "caption" })),
		...buildCaptionStyleParamsPatch({ presetId: stylePresetId }),
	};

	const elements: CreateCaptionElement[] = [];
	for (const cue of cues) {
		const text = cue.text.trim();
		if (text.length === 0) continue;
		const durationTicks = Math.max(
			1,
			Math.round(((cue.endMs - cue.startMs) / 1000) * TICKS_PER_SECOND),
		);
		const words = buildSyntheticWords({ text, durationTicks });
		if (words.length === 0) continue;
		const startTicks = Math.round((cue.startMs / 1000) * TICKS_PER_SECOND);

		elements.push({
			type: "caption",
			name: nameFromCueText({ text }),
			duration: mediaTime({ ticks: durationTicks }),
			startTime: addMediaTime({
				a: timelineStartTime,
				b: mediaTime({ ticks: startTicks }),
			}),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			words,
			params,
		});
	}

	return elements;
}

/** Convenience for callers that have the file text and no separate parse
 *  step: parse, then build. Throws with the parser's warnings when the
 *  document has no usable cues, so the UI cannot report "imported" for a
 *  file it silently understood as empty. */
export function buildCaptionElementsFromSubtitleText({
	input,
	timelineStartTime,
	stylePresetId,
}: {
	input: string;
	timelineStartTime: MediaTime;
	stylePresetId?: string;
}): { elements: CreateCaptionElement[]; format: SubtitleFormat; skippedCueCount: number } {
	const parsed = parseSubtitleText({ input });
	if (parsed.cues.length === 0) {
		throw new Error(
			parsed.warnings[0] ??
				"No timed subtitle cues were found. Paste an .srt or .vtt file's contents.",
		);
	}
	return {
		elements: buildCaptionElementsFromCues({
			cues: parsed.cues,
			timelineStartTime,
			stylePresetId,
		}),
		format: parsed.format,
		skippedCueCount: parsed.skippedCueCount,
	};
}

export const CAPTION_TRACK_DEFAULT_NAME_FOR_IMPORT = DEFAULT_TRACK_NAMES.caption;

/** Re-exported so callers can convert a cue boundary to ticks without
 *  reaching into wasm time helpers themselves. */
export function cueStartToTicks({ cue }: { cue: SubtitleCue }): MediaTime {
	return mediaTimeFromSeconds({ seconds: cue.startMs / 1000 });
}
