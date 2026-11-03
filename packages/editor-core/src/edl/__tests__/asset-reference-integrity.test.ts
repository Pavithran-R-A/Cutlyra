/**
 * GitHub #55 / Linear PAV-148 — a media-backed clip must never lose its media
 * reference on its way from the timeline to the exporter.
 *
 * The field report was an export refusal, `clip 71a7d579-… has no assetId`:
 * `EdlToComposition.requireAsset()` in the Android exporter receives an
 * `EdlClip` whose `assetId` is null, and refuses to build the composition.
 * `buildEdl()` produces that null for any element that carries no string
 * `mediaId` (see `edl/build.ts`), so either an editor command drops the field
 * or a project arrives from storage already damaged.
 *
 * These tests drive the REAL commands a user runs — import/append, trim via
 * split, duplicate (which spawns a PiP overlay track), retime, reorder,
 * save/reopen through the real scene serialisation — against the real
 * `EditorCore` (as `media/__tests__/native-import.test.ts` does; no module
 * mocks, which leak across `bun test` files), and then assert the built EDL:
 * every video/image/audio clip carries a non-empty `assetId` that resolves to
 * an asset with a `sourceUri`, generated content (text) still carries none,
 * and nothing is silently dropped along the way.
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import {
	buildElementFromMedia,
	buildTextElement,
} from "@/timeline/element-utils";
import {
	deserializeScene,
	serializeScene,
} from "@/services/storage/scene-serialization";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { buildEdl } from "@/edl/build";
import { validateEdl } from "@/edl/validate";
import {
	assertMediaReferencesResolved,
	findUnresolvedMediaClips,
} from "@/edl/preflight";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { SplitElementsCommand } from "@/commands/timeline/element/split-elements";
import { DuplicateElementsCommand } from "@/commands/timeline/element/duplicate-elements";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import type { MediaAsset } from "@/media/types";
import type { MediaAssetData } from "@/services/storage/types";

const TPS = TICKS_PER_SECOND;
const t = ({ seconds }: { seconds: number }) =>
	mediaTime({ ticks: Math.round(seconds * TPS) });

const ASSETS: MediaAssetData[] = [
	{
		id: "asset-video-1",
		name: "intro.mp4",
		type: "video",
		size: 1_000_000,
		lastModified: 0,
		duration: 6,
		width: 1080,
		height: 1920,
		hasAudio: true,
	},
	{
		id: "asset-image-1",
		name: "cover.jpg",
		type: "image",
		size: 500_000,
		lastModified: 0,
		width: 1080,
		height: 1920,
	},
	{
		id: "asset-audio-1",
		name: "music.mp3",
		type: "audio",
		size: 250_000,
		lastModified: 0,
		duration: 4,
		hasAudio: true,
	},
];

/** The engine's live library shape (`MediaAsset` adds the backing file). */
const MEDIA_ASSETS: MediaAsset[] = ASSETS.map((asset) => ({
	...asset,
	file: new File([], asset.name),
}));

const SCENE_ID = "scene-pav-148";

/** Real editor, a real project and one main scene. No mocks. */
function bootstrap() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: SCENE_ID,
	};
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: SCENE_ID });
	editor.media.setAssets({ assets: MEDIA_ASSETS });
	return { editor, mainTrackId: scene.tracks.main.id };
}

function edlOutput() {
	return {
		container: "mp4" as const,
		videoCodec: "h264",
		audioCodec: "aac",
		bitrate: 8_000_000,
		includeAudio: true,
	};
}

function buildProjectEdl({ editor }: { editor: EditorCore }) {
	const project = editor.project.getActive();
	if (!project) throw new Error("no active project");
	return buildEdl({
		project,
		scene: editor.scenes.getActiveScene(),
		mediaAssets: ASSETS,
		resolveAsset: ({ mediaId }) => ({ sourceUri: `cutlyra-media://${mediaId}` }),
		output: edlOutput(),
	});
}

describe("asset reference integrity (GitHub #55 / PAV-148)", () => {
	beforeEach(() => {
		bootstrap();
	});

	afterEach(() => {
		EditorCore.reset();
	});

	it("keeps every media clip's assetId through insert, split, duplicate, retime, move and save/reopen", () => {
		const { editor, mainTrackId } = bootstrap();

		// --- import/append: the `+` button's real path -----------------------
		const video = new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: "asset-video-1",
				mediaType: "video",
				name: "intro.mp4",
				duration: t({ seconds: 6 }),
				startTime: ZERO_MEDIA_TIME,
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		});
		video.execute();
		const videoId = video.getElementId();

		new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: "asset-image-1",
				mediaType: "image",
				name: "cover.jpg",
				duration: t({ seconds: 3 }),
				startTime: t({ seconds: 6 }),
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		}).execute();

		new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: "asset-audio-1",
				mediaType: "audio",
				name: "music.mp3",
				duration: t({ seconds: 4 }),
				startTime: ZERO_MEDIA_TIME,
			}),
			placement: { mode: "newTrack", trackType: "audio" },
		}).execute();

		new InsertElementCommand({
			element: buildTextElement({
				raw: { name: "title", duration: t({ seconds: 2 }) },
				startTime: t({ seconds: 1 }),
			}),
			placement: { mode: "newTrack", trackType: "text" },
		}).execute();

		// --- trim: split the video in half -----------------------------------
		const split = new SplitElementsCommand({
			elements: [{ trackId: mainTrackId, elementId: videoId }],
			splitTime: t({ seconds: 3 }),
		});
		split.execute();
		const rightSides = split.getRightSideElements();
		expect(rightSides).toHaveLength(1);

		// --- duplicate: lands as a PiP clip on a NEW overlay track -----------
		const duplicate = new DuplicateElementsCommand({ elements: rightSides });
		duplicate.execute();
		const duplicated = duplicate.getDuplicatedElements();
		expect(duplicated).toHaveLength(1);

		// --- retime + reorder the duplicate ---------------------------------
		new UpdateElementsCommand({
			updates: [
				{
					trackId: duplicated[0]!.trackId,
					elementId: duplicated[0]!.elementId,
					patch: { retime: { rate: 2, maintainPitch: true } },
				},
			],
		}).execute();
		new MoveElementCommand({
			moves: [
				{
					sourceTrackId: duplicated[0]!.trackId,
					targetTrackId: duplicated[0]!.trackId,
					elementId: duplicated[0]!.elementId,
					newStartTime: t({ seconds: 1 }),
				},
			],
		}).execute();

		// --- save / reopen through the real serialisation --------------------
		// `structuredClone` is the same copy semantics IndexedDB applies when the
		// serialized scene is persisted — nothing here may be a live reference.
		const saved = structuredClone(
			serializeScene({ scene: editor.scenes.getActiveScene() }),
		);
		const reopened = deserializeScene({ scene: saved });

		const project = editor.project.getActive();
		if (!project) throw new Error("no active project");
		const edl = buildEdl({
			project,
			scene: reopened,
			mediaAssets: ASSETS,
			resolveAsset: ({ mediaId }) => ({ sourceUri: `cutlyra-media://${mediaId}` }),
			output: edlOutput(),
		});

		// Nothing was dropped: video-left + image on the main track, the split
		// right half as its own main clip, and the PiP duplicate on an overlay.
		const mainTrack = edl.tracks.find((track) => track.kind === "main")!;
		expect(mainTrack.clips).toHaveLength(3);
		expect(edl.tracks.some((track) => track.kind === "overlay")).toBe(true);

		const mediaClips = edl.tracks.flatMap((track) =>
			track.clips
				.filter(
					(clip) =>
						clip.kind === "video" ||
						clip.kind === "image" ||
						clip.kind === "audio",
				)
				.map((clip) => ({ trackId: track.trackId, clip })),
		);
		expect(mediaClips.length).toBeGreaterThanOrEqual(5);

		const assetIds = new Set(edl.assets.map((asset) => asset.assetId));
		const withUri = new Set(
			edl.assets
				.filter((asset) => asset.sourceUri !== null)
				.map((asset) => asset.assetId),
		);
		for (const { clip } of mediaClips) {
			expect(typeof clip.assetId).toBe("string");
			expect(clip.assetId).not.toBe("");
			expect(assetIds.has(clip.assetId!)).toBe(true);
			expect(withUri.has(clip.assetId!)).toBe(true);
		}

		// Generated content keeps its intentional null reference.
		const textClips = edl.tracks.flatMap((track) =>
			track.clips.filter((clip) => clip.kind === "text"),
		);
		expect(textClips).toHaveLength(1);
		expect(textClips[0]!.assetId).toBeNull();

		const result = validateEdl({ edl, options: { strict: true } });
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);

		// And the pre-flight the export sheet now runs agrees.
		expect(findUnresolvedMediaClips({ edl })).toEqual([]);
		expect(() => assertMediaReferencesResolved({ edl })).not.toThrow();
	});

	it("refuses to persist a media element whose mediaId is empty", () => {
		const { editor, mainTrackId } = bootstrap();
		const before = editor.scenes.getActiveScene().tracks.main.elements.length;

		// `""` is the type-legal way an unresolved asset id reaches this seam
		// (a caller passing `mediaId: asset.id` where the id is empty). The old
		// guard only checked that the KEY existed, so it persisted; the clip
		// then had `assetId: ""` in the EDL and every export refused.
		new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: "",
				mediaType: "video",
				name: "intro.mp4",
				duration: t({ seconds: 6 }),
				startTime: ZERO_MEDIA_TIME,
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		}).execute();

		// An element with no usable media reference must never reach the
		// timeline: that is exactly the corruption that surfaces later as
		// "clip <uuid> has no assetId". (`undefined` / a missing key are the
		// same failure at runtime but cannot be expressed in TS; the guard
		// rejects every non-string value, not just `""`.)
		expect(editor.scenes.getActiveScene().tracks.main.elements).toHaveLength(
			before,
		);
	});
});

describe("media-reference pre-flight (GitHub #55 / PAV-148)", () => {
	beforeEach(() => {
		bootstrap();
	});

	afterEach(() => {
		EditorCore.reset();
	});

	/** A minimal valid EDL; each case damages exactly one reference. */
	function buildHealthyEdl() {
		const { editor, mainTrackId } = bootstrap();
		new InsertElementCommand({
			element: buildElementFromMedia({
				mediaId: "asset-video-1",
				mediaType: "video",
				name: "intro.mp4",
				duration: t({ seconds: 6 }),
				startTime: ZERO_MEDIA_TIME,
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		}).execute();
		return buildProjectEdl({ editor });
	}

	it("passes a healthy document", () => {
		const edl = buildHealthyEdl();
		expect(findUnresolvedMediaClips({ edl })).toEqual([]);
		expect(() => assertMediaReferencesResolved({ edl })).not.toThrow();
	});

	it("names the clip whose assetId was lost, and the repair action", () => {
		const edl = buildHealthyEdl();
		const mainTrack = edl.tracks.find((track) => track.kind === "main")!;
		const broken = mainTrack.clips[0]!;
		broken.assetId = null;

		expect(findUnresolvedMediaClips({ edl })).toEqual([
			{
				trackId: mainTrack.trackId,
				clipId: broken.clipId,
				name: broken.name,
				kind: broken.kind,
				reason: "missing-asset-id",
			},
		]);
		expect(() => assertMediaReferencesResolved({ edl })).toThrow(
			/intro\.mp4.*lost its media reference.*replace the clip/is,
		);
	});

	it("flags an unknown asset and a missing source file, but never text", () => {
		const unknownAsset = buildHealthyEdl();
		unknownAsset.tracks
			.find((track) => track.kind === "main")!
			.clips[0]!.assetId = "asset-gone";
		expect(
			findUnresolvedMediaClips({ edl: unknownAsset }).map(
				(clip) => clip.reason,
			),
		).toEqual(["unknown-asset"]);

		// The asset exists but has no file handle (native import never ran).
		const noSourceUri = buildHealthyEdl();
		for (const asset of noSourceUri.assets) asset.sourceUri = null;
		expect(
			findUnresolvedMediaClips({ edl: noSourceUri }).map(
				(clip) => clip.reason,
			),
		).toEqual(["missing-source-uri"]);

		// Generated content carries no asset by contract and is never flagged.
		const generated = buildHealthyEdl();
		const mainTrack = generated.tracks.find((track) => track.kind === "main")!;
		generated.tracks.push({
			...mainTrack,
			trackId: "track-text",
			trackType: "text",
			clips: [
				{
					...mainTrack.clips[0]!,
					clipId: "title",
					kind: "text",
					assetId: null,
				},
			],
		});
		expect(findUnresolvedMediaClips({ edl: generated })).toEqual([]);
	});
});
