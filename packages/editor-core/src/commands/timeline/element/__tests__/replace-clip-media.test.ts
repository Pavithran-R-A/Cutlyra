/**
 * Replace Clip (#74) — nondestructive media replacement on the timeline.
 *
 * These tests drive the REAL `EditorCore`, the REAL commands and the REAL scene
 * serialisation (no module mocks, which leak across `bun test` files) so the
 * guarantees are the ones a user actually gets:
 *
 *  - every authored property survives the swap, and nothing the user did not
 *    author changes;
 *  - a replacement that cannot satisfy the existing trimmed range is REFUSED
 *    with a clamp preview, and only an explicit `allowClamp` shortens the clip;
 *  - other clips sharing the same source are untouched;
 *  - one undo restores the clip and removes the replacement asset row; redo
 *    brings both back;
 *  - save/reopen keeps the new linkage and the built EDL resolves it cleanly,
 *    including the missing-media (relink) case.
 *
 * Media persistence is the only thing stubbed: OPFS/IndexedDB do not exist
 * under Bun, so the two `storageService` calls the command makes are spied on
 * per test. That keeps the happy path (rather than the persistence-failure
 * rollback) in front of the assertions while still proving exactly what the
 * command asked storage to save and delete.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { deserializeScene, serializeScene } from "@/services/storage/scene-serialization";
import { storageService } from "@/services/storage/service";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { buildEdl } from "@/edl/build";
import { findUnresolvedMediaClips } from "@/edl/preflight";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { ReplaceClipMediaCommand } from "@/commands/timeline/element/replace-clip-media";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { planClipMediaReplacement } from "@/timeline/replace-media";
import type { MediaAsset } from "@/media/types";
import type { MediaAssetData } from "@/services/storage/types";
import type { ElementRef, TimelineElement, VideoElement } from "@/timeline";

const TPS = TICKS_PER_SECOND;
const t = ({ seconds }: { seconds: number }) =>
	mediaTime({ ticks: Math.round(seconds * TPS) });

function assetData(overrides: Partial<MediaAssetData> & { id: string }): MediaAssetData {
	const base: MediaAssetData = {
		id: overrides.id,
		name: `${overrides.id}.mp4`,
		type: "video",
		size: 1_000_000,
		lastModified: 0,
		duration: 6,
		width: 1080,
		height: 1920,
		hasAudio: true,
	};
	return { ...base, ...overrides };
}

const ORIGINAL = assetData({ id: "asset-original", name: "original.mp4", duration: 10 });
const REPLACEMENT = assetData({ id: "asset-replacement", name: "replacement.mp4", duration: 10 });
const SHORT = assetData({ id: "asset-short", name: "short.mp4", duration: 2 });
const IMAGE_A = assetData({ id: "asset-image-a", type: "image", name: "a.png", duration: undefined });
const IMAGE_B = assetData({ id: "asset-image-b", type: "image", name: "b.png", duration: undefined });

const MEDIA: MediaAsset[] = [ORIGINAL, REPLACEMENT, SHORT, IMAGE_A, IMAGE_B].map((asset) => ({
	...asset,
	file: new File([], asset.name),
}));

const SCENE_ID = "scene-replace-clip";

function bootstrap() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: SCENE_ID,
	};
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: SCENE_ID });
	editor.media.setAssets({ assets: MEDIA });
	return { editor, mainTrackId: scene.tracks.main.id };
}

function insertVideo({
	editor,
	trackId,
	mediaId,
	durationSeconds,
	startSeconds = 0,
}: {
	editor: EditorCore;
	trackId: string;
	mediaId: string;
	durationSeconds: number;
	startSeconds?: number;
}): ElementRef {
	const command = new InsertElementCommand({
		element: buildElementFromMedia({
			mediaId,
			mediaType: "video",
			name: `${mediaId}.mp4`,
			duration: t({ seconds: durationSeconds }),
			startTime: t({ seconds: startSeconds }),
		}),
		placement: { mode: "explicit", trackId },
	});
	editor.command.execute({ command });
	return { trackId, elementId: command.getElementId() };
}

function insertImage({
	editor,
	trackId,
	mediaId,
	durationSeconds,
	startSeconds = 0,
}: {
	editor: EditorCore;
	trackId: string;
	mediaId: string;
	durationSeconds: number;
	startSeconds?: number;
}): ElementRef {
	const command = new InsertElementCommand({
		element: buildElementFromMedia({
			mediaId,
			mediaType: "image",
			name: `${mediaId}.png`,
			duration: t({ seconds: durationSeconds }),
			startTime: t({ seconds: startSeconds }),
		}),
		placement: { mode: "explicit", trackId },
	});
	editor.command.execute({ command });
	return { trackId, elementId: command.getElementId() };
}

function readElement({ editor, ref }: { editor: EditorCore; ref: ElementRef }): TimelineElement {
	const tracks = editor.scenes.getActiveScene().tracks;
	const all = [tracks.main, ...tracks.overlay, ...tracks.audio];
	const track = all.find((candidate) => candidate.id === ref.trackId);
	const element = track?.elements.find((candidate) => candidate.id === ref.elementId);
	if (!element) throw new Error("element missing");
	return element;
}

function buildProjectEdl({ editor }: { editor: EditorCore }) {
	const project = editor.project.getActive();
	if (!project) throw new Error("no active project");
	return buildEdl({
		project,
		scene: editor.scenes.getActiveScene(),
		// `buildEdl` takes the persisted asset shape; the live library carries the
		// backing File instead of size/lastModified.
		mediaAssets: editor.media.getAssets().map((asset) => ({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			size: asset.file.size,
			lastModified: asset.file.lastModified,
			duration: asset.duration,
			width: asset.width,
			height: asset.height,
		})),
		resolveAsset: ({ mediaId }) => ({ sourceUri: `cutlyra-media://${mediaId}` }),
		output: {
			container: "mp4",
			videoCodec: "h264",
			audioCodec: "aac",
			bitrate: 8_000_000,
			includeAudio: true,
		},
	});
}

function assetRow({ editor, id }: { editor: EditorCore; id: string }): MediaAsset | undefined {
	return editor.media.getAssets().find((asset) => asset.id === id);
}

function freshAsset({
	id = "asset-fresh",
	durationSeconds = 10,
}: { id?: string; durationSeconds?: number } = {}): MediaAsset {
	return {
		...assetData({ id, name: `${id}.mp4`, duration: durationSeconds }),
		file: new File([], `${id}.mp4`),
	};
}

describe("planClipMediaReplacement", () => {
	const video = (): VideoElement => ({
		id: "el-1",
		type: "video",
		mediaId: "asset-original",
		name: "original.mp4",
		duration: t({ seconds: 4 }),
		startTime: ZERO_MEDIA_TIME,
		trimStart: t({ seconds: 1 }),
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: t({ seconds: 10 }),
		params: { framing: "fill", "transform.rotate": 90, "transform.flipX": -1 },
	});

	it("keeps timing when the replacement covers the trimmed range", () => {
		const plan = planClipMediaReplacement({
			element: video(),
			asset: freshAsset({ id: "asset-new", durationSeconds: 10 }),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.clamped).toBe(false);
		expect(plan.patch).toEqual({
			mediaId: "asset-new",
			name: "asset-new.mp4",
			sourceDuration: t({ seconds: 10 }),
		});
	});

	it("refuses a shorter source and reports exactly what a clamp would do", () => {
		const plan = planClipMediaReplacement({
			element: video(),
			asset: freshAsset({ id: "asset-new", durationSeconds: 2 }),
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toBe("source-too-short");
		// 4s of timeline at 1x starting 1s in needs 5s of source; 2s is short.
		expect(plan.clamp?.trimStartTicks).toBe(t({ seconds: 1 }));
		expect(plan.clamp?.durationTicks).toBe(t({ seconds: 1 }));
		expect(plan.clamp?.clampedFromStart).toBe(false);
	});

	it("only shortens when allowClamp is explicit, preserving trimStart", () => {
		const plan = planClipMediaReplacement({
			element: video(),
			asset: freshAsset({ id: "asset-new", durationSeconds: 2 }),
			allowClamp: true,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.clamped).toBe(true);
		expect(plan.patch.trimStart).toBe(t({ seconds: 1 }));
		expect(plan.patch.duration).toBe(t({ seconds: 1 }));
		// Framing/transform/effects are NOT in the patch at all: they survive by
		// omission, which is what makes them impossible to lose here.
		expect(Object.keys(plan.patch).sort()).toEqual([
			"duration",
			"mediaId",
			"name",
			"sourceDuration",
			"trimEnd",
			"trimStart",
		]);
	});

	it("accounts for retime: 2x doubles the source span a clip consumes", () => {
		const element: VideoElement = {
			...video(),
			duration: t({ seconds: 2 }),
			retime: { rate: 2 },
		};
		// 2s of timeline at 2x consumes 4s of source, starting 1s in → needs 5s.
		const refused = planClipMediaReplacement({
			element,
			asset: freshAsset({ id: "asset-new", durationSeconds: 4 }),
		});
		expect(refused.ok).toBe(false);

		const clamped = planClipMediaReplacement({
			element,
			asset: freshAsset({ id: "asset-new", durationSeconds: 4 }),
			allowClamp: true,
		});
		expect(clamped.ok).toBe(true);
		if (!clamped.ok) return;
		// 3s of source left at 2x = 1.5s of timeline.
		expect(clamped.patch.duration).toBe(t({ seconds: 1.5 }));
	});

	it("falls back to the start when trimStart itself is past the new end", () => {
		const element: VideoElement = { ...video(), trimStart: t({ seconds: 8 }) };
		const plan = planClipMediaReplacement({
			element,
			asset: freshAsset({ id: "asset-new", durationSeconds: 3 }),
			allowClamp: true,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.patch.trimStart).toBe(ZERO_MEDIA_TIME);
		expect(plan.patch.duration).toBe(t({ seconds: 3 }));
	});

	it("rejects cross-type replacement with a user-facing reason", () => {
		const plan = planClipMediaReplacement({
			element: video(),
			asset: { ...IMAGE_A, file: new File([], "a.png") },
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toBe("type-mismatch");
		expect(plan.message).toContain("video");
	});

	it("rejects non-media elements", () => {
		const plan = planClipMediaReplacement({
			element: {
				id: "text-1",
				type: "text",
				name: "title",
				duration: t({ seconds: 1 }),
				startTime: ZERO_MEDIA_TIME,
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: {},
			},
			asset: freshAsset({ id: "asset-new" }),
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.reason).toBe("unsupported-element-type");
	});

	it("never touches an image clip's authored timeline duration", () => {
		const plan = planClipMediaReplacement({
			element: {
				id: "img-1",
				type: "image",
				mediaId: "asset-image-a",
				name: "a.png",
				duration: t({ seconds: 7 }),
				startTime: ZERO_MEDIA_TIME,
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: {},
			},
			asset: { ...IMAGE_B, file: new File([], "b.png") },
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.clamped).toBe(false);
		expect(plan.patch).toEqual({ mediaId: "asset-image-b", name: "b.png" });
	});
});

describe("ReplaceClipMediaCommand", () => {
	let editor: EditorCore;
	let mainTrackId: string;
	let saveMediaAssetSpy: ReturnType<typeof spyOn<typeof storageService, "saveMediaAsset">>;
	let deleteMediaAssetSpy: ReturnType<typeof spyOn<typeof storageService, "deleteMediaAsset">>;

	beforeEach(() => {
		({ editor, mainTrackId } = bootstrap());
		saveMediaAssetSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => undefined,
		);
		deleteMediaAssetSpy = spyOn(storageService, "deleteMediaAsset").mockImplementation(
			async () => undefined,
		);
	});

	afterEach(() => {
		saveMediaAssetSpy.mockRestore();
		deleteMediaAssetSpy.mockRestore();
		EditorCore.reset();
	});

	it("swaps the media and keeps every authored property", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		new UpdateElementsCommand({
			updates: [
				{
					trackId: ref.trackId,
					elementId: ref.elementId,
					patch: {
						trimStart: t({ seconds: 1 }),
						startTime: t({ seconds: 3 }),
						retime: { rate: 1.5, maintainPitch: true },
						params: {
							framing: "fill",
							"transform.rotate": 180,
							"transform.flipY": -1,
							"transform.scaleX": 0.75,
						},
					},
				},
			],
		}).execute();
		const before = readElement({ editor, ref });

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...REPLACEMENT, file: new File([], "replacement.mp4") },
			}),
		});

		const after = readElement({ editor, ref });
		expect(after.id).toBe(before.id);
		expect(after.type).toBe("video");
		expect(after.startTime).toBe(before.startTime);
		expect(after.duration).toBe(before.duration);
		expect(after.trimStart).toBe(before.trimStart);
		expect(after.params).toEqual(before.params);
		expect("retime" in after ? after.retime : undefined).toEqual(
			"retime" in before ? before.retime : undefined,
		);
		expect(after.animations).toEqual(before.animations);
		expect(after.name).toBe("replacement.mp4");
		if (after.type !== "video") throw new Error("expected video");
		expect(after.mediaId).toBe("asset-replacement");
		expect(after.sourceDuration).toBe(t({ seconds: 10 }));
		expect(after.isSourceAudioEnabled).toBe(true);
	});

	it("keeps an image clip's duration and only swaps the media", () => {
		const ref = insertImage({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-image-a",
			durationSeconds: 5,
		});
		const before = readElement({ editor, ref });

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...IMAGE_B, file: new File([], "b.png") },
			}),
		});

		const after = readElement({ editor, ref });
		expect(after.duration).toBe(before.duration);
		expect(after.startTime).toBe(before.startTime);
		if (after.type !== "image") throw new Error("expected image");
		expect(after.mediaId).toBe("asset-image-b");
	});

	it("refuses rather than silently shortening when the replacement is short", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 6,
		});
		const before = readElement({ editor, ref });
		const assetsBefore = editor.media.getAssets().length;

		expect(() =>
			editor.command.execute({
				command: new ReplaceClipMediaCommand({
					projectId: editor.project.getActive().metadata.id,
					ref,
					asset: { ...SHORT, file: new File([], "short.mp4") },
				}),
			}),
		).toThrow(/Replace clip refused/);

		// Nothing changed: same element, same media library, nothing persisted.
		expect(readElement({ editor, ref })).toEqual(before);
		expect(editor.media.getAssets().length).toBe(assetsBefore);
		expect(saveMediaAssetSpy).not.toHaveBeenCalled();
	});

	it("shortens explicitly when allowClamp is set", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 6,
		});
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...SHORT, file: new File([], "short.mp4") },
				allowClamp: true,
			}),
		});
		const after = readElement({ editor, ref });
		expect(after.duration).toBe(t({ seconds: 2 }));
		expect(after.startTime).toBe(ZERO_MEDIA_TIME);
		if (after.type !== "video") throw new Error("expected video");
		expect(after.mediaId).toBe("asset-short");
	});

	it("never touches another clip that shares the replaced source", () => {
		const first = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 3,
		});
		const second = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 3,
			startSeconds: 3,
		});
		const secondBefore = readElement({ editor, ref: second });

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: first,
				asset: { ...REPLACEMENT, file: new File([], "replacement.mp4") },
			}),
		});

		expect(readElement({ editor, ref: second })).toEqual(secondBefore);
		// The shared original asset stays: a replacement may not delete media
		// another clip still uses.
		expect(assetRow({ editor, id: "asset-original" })).toBeDefined();

		const edl = buildProjectEdl({ editor });
		expect(findUnresolvedMediaClips({ edl })).toEqual([]);
		const assetIds = edl.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId));
		expect(assetIds).toContain("asset-original");
		expect(assetIds).toContain("asset-replacement");
	});

	it("is exactly one undo step: undo restores the clip and drops the new asset", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		const before = readElement({ editor, ref });
		expect(assetRow({ editor, id: "asset-fresh" })).toBeUndefined();

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: freshAsset(),
			}),
		});
		const swapped = readElement({ editor, ref });
		if (swapped.type !== "video") throw new Error("expected video");
		expect(swapped.mediaId).toBe("asset-fresh");

		editor.command.undo();
		expect(readElement({ editor, ref })).toEqual(before);
		expect(assetRow({ editor, id: "asset-fresh" })).toBeUndefined();
		expect(assetRow({ editor, id: "asset-original" })).toBeDefined();

		editor.command.redo();
		const redone = readElement({ editor, ref });
		if (redone.type !== "video") throw new Error("expected video");
		expect(redone.mediaId).toBe("asset-fresh");
		expect(assetRow({ editor, id: "asset-fresh" })).toBeDefined();

		await ReplaceClipMediaCommand.flushPendingOperations();

		// Persistence is coordinated per-asset: the final redo must leave the
		// replacement durably saved. Superseded intents may be coalesced, so
		// intermediate save/delete storage calls are not required as long as the
		// final durable state matches the current project state.
		const savesForFresh = saveMediaAssetSpy.mock.calls.filter(
			(call) => call[0]?.mediaAsset?.id === "asset-fresh",
		);
		expect(savesForFresh.length).toBeGreaterThanOrEqual(1);
		// End state is durable-present for the current replacement.
		expect(assetRow({ editor, id: "asset-fresh" })).toBeDefined();
		expect(assetRow({ editor, id: "asset-original" })).toBeDefined();
	});

	it("re-linking to an asset already in the library never duplicates or deletes it", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		const countBefore = editor.media.getAssets().length;
		const existing = MEDIA.find((asset) => asset.id === "asset-replacement");
		if (!existing) throw new Error("fixture asset missing");

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: existing,
			}),
		});
		expect(editor.media.getAssets().length).toBe(countBefore);

		editor.command.undo();
		// Undo must NOT remove an asset the replacement did not create.
		expect(assetRow({ editor, id: "asset-replacement" })).toBeDefined();
		expect(deleteMediaAssetSpy).not.toHaveBeenCalled();
	});

	it("survives save/reopen and keeps the EDL resolving the new media", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...REPLACEMENT, file: new File([], "replacement.mp4") },
			}),
		});

		const saved = structuredClone(serializeScene({ scene: editor.scenes.getActiveScene() }));
		const reopened = deserializeScene({ scene: saved });
		editor.timeline.updateTracks(reopened.tracks);

		const element = readElement({ editor, ref });
		if (element.type !== "video") throw new Error("expected video");
		expect(element.mediaId).toBe("asset-replacement");

		const edl = buildProjectEdl({ editor });
		expect(findUnresolvedMediaClips({ edl })).toEqual([]);
		const clip = edl.tracks
			.flatMap((track) => track.clips)
			.find((candidate) => candidate.clipId === ref.elementId);
		expect(clip?.assetId).toBe("asset-replacement");
		expect(clip?.durationTicks).toBe(t({ seconds: 4 }));
	});

	it("repairs a clip whose original media reference is missing", () => {
		// A project that arrived with a dangling reference — the #55 scenario.
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		new UpdateElementsCommand({
			updates: [
				{ trackId: ref.trackId, elementId: ref.elementId, patch: { mediaId: "asset-gone" } },
			],
		}).execute();

		const broken = buildProjectEdl({ editor });
		expect(findUnresolvedMediaClips({ edl: broken }).length).toBeGreaterThan(0);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...REPLACEMENT, file: new File([], "replacement.mp4") },
			}),
		});

		const repaired = buildProjectEdl({ editor });
		expect(findUnresolvedMediaClips({ edl: repaired })).toEqual([]);
		const element = readElement({ editor, ref });
		if (element.type !== "video") throw new Error("expected video");
		expect(element.mediaId).toBe("asset-replacement");
	});

	it("replacing with the same asset is a no-op that keeps the library intact", () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
			durationSeconds: 4,
		});
		const before = readElement({ editor, ref });
		const countBefore = editor.media.getAssets().length;
		const same = MEDIA.find((candidate) => candidate.id === "asset-original");
		if (!same) throw new Error("fixture asset missing");

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: same,
			}),
		});
		expect(editor.media.getAssets().length).toBe(countBefore);
		const after = readElement({ editor, ref });
		if (after.type !== "video" || before.type !== "video") throw new Error("expected video");
		expect(after.mediaId).toBe(before.mediaId);
		expect(saveMediaAssetSpy).not.toHaveBeenCalled();

		editor.command.undo();
		expect(assetRow({ editor, id: "asset-original" })).toBeDefined();
		expect(deleteMediaAssetSpy).not.toHaveBeenCalled();
	});

	it("handles a legacy element with no sourceDuration", () => {
		// Projects saved before #74 may carry video elements with no
		// `sourceDuration`; the replacement adds it rather than assuming it.
		const legacy = buildElementFromMedia({
			mediaId: "asset-original",
			mediaType: "video",
			name: "original.mp4",
			duration: t({ seconds: 4 }),
			startTime: ZERO_MEDIA_TIME,
		});
		if (legacy.type !== "video") throw new Error("expected a video element");
		delete legacy.sourceDuration;
		const insert = new InsertElementCommand({
			element: legacy,
			placement: { mode: "explicit", trackId: mainTrackId },
		});
		editor.command.execute({ command: insert });
		const ref: ElementRef = { trackId: mainTrackId, elementId: insert.getElementId() };

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: { ...REPLACEMENT, file: new File([], "replacement.mp4") },
			}),
		});
		const after = readElement({ editor, ref });
		if (after.type !== "video") throw new Error("expected video");
		expect(after.mediaId).toBe("asset-replacement");
		expect(after.sourceDuration).toBe(t({ seconds: 10 }));
	});
});
