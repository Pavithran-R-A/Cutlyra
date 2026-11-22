/**
 * Per-clip audio fades: envelope math, EDL serialization and back-compat.
 *
 * The EDL side is checked the way the exporter consumes it — `buildEdl` output
 * is validated by `validateEdl` AND against `schema/edl-v1.json` — because a
 * shape the Kotlin parser cannot see is worth nothing, no matter how correct
 * the math is.
 */
// The schema check hands the JSON-schema literal and the EDL value to a
// generic validator, the same deliberate widening
// `captions/__tests__/caption-pipeline-integration.test.ts` disables
// file-wide for identical reasons.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import {
	audioFadeGainAt,
	buildAudioFadeEnvelope,
	buildAudioFadeParamsPatch,
	clampAudioFades,
	readAudioFadeSeconds,
} from "../audio-fades";
import { buildEdl, validateEdl } from "@/edl";
import edlSchema from "../../../schema/edl-v1.json";
import { validateAgainstSchema } from "@/edl/__tests__/json-schema";
import type { SceneTracks, TScene, VideoTrack } from "@/timeline/types";
import type { TProject } from "@/project/types";
import type { MediaAssetData } from "@/services/storage/types";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

const TPS = TICKS_PER_SECOND;

describe("readAudioFadeSeconds", () => {
	test("absent params are zero (every pre-fade project)", () => {
		expect(readAudioFadeSeconds({ params: {} })).toEqual({ fadeIn: 0, fadeOut: 0 });
	});

	test("only finite positive numbers count", () => {
		expect(
			readAudioFadeSeconds({
				params: { fadeIn: Number.NaN, fadeOut: -1 },
			}),
		).toEqual({ fadeIn: 0, fadeOut: 0 });
		expect(readAudioFadeSeconds({ params: { fadeIn: 0.5, fadeOut: "1" } })).toEqual({
			fadeIn: 0.5,
			fadeOut: 0,
		});
	});
});

describe("clampAudioFades", () => {
	test("each side is clamped to the clip length", () => {
		expect(clampAudioFades({ fadeIn: 5, fadeOut: 0, duration: 2 })).toEqual({
			fadeIn: 2,
			fadeOut: 0,
		});
	});

	test("in + out past the clip is scaled proportionally, not dropped", () => {
		// Each is clamped to the clip first (3 -> 2), leaving 2 + 1 = 3 against a
		// 2s clip, then both scale by 2/3.
		expect(clampAudioFades({ fadeIn: 3, fadeOut: 1, duration: 2 })).toEqual({
			fadeIn: 4 / 3,
			fadeOut: 2 / 3,
		});
	});

	test("a zero-length clip has no fades", () => {
		expect(clampAudioFades({ fadeIn: 1, fadeOut: 1, duration: 0 })).toEqual({
			fadeIn: 0,
			fadeOut: 0,
		});
	});
});

describe("buildAudioFadeEnvelope", () => {
	test("no fade params -> no envelope at all (field omitted)", () => {
		expect(
			buildAudioFadeEnvelope({ params: {}, durationTicks: 4 * TPS }),
		).toBeNull();
	});

	test("both sides convert seconds to ticks and clamp to the clip", () => {
		expect(
			buildAudioFadeEnvelope({
				params: { fadeIn: 0.5, fadeOut: 5 },
				durationTicks: 2 * TPS,
			}),
		// 0.5s in + 5s out, both clamped to the 2s clip first, then scaled by
		// 2/2.5 = 0.8 -> 0.4s in, 1.6s out.
		).toEqual({ inTicks: 0.4 * TPS, outTicks: 1.6 * TPS });
	});

	test("a boolean or string never becomes a fade", () => {
		expect(
			buildAudioFadeEnvelope({
				params: { fadeIn: true, fadeOut: "2" },
				durationTicks: 2 * TPS,
			}),
		).toBeNull();
	});
});

describe("buildAudioFadeParamsPatch (the Edit panel's write)", () => {
	test("stored seconds are clamped to the clip, rounded to milliseconds", () => {
		expect(
			buildAudioFadeParamsPatch({
				params: { fadeIn: 3, fadeOut: 1 },
				durationTicks: 2 * TPS,
			}),
		// Rounded to milliseconds: what the slider shows is what is stored.
		).toEqual({ fadeIn: 1.333, fadeOut: 0.667 });
	});

	test("zero clears both sides", () => {
		expect(
			buildAudioFadeParamsPatch({
				params: { fadeIn: 0, fadeOut: 0 },
				durationTicks: 2 * TPS,
			}),
		).toEqual({ fadeIn: 0, fadeOut: 0 });
	});
});

describe("audioFadeGainAt", () => {
	const envelope = { inTicks: TPS, outTicks: 2 * TPS };
	const durationTicks = 4 * TPS;

	test("ramps linearly up and down, unity in between", () => {
		expect(audioFadeGainAt({ timeTicks: 0, durationTicks, envelope })).toBe(0);
		expect(audioFadeGainAt({ timeTicks: TPS / 2, durationTicks, envelope })).toBe(0.5);
		expect(audioFadeGainAt({ timeTicks: TPS, durationTicks, envelope })).toBe(1);
		expect(
			audioFadeGainAt({ timeTicks: 3 * TPS, durationTicks, envelope }),
		).toBeCloseTo(0.5, 10);
		expect(audioFadeGainAt({ timeTicks: 4 * TPS, durationTicks, envelope })).toBe(0);
	});

	test("overlapping ramps take the smaller gain (a dip, never a bump)", () => {
		const overlapping = { inTicks: 3 * TPS, outTicks: 3 * TPS };
		const gain = audioFadeGainAt({ timeTicks: 2 * TPS, durationTicks: 4 * TPS, envelope: overlapping });
		// in -> 2/3, out -> 2/3; both sides at their midpoint, never above 1.
		expect(gain).toBeCloseTo(2 / 3, 10);
		expect(
			audioFadeGainAt({ timeTicks: TPS, durationTicks: 4 * TPS, envelope: overlapping }),
		).toBeLessThanOrEqual(1);
	});

	test("a flat envelope (no fades) is unity everywhere", () => {
		const flat = { inTicks: 0, outTicks: 0 };
		for (const time of [0, 1, 2, 4]) {
			expect(audioFadeGainAt({ timeTicks: time * TPS, durationTicks, envelope: flat })).toBe(1);
		}
	});
});

const PROJECT: TProject = {
	metadata: {
		id: "proj-fades",
		name: "audio fades",
		duration: mediaTime({ ticks: 8 * TPS }),
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

const MEDIA_ASSETS: MediaAssetData[] = [
	{
		id: "media-audio",
		name: "tone.wav",
		type: "audio",
		size: 100_000,
		lastModified: 1_755_000_000_000,
		width: 0,
		height: 0,
		duration: 8,
		hasAudio: true,
	},
];

const OUTPUT = {
	container: "mp4" as const,
	videoCodec: "h264" as const,
	audioCodec: "aac" as const,
	bitrate: 4_000_000,
	includeAudio: true,
};

function buildProjectEdl({ params }: { params: Record<string, number | string | boolean> }) {
	const mainTrack: VideoTrack = {
		id: "track-main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [],
	};
	const scene: TScene = {
		id: "scene-1",
		name: "Scene 1",
		isMain: true,
		tracks: {
			main: mainTrack,
			overlay: [],
			audio: [
				{
					id: "track-audio",
					name: "Audio",
					type: "audio",
					muted: false,
					elements: [
						{
							id: "clip-audio",
							name: "tone.wav",
							type: "audio",
							mediaId: "media-audio",
							sourceType: "upload",
							duration: mediaTime({ ticks: 4 * TPS }),
							startTime: ZERO_MEDIA_TIME,
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							params,
						},
					],
				},
			],
		} as SceneTracks,
		bookmarks: [],
		createdAt: new Date("2026-11-22T00:00:00.000Z"),
		updatedAt: new Date("2026-11-22T00:00:00.000Z"),
	};
	return buildEdl({ project: PROJECT, scene, mediaAssets: MEDIA_ASSETS, output: OUTPUT });
}

describe("EDL audio fade", () => {
	test("faded clip emits a schema-valid envelope in ticks", () => {
		const edl = buildProjectEdl({ params: { fadeIn: 1, fadeOut: 0.5 } });
		expect(validateEdl({ edl }).errors).toEqual([]);
		expect(
			validateAgainstSchema({
				value: edl as unknown,
				schema: edlSchema as unknown as Record<string, unknown>,
			}),
		).toEqual([]);

		const clip = edl.tracks
			.find((track) => track.trackId === "track-audio")
			?.clips.find((candidate) => candidate.clipId === "clip-audio");
		expect(clip?.audioFade).toEqual({ inTicks: TPS, outTicks: TPS / 2 });
	});

	test("an over-long pair is clamped to the clip before it reaches the EDL", () => {
		const edl = buildProjectEdl({ params: { fadeIn: 10, fadeOut: 10 } });
		const clip = edl.tracks
			.find((track) => track.trackId === "track-audio")
			?.clips.find((candidate) => candidate.clipId === "clip-audio");
		expect(clip?.audioFade).toEqual({ inTicks: 2 * TPS, outTicks: 2 * TPS });
		expect(validateEdl({ edl }).errors).toEqual([]);
	});

	test("an unfaded clip has no audioFade key at all (descriptor unchanged)", () => {
		const edl = buildProjectEdl({ params: { volume: 0 } });
		const clip = edl.tracks
			.find((track) => track.trackId === "track-audio")
			?.clips.find((candidate) => candidate.clipId === "clip-audio");
		expect(clip).toBeDefined();
		expect(clip !== undefined && Object.hasOwn(clip, "audioFade")).toBe(false);
		expect(JSON.stringify(edl)).not.toContain("audioFade");
	});

	test("a fade on a video clip propagates too", () => {
		const videoTrack: VideoTrack = {
			id: "track-main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				{
					id: "clip-video",
					name: "clip.mp4",
					type: "video",
					mediaId: "media-video",
					duration: mediaTime({ ticks: 2 * TPS }),
					startTime: ZERO_MEDIA_TIME,
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					isSourceAudioEnabled: true,
					params: { fadeIn: 0.25 },
				},
			],
		};
		const scene: TScene = {
			id: "scene-1",
			name: "Scene 1",
			isMain: true,
			tracks: { main: videoTrack, overlay: [], audio: [] },
			bookmarks: [],
			createdAt: new Date("2026-11-22T00:00:00.000Z"),
			updatedAt: new Date("2026-11-22T00:00:00.000Z"),
		};
		const edl = buildEdl({
			project: PROJECT,
			scene,
			mediaAssets: [
				{
					...MEDIA_ASSETS[0],
					id: "media-video",
					name: "clip.mp4",
					type: "video",
					width: 1080,
					height: 1920,
				},
			],
			output: OUTPUT,
		});
		expect(validateEdl({ edl }).errors).toEqual([]);
		expect(edl.tracks[0].clips[0].audioFade).toEqual({ inTicks: TPS / 4, outTicks: 0 });
	});
});
