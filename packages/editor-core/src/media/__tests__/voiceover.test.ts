/**
 * Voiceover project-state tests.
 *
 * The recorder itself is native (`VoiceoverRecorder`, JVM-tested) and the mix
 * is proven by `ExportVoiceoverInstrumentedTest` on decoded MP4 audio. What
 * THIS file pins is the state half the export depends on:
 *
 *  - a finished take becomes one audio asset row (custody path, no bytes in
 *    JS) PLUS one audio-track element at the record position, in one undo
 *    step — so undo/redo, save/reopen and archive/restore see ordinary media;
 *  - the recorded WAV path, not a blob, is what the EDL resolves;
 *  - the take limit is the smaller of 5 minutes and the remaining project;
 *  - the custody sweep deletes only unreferenced `generated/voiceover-*`
 *    files — never a referenced take, never another generated medium.
 *
 * No module mocks: the real `EditorCore`, with `storageService.saveMediaAsset`
 * replaced file-locally because OPFS/IndexedDB do not exist under `bun test`
 * (the discipline `library-audio.test.ts` documents).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, mediaTimeToSeconds } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import { storageService } from "@/services/storage/service";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { MediaAsset } from "@/media/types";
import type { VoiceoverSource } from "../voiceover";
import {
	commitVoiceoverTake,
	newVoiceoverTakeId,
	pruneUnusedVoiceoverTakes,
	referencedVoiceoverPaths,
	voiceoverTakeLimit,
	VOICEOVER_MAX_TAKE_SECONDS,
} from "../voiceover";

const t = ({ seconds }: { seconds: number }) =>
	mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });

function fakeSource({
	root = "/sandbox/media",
}: { root?: string | null } = {}) {
	const prunes: string[][] = [];
	const removed = ["generated/voiceover-stale.wav"];
	const source: VoiceoverSource = {
		async getMediaRoot() {
			return root;
		},
		toPlaybackUri: (uri: string) => `webview://${uri}`,
		async pruneVoiceoverTakes({ referencedPaths }) {
			prunes.push([...referencedPaths]);
			return { removed: [...removed] };
		},
	};
	return { source, prunes, removed };
}

function bootstrap({ playheadSeconds = 0 }: { playheadSeconds?: number } = {}) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: "scene-voiceover",
	};
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	editor.playback.seek({ time: t({ seconds: playheadSeconds }) });
	return { editor, sceneId: scene.id };
}

const savedAssets: MediaAsset[] = [];
const saveMediaAssetImpl = storageService.saveMediaAsset;

beforeEach(() => {
	savedAssets.length = 0;
	storageService.saveMediaAsset = async ({ mediaAsset }) => {
		savedAssets.push(mediaAsset);
	};
});

afterEach(() => {
	storageService.saveMediaAsset = saveMediaAssetImpl;
});

const TAKE = {
	relativePath: "generated/voiceover-abc.wav",
	durationMs: 1_500,
	sizeBytes: 132_344,
};

describe("voiceover take limits", () => {
	it("caps a take at five minutes when the project is longer", () => {
		const limit = voiceoverTakeLimit({ startSeconds: 10, timelineEndSeconds: 900 });
		expect(limit).toEqual({ limitSeconds: VOICEOVER_MAX_TAKE_SECONDS, reason: "max-take" });
	});

	it("stops at the end of the project when less than five minutes remain", () => {
		const limit = voiceoverTakeLimit({ startSeconds: 4.5, timelineEndSeconds: 6 });
		expect(limit.reason).toBe("project-end");
		expect(limit.limitSeconds).toBeCloseTo(1.5, 5);
	});

	it("refuses to start when the playhead is at (or past) the end", () => {
		expect(voiceoverTakeLimit({ startSeconds: 6, timelineEndSeconds: 6 })).toEqual({
			limitSeconds: 0,
			reason: "none",
		});
		expect(voiceoverTakeLimit({ startSeconds: 7, timelineEndSeconds: 6 }).limitSeconds).toBe(0);
	});
});

describe("committing a recorded take", () => {
	it("adds one custody-backed audio asset and an audio clip at the record position", async () => {
		const { editor } = bootstrap({ playheadSeconds: 2 });
		const { source } = fakeSource();
		const projectId = editor.project.getActive().metadata.id;

		const committed = await commitVoiceoverTake({
			editor,
			projectId,
			source,
			take: TAKE,
			startSeconds: 2,
		});
		expect(committed).not.toBeNull();
		if (!committed) throw new Error("unreachable");

		// The asset row: custody paths, no bytes in JS, and it is audio.
		const asset = editor.media.getAssets().find((item) => item.id === committed.assetId);
		expect(asset).toBeDefined();
		expect(asset?.type).toBe("audio");
		expect(asset?.file.size).toBe(0);
		expect(asset?.duration).toBeCloseTo(1.5, 6);
		expect(asset?.hasAudio).toBe(true);
		expect(asset?.nativeRelativePath).toBe(TAKE.relativePath);
		expect(asset?.sourceNativeRelativePath).toBe(TAKE.relativePath);
		expect(asset?.voiceoverTakeId).toBe("voiceover-abc");
		expect(asset?.url).toBe(`webview:///sandbox/media/${TAKE.relativePath}`);
		// Persisted once, through the real command's storage path.
		expect(savedAssets.map((row) => row.id)).toContain(committed.assetId);

		// The element: audio track, right position, right duration, mediaId set.
		const scene = editor.scenes.getActiveScene();
		const track = scene.tracks.audio.find((item) => item.id === committed.trackId);
		const element = track?.elements.find((item) => item.id === committed.elementId);
		expect(element).toBeDefined();
		if (!element || element.type !== "audio") throw new Error("voiceover must be an audio element");
		expect(element.sourceType).toBe("upload");
		expect("mediaId" in element ? element.mediaId : null).toBe(committed.assetId);
		expect(mediaTimeToSeconds({ time: element.startTime })).toBeCloseTo(2, 6);
		expect(mediaTimeToSeconds({ time: element.duration })).toBeCloseTo(1.5, 6);
	});

	it("is one undo step: undo removes the clip and the row, redo restores both", async () => {
		const { editor } = bootstrap();
		const { source } = fakeSource();
		const projectId = editor.project.getActive().metadata.id;
		const committed = await commitVoiceoverTake({
			editor,
			projectId,
			source,
			take: TAKE,
			startSeconds: 0,
		});
		if (!committed) throw new Error("commit failed");

		editor.command.undo();
		expect(editor.media.getAssets().some((asset) => asset.id === committed.assetId)).toBe(false);
		expect(
			editor.scenes
				.getActiveScene()
				.tracks.audio.flatMap((track) => track.elements)
				.some((element) => element.id === committed.elementId),
		).toBe(false);

		editor.command.redo();
		expect(editor.media.getAssets().some((asset) => asset.id === committed.assetId)).toBe(true);
		const restored = editor.scenes
			.getActiveScene()
			.tracks.audio.flatMap((track) => track.elements)
			.find((element) => element.id === committed.elementId);
		expect(restored).toBeDefined();
		expect(
			restored?.type === "audio" && "mediaId" in restored ? restored.mediaId : null,
		).toBe(committed.assetId);
	});

	it("returns null (and inserts nothing) where the platform has no custody", async () => {
		const { editor } = bootstrap();
		const { source } = fakeSource({ root: null });
		const projectId = editor.project.getActive().metadata.id;
		const before = editor.media.getAssets().length;
		const committed = await commitVoiceoverTake({
			editor,
			projectId,
			source,
			take: TAKE,
			startSeconds: 0,
		});
		expect(committed).toBeNull();
		expect(editor.media.getAssets().length).toBe(before);
	});

	it("refuses a take too short to be a voiceover", async () => {
		const { editor } = bootstrap();
		const { source } = fakeSource();
		const projectId = editor.project.getActive().metadata.id;
		await expect(
			commitVoiceoverTake({
				editor,
				projectId,
				source,
				take: { ...TAKE, durationMs: 80 },
				startSeconds: 0,
			}),
		).rejects.toThrow(/too short/);
		expect(editor.media.getAssets().length).toBe(0);
	});

	it("generates take ids inside the voiceover namespace", () => {
		const id = newVoiceoverTakeId();
		expect(id.startsWith("voiceover-")).toBe(true);
		expect(id.length).toBeGreaterThan("voiceover-".length + 8);
	});
});

describe("voiceover custody sweep", () => {
	it("reports the referenced take paths and returns what native removed", async () => {
		const { editor } = bootstrap();
		const { source, prunes, removed } = fakeSource();
		const projectId = editor.project.getActive().metadata.id;
		await commitVoiceoverTake({ editor, projectId, source, take: TAKE, startSeconds: 0 });

		expect(referencedVoiceoverPaths(editor.media.getAssets())).toEqual([TAKE.relativePath]);
		const swept = await pruneUnusedVoiceoverTakes({ editor, source });
		expect(prunes).toEqual([[TAKE.relativePath]]);
		expect(swept).toEqual(removed);
	});

	it("is a no-op on a platform without the sweep", async () => {
		const { editor } = bootstrap();
		const source: VoiceoverSource = {
			async getMediaRoot() {
				return "/sandbox/media";
			},
			toPlaybackUri: (uri: string) => uri,
		};
		expect(await pruneUnusedVoiceoverTakes({ editor, source })).toEqual([]);
	});
});
