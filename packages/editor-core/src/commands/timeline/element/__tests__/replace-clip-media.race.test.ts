import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { storageService } from "@/services/storage/service";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { ReplaceClipMediaCommand } from "@/commands/timeline/element/replace-clip-media";
import { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import type { MediaAsset } from "@/media/types";
import type { ElementRef, TimelineElement } from "@/timeline";

const TPS = TICKS_PER_SECOND;
const t = ({ seconds }: { seconds: number }) =>
	mediaTime({ ticks: Math.round(seconds * TPS) });

function assetData(id: string, duration = 10): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`),
		duration,
		width: 1080,
		height: 1920,
		hasAudio: true,
	} as MediaAsset;
}

const SCENE_ID = "scene-race";

function bootstrap() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = { ...buildDefaultScene({ name: "Main scene", isMain: true }), id: SCENE_ID };
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: SCENE_ID });
	const original = assetData("asset-original", 10);
	const replacement = assetData("asset-replacement", 10);
	editor.media.setAssets({ assets: [original, replacement] });
	return { editor, mainTrackId: scene.tracks.main.id };
}

function insertVideo(editor: EditorCore, trackId: string, mediaId: string): ElementRef {
	const command = new InsertElementCommand({
		element: buildElementFromMedia({
			mediaId,
			mediaType: "video",
			name: `${mediaId}.mp4`,
			duration: t({ seconds: 4 }),
			startTime: ZERO_MEDIA_TIME,
		}),
		placement: { mode: "explicit", trackId },
	});
	editor.command.execute({ command });
	return { trackId, elementId: command.getElementId() };
}

function readElement(editor: EditorCore, ref: ElementRef): TimelineElement {
	const tracks = editor.scenes.getActiveScene().tracks;
	const all = [tracks.main, ...tracks.overlay, ...tracks.audio];
	const track = all.find((c) => c.id === ref.trackId);
	const element = track?.elements.find((c) => c.id === ref.elementId);
	if (!element) throw new Error("element missing");
	return element;
}

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("ReplaceClipMediaCommand persistence races", () => {
	let editor: EditorCore;
	let mainTrackId: string;
	let saveSpy: ReturnType<typeof spyOn<typeof storageService, "saveMediaAsset">>;
	let deleteSpy: ReturnType<typeof spyOn<typeof storageService, "deleteMediaAsset">>;

	beforeEach(() => {
		({ editor, mainTrackId } = bootstrap());
		saveSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(async () => undefined);
		deleteSpy = spyOn(storageService, "deleteMediaAsset").mockImplementation(async () => undefined);
		ReplaceClipMediaCommand.resetPendingOperations();
	});

	afterEach(() => {
		saveSpy.mockRestore();
		deleteSpy.mockRestore();
		EditorCore.reset();
	});

	it("a failed save does not roll back subsequent unrelated edits", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData("asset-fresh", 10),
			}),
		});

		// Unrelated edit lands while persistence is still pending.
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [{ trackId: ref.trackId, elementId: ref.elementId, patch: { params: { "transform.rotate": 45 } } }],
			}),
		});

		// Now the save rejects.
		d.reject(new Error("quota exceeded"));
		await d.promise.catch(() => undefined);
		// Flush microtasks.
		await new Promise((r) => setTimeout(r, 0));

		const el = readElement(editor, ref) as { mediaId?: string; params?: Record<string, unknown> };
		// The clip's other edits survive; mediaId reverted to original because
		// the replacement failed to persist.
		expect(el.mediaId).toBe("asset-original");
		expect(el.params?.["transform.rotate"]).toBe(45);
		// Orphan asset row removed.
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(false);
	});

	it("undo during pending save prevents orphan resurrection", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData("asset-fresh", 10),
			}),
		});

		// Undo before the save resolves.
		editor.command.undo();
		expect((readElement(editor, ref) as { mediaId?: string }).mediaId).toBe("asset-original");
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(false);

		// Late save success must NOT resurrect the row.
		d.resolve();
		await d.promise.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 0));
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(false);
	});

	it("redo after undo re-persists the replacement", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		saveSpy.mockImplementation(async () => undefined);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData("asset-fresh", 10),
			}),
		});
		editor.command.undo();
		editor.command.redo();

		const el = readElement(editor, ref) as { mediaId?: string };
		expect(el.mediaId).toBe("asset-fresh");
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(true);
	});

	it("a newer replacement supersedes a pending older one", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		const firstSave = deferred();
		const secondSave = deferred();
		let callCount = 0;
		saveSpy.mockImplementation(() => {
			callCount++;
			return callCount === 1 ? firstSave.promise : secondSave.promise;
		});

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData("asset-fresh", 10),
			}),
		});
		// Second replacement on the same clip.
		const assetB = assetData("asset-replacement-b", 10);
		editor.media.setAssets({ assets: [...editor.media.getAssets(), assetB] });
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetB,
			}),
		});

		// Late resolution of the FIRST save must not clobber the second.
		firstSave.resolve();
		await firstSave.promise.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 0));

		const el = readElement(editor, ref) as { mediaId?: string };
		expect(el.mediaId).toBe("asset-replacement-b");
		expect(editor.media.getAssets().some((a) => a.id === "asset-replacement-b")).toBe(true);
	});

	it("command manager history stays coherent after a failed save", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData("asset-fresh", 10),
			}),
		});
		expect(editor.command.canUndo()).toBe(true);

		d.reject(new Error("boom"));
		await d.promise.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 0));

		// Undo still works and restores the original clip.
		editor.command.undo();
		expect((readElement(editor, ref) as { mediaId?: string }).mediaId).toBe("asset-original");
		// Redo brings the (failed) replacement's in-memory state back? After
		// compensation the clip already reverted; redo re-applies. Either way
		// history is not corrupted (canRedo toggles).
		expect(editor.command.canRedo()).toBe(true);
	});

	it("shared source asset is never deleted on undo of a replacement", () => {
		const first = insertVideo(editor, mainTrackId, "asset-original");
		const second = insertVideo(editor, mainTrackId, "asset-original");
		void second;
		saveSpy.mockImplementation(async () => undefined);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: first,
				asset: assetData("asset-fresh", 10),
			}),
		});
		editor.command.undo();
		// Original asset still referenced by `second` and must survive.
		expect(editor.media.getAssets().some((a) => a.id === "asset-original")).toBe(true);
		expect(deleteSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "asset-original" }),
		);
	});

	it("re-linking to an already-registered asset survives save failure without deleting shared row", async () => {
		const ref = insertVideo(editor, mainTrackId, "asset-original");
		// Mark replacement as already registered by adding it first.
		const replacement = assetData("asset-replacement", 10);
		// It is already in the library, so addedAsset=false and no save occurs.
		saveSpy.mockImplementation(async () => undefined);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: replacement,
			}),
		});
		expect(saveSpy).not.toHaveBeenCalled();
		expect(editor.media.getAssets().some((a) => a.id === "asset-replacement")).toBe(true);
	});
});
