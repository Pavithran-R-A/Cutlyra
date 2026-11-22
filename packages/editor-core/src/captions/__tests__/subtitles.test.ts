/**
 * SRT/VTT import tests. Three layers, because each can fail on its own:
 *   1. `parseSubtitleText` — real-world file shapes (CRLF, BOM, cue ids,
 *      VTT settings, NOTE blocks, ASS override tags, entities, malformed
 *      blocks).
 *   2. `buildCaptionElementsFromCues` — cue timing/word data -> the exact
 *      `CreateCaptionElement` shape the renderer, per-word editor, split
 *      command and EDL all consume.
 *   3. The EDL round trip — imported captions must reach the native export
 *      descriptor (`captionWords` + clip start/duration), which is the same
 *      burn-in path already verified for generated captions.
 */
import { describe, expect, test } from "bun:test";
import {
	buildCaptionElementsFromCues,
	buildCaptionElementsFromSubtitleText,
	parseSubtitleText,
} from "../subtitles";
import { buildSrtFromCaptions } from "../srt";
import type { CaptionElement, SceneTracks, TScene, VideoTrack } from "@/timeline/types";
import type { TProject } from "@/project/types";
import { buildEdl, validateEdl, type BuildEdlOutputArgs } from "@/edl";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import type { MediaAssetData } from "@/services/storage/types";

const SRT = [
	"1",
	"00:00:01,000 --> 00:00:03,000",
	"First line",
	"second line",
	"",
	"2",
	"00:00:04,500 --> 00:00:06,000",
	"Second cue",
	"",
].join("\n");

const VTT = [
	"WEBVTT",
	"",
	"NOTE this comment must not become a cue",
	"",
	"intro",
	"00:01.000 --> 00:02.500 align:start position:10%",
	"<v Narrator>Hello &amp; welcome</v>",
	"",
	"00:00:03.000 --> 00:00:04.000",
	"<i>Italic</i> text",
	"",
].join("\n");

describe("parseSubtitleText", () => {
	test("parses SRT cues with multi-line text and millisecond precision", () => {
		const parsed = parseSubtitleText({ input: SRT });
		expect(parsed.format).toBe("srt");
		expect(parsed.skippedCueCount).toBe(0);
		expect(parsed.cues).toEqual([
			{ text: "First line\nsecond line", startMs: 1000, endMs: 3000 },
			{ text: "Second cue", startMs: 4500, endMs: 6000 },
		]);
	});

	test("tolerates a BOM, CRLF line endings and SRT position data after the end time", () => {
		const input =
			"\uFEFF1\r\n00:00:00,500 --> 00:00:02,000 X1:100 X2:200 Y1:1 Y2:2\r\nHi\r\n";
		const parsed = parseSubtitleText({ input });
		expect(parsed.cues).toEqual([{ text: "Hi", startMs: 500, endMs: 2000 }]);
	});

	test("parses WebVTT: header, cue identifiers, settings, short MM:SS timestamps, NOTE blocks", () => {
		const parsed = parseSubtitleText({ input: VTT });
		expect(parsed.format).toBe("vtt");
		expect(parsed.skippedCueCount).toBe(0);
		expect(parsed.cues).toEqual([
			{ text: "Hello & welcome", startMs: 1000, endMs: 2500 },
			{ text: "Italic text", startMs: 3000, endMs: 4000 },
		]);
	});

	test("strips ASS override tags and decodes entities", () => {
		const parsed = parseSubtitleText({
			input:
				"1\n00:00:00,000 --> 00:00:01,000\n{\\an8}&lt;not a tag&gt; &amp; &#39;quoted&#39;\n",
		});
		expect(parsed.cues[0].text).toBe("<not a tag> & 'quoted'");
	});

	test("counts unusable blocks instead of discarding the whole file", () => {
		const parsed = parseSubtitleText({
			input: [
				"1",
				"00:00:02,000 --> 00:00:01,000",
				"Backwards cue",
				"",
				"2",
				"not a timestamp",
				"Ignored",
				"",
				"3",
				"00:00:03,000 --> 00:00:04,000",
				"Kept",
				"",
			].join("\n"),
		});
		expect(parsed.cues).toEqual([{ text: "Kept", startMs: 3000, endMs: 4000 }]);
		expect(parsed.skippedCueCount).toBe(2);
	});

	test("an empty or cue-less document yields no cues and a warning, never a throw", () => {
		expect(parseSubtitleText({ input: "   \n\n" }).cues).toEqual([]);
		const none = parseSubtitleText({ input: "WEBVTT\n\nNOTE just a note\n" });
		expect(none.cues).toEqual([]);
		expect(none.warnings.length).toBe(1);
	});
});

describe("buildCaptionElementsFromCues", () => {
	test("one element per cue with the cue's own start and duration", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const elements = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: ZERO_MEDIA_TIME,
		});

		expect(elements).toHaveLength(2);
		expect(elements[0].startTime).toBe(mediaTime({ ticks: 1 * TICKS_PER_SECOND }));
		expect(elements[0].duration).toBe(mediaTime({ ticks: 2 * TICKS_PER_SECOND }));
		expect(elements[1].startTime).toBe(mediaTime({ ticks: 4.5 * TICKS_PER_SECOND }));
		expect(elements[1].duration).toBe(mediaTime({ ticks: 1.5 * TICKS_PER_SECOND }));
		// Captions are not re-chunked on import: the file's page stays one clip.
		expect(elements[0].words.map((word) => word.text)).toEqual([
			"First",
			"line",
			"second",
			"line",
		]);
		expect(elements[0].name).toBe("First line second line");
		expect(elements[0].trimStart).toBe(ZERO_MEDIA_TIME);
		expect(elements[0].trimEnd).toBe(ZERO_MEDIA_TIME);
	});

	test("synthetic word times are ordered, non-overlapping and end exactly on the cue", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const [element] = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: ZERO_MEDIA_TIME,
		});

		expect(element.words[0].startTime).toBe(ZERO_MEDIA_TIME);
		expect(element.words[element.words.length - 1].endTime).toBe(element.duration);
		for (let index = 0; index < element.words.length; index++) {
			const word = element.words[index];
			expect(word.endTime).toBeGreaterThan(word.startTime);
			const next = element.words[index + 1];
			if (next) expect(next.startTime).toBeGreaterThanOrEqual(word.endTime);
		}
	});

	test("offsets every cue by the requested timeline start", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const [element] = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: mediaTime({ ticks: 10 * TICKS_PER_SECOND }),
		});
		expect(element.startTime).toBe(mediaTime({ ticks: 11 * TICKS_PER_SECOND }));
	});

	test("applies the requested caption style preset", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const [element] = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: ZERO_MEDIA_TIME,
			stylePresetId: "classic",
		});
		expect(element.params.stylePresetId).toBe("classic");
		expect(element.params.animationStyle).toBe("karaoke");
	});

	test("throws (with the parser's own message) when no cue is usable", () => {
		expect(() =>
			buildCaptionElementsFromSubtitleText({
				input: "not a subtitle file",
				timelineStartTime: ZERO_MEDIA_TIME,
			}),
		).toThrow(/No timed subtitle cues/);
	});
});

describe("SRT export round trip", () => {
	test("import -> export reproduces cue text and boundaries", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const elements = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: ZERO_MEDIA_TIME,
		}).map((element, index) => ({ ...element, id: `cue-${index}` }) as CaptionElement);

		const srt = buildSrtFromCaptions(elements);
		expect(srt).toContain("1\n00:00:01,000 --> 00:00:03,000\nFirst line second line");
		expect(srt).toContain("2\n00:00:04,500 --> 00:00:06,000\nSecond cue");

		const reparsed = parseSubtitleText({ input: srt });
		expect(reparsed.cues).toEqual([
			{ text: "First line second line", startMs: 1000, endMs: 3000 },
			{ text: "Second cue", startMs: 4500, endMs: 6000 },
		]);
	});
});

describe("imported captions reach the export descriptor", () => {
	const project: TProject = {
		metadata: {
			id: "proj-import",
			name: "subtitle import",
			duration: mediaTime({ ticks: 10 * TICKS_PER_SECOND }),
			createdAt: new Date("2026-11-22T00:00:00.000Z"),
			updatedAt: new Date("2026-11-22T00:00:00.000Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		version: 31,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			background: { type: "color", color: "#000000" },
		},
	};

	const mediaAssets: MediaAssetData[] = [
		{
			id: "media-main",
			name: "main.mp4",
			type: "video",
			size: 1_000_000,
			lastModified: 1_755_000_000_000,
			width: 1080,
			height: 1920,
			duration: 10,
			fps: 30,
			hasAudio: true,
		},
	];

	const output: BuildEdlOutputArgs = {
		container: "mp4",
		videoCodec: "h264",
		audioCodec: "aac",
		bitrate: 8_000_000,
		includeAudio: true,
	};

	test("a parsed SRT lands in the EDL as a caption overlay with per-word timings", () => {
		const { cues } = parseSubtitleText({ input: SRT });
		const captionElements = buildCaptionElementsFromCues({
			cues,
			timelineStartTime: ZERO_MEDIA_TIME,
		}).map((element, index) => ({ ...element, id: `cue-${index}` }) as CaptionElement);

		const mainTrack: VideoTrack = {
			id: "track-main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				{
					id: "clip-main",
					name: "main.mp4",
					type: "video",
					mediaId: "media-main",
					duration: mediaTime({ ticks: 10 * TICKS_PER_SECOND }),
					startTime: ZERO_MEDIA_TIME,
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					isSourceAudioEnabled: true,
					hidden: false,
					params: {},
				},
			],
		};

		const scene: TScene = {
			id: "scene-1",
			name: "Scene 1",
			isMain: true,
			tracks: {
				overlay: [
					{
						id: "track-imported-captions",
						name: "Captions",
						type: "caption",
						hidden: false,
						elements: captionElements,
					},
				],
				main: mainTrack,
				audio: [],
			} as SceneTracks,
			bookmarks: [],
			createdAt: new Date("2026-11-22T00:00:00.000Z"),
			updatedAt: new Date("2026-11-22T00:00:00.000Z"),
		};

		const edl = buildEdl({ project, scene, mediaAssets, output });
		expect(validateEdl({ edl }).errors).toEqual([]);
		expect(edl.overlays.some((overlay) => overlay.kind === "caption")).toBe(true);

		const clip = edl.tracks
			.find((track) => track.trackId === "track-imported-captions")
			?.clips.find((candidate) => candidate.clipId === "cue-0");
		expect(clip).toBeDefined();
		expect(clip?.startTicks).toBe(1 * TICKS_PER_SECOND);
		expect(clip?.durationTicks).toBe(2 * TICKS_PER_SECOND);
		expect(clip?.captionWords.map((word) => word.text)).toEqual([
			"First",
			"line",
			"second",
			"line",
		]);
		expect(clip?.captionWords[0].startTicks).toBe(0);
		expect(clip?.captionWords[3].endTicks).toBe(2 * TICKS_PER_SECOND);
	});
});
