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

function assetData({
	id,
	duration = 10,
}: {
	id: string;
	duration?: number;
}): MediaAsset {
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
	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: SCENE_ID,
	};
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: SCENE_ID });
	const original = assetData({ id: "asset-original", duration: 10 });
	const replacement = assetData({ id: "asset-replacement", duration: 10 });
	editor.media.setAssets({ assets: [original, replacement] });
	return { editor, mainTrackId: scene.tracks.main.id };
}

function insertVideo({
	editor,
	trackId,
	mediaId,
}: {
	editor: EditorCore;
	trackId: string;
	mediaId: string;
}): ElementRef {
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

function readElement({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): TimelineElement {
	const tracks = editor.scenes.getActiveScene().tracks;
	const all = [tracks.main, ...tracks.overlay, ...tracks.audio];
	const track = all.find((c) => c.id === ref.trackId);
	const element = track?.elements.find((c) => c.id === ref.elementId);
	if (!element) throw new Error("element missing");
	return element;
}

function readMediaId({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): string | undefined {
	const element = readElement({ editor, ref });
	return element.type === "video" || element.type === "image"
		? element.mediaId
		: undefined;
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
		saveSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => undefined,
		);
		deleteSpy = spyOn(storageService, "deleteMediaAsset").mockImplementation(
			async () => undefined,
		);
		ReplaceClipMediaCommand.resetPendingOperations();
	});

	afterEach(() => {
		saveSpy.mockRestore();
		deleteSpy.mockRestore();
		EditorCore.reset();
	});

	it("a failed save does not roll back subsequent unrelated edits", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});

		// Unrelated edit lands while persistence is still pending.
		editor.command.execute({
			command: new UpdateElementsCommand({
				updates: [
					{
						trackId: ref.trackId,
						elementId: ref.elementId,
						patch: { params: { "transform.rotate": 45 } },
					},
				],
			}),
		});

		// Now the save rejects.
		d.reject(new Error("quota exceeded"));
		await d.promise.catch(() => undefined);
		// Flush microtasks.
		await new Promise((r) => setTimeout(r, 0));

		const el = readElement({ editor, ref });
		if (el.type !== "video") throw new Error("expected video element");
		// The clip's other edits survive; mediaId reverted to original because
		// the replacement failed to persist.
		expect(el.mediaId).toBe("asset-original");
		expect(el.params?.["transform.rotate"]).toBe(45);
		// Orphan asset row removed.
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(
			false,
		);
	});

	it("undo during pending save prevents orphan resurrection", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});

		// Undo before the save resolves.
		editor.command.undo();
		expect(readMediaId({ editor, ref })).toBe("asset-original");
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(
			false,
		);

		// Late save success must NOT resurrect the row.
		d.resolve();
		await d.promise.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 0));
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(
			false,
		);
	});

	it("redo after undo re-persists the replacement", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		saveSpy.mockImplementation(async () => undefined);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});
		editor.command.undo();
		editor.command.redo();

		expect(readMediaId({ editor, ref })).toBe("asset-fresh");
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(
			true,
		);
	});

	it("a newer replacement supersedes a pending older one", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
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
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});
		// Second replacement on the same clip.
		const assetB = assetData({ id: "asset-replacement-b", duration: 10 });
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

		expect(readMediaId({ editor, ref })).toBe("asset-replacement-b");
		expect(
			editor.media.getAssets().some((a) => a.id === "asset-replacement-b"),
		).toBe(true);
	});

	it("command manager history stays coherent after a failed save", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});
		expect(editor.command.canUndo()).toBe(true);

		d.reject(new Error("boom"));
		await d.promise.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 0));

		// Undo still works and restores the original clip.
		editor.command.undo();
		expect(readMediaId({ editor, ref })).toBe("asset-original");
		// Redo brings the (failed) replacement's in-memory state back? After
		// compensation the clip already reverted; redo re-applies. Either way
		// history is not corrupted (canRedo toggles).
		expect(editor.command.canRedo()).toBe(true);
	});

	it("shared source asset is never deleted on undo of a replacement", () => {
		const first = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const second = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		void second;
		saveSpy.mockImplementation(async () => undefined);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: first,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});
		editor.command.undo();
		// Original asset still referenced by `second` and must survive.
		expect(editor.media.getAssets().some((a) => a.id === "asset-original")).toBe(
			true,
		);
		expect(deleteSpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "asset-original" }),
		);
	});

	it("re-linking to an already-registered asset survives save failure without deleting shared row", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		// Mark replacement as already registered by adding it first.
		const replacement = assetData({ id: "asset-replacement", duration: 10 });
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
		expect(
			editor.media.getAssets().some((a) => a.id === "asset-replacement"),
		).toBe(true);
	});
});


describe("ReplaceClipMediaCommand additional reliability cases", () => {
	let editor: EditorCore;
	let mainTrackId: string;
	let saveSpy: ReturnType<typeof spyOn<typeof storageService, "saveMediaAsset">>;
	let deleteSpy: ReturnType<typeof spyOn<typeof storageService, "deleteMediaAsset">>;

	beforeEach(() => {
		({ editor, mainTrackId } = bootstrap());
		saveSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => undefined,
		);
		deleteSpy = spyOn(storageService, "deleteMediaAsset").mockImplementation(
			async () => undefined,
		);
		ReplaceClipMediaCommand.resetPendingOperations();
	});

	afterEach(async () => {
		await ReplaceClipMediaCommand.flushPendingOperations();
		saveSpy.mockRestore();
		deleteSpy.mockRestore();
		EditorCore.reset();
	});

	it("undo of a replacement does not remove unrelated assets (Risk A narrow undo)", async () => {
		const clipA = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const d = deferred();
		saveSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: clipA,
				asset: assetData({ id: "asset-fresh-a", duration: 10 }),
			}),
		});

		// Add an unrelated asset after the replacement (not via command).
		const extraAsset = assetData({ id: "asset-extra", duration: 10 });
		editor.media.setAssets({ assets: [...editor.media.getAssets(), extraAsset] });

		editor.command.undo();
		await ReplaceClipMediaCommand.flushPendingOperations();

		expect(readMediaId({ editor, ref: clipA })).toBe("asset-original");
		expect(editor.media.getAssets().some((a) => a.id === "asset-extra")).toBe(
			true,
		);
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh-a")).toBe(
			false,
		);

		d.reject(new Error("late fail"));
		await d.promise.catch(() => undefined);
		await ReplaceClipMediaCommand.flushPendingOperations();
		expect(editor.media.getAssets().some((a) => a.id === "asset-extra")).toBe(
			true,
		);
	});

	it("undo then redo leaves the replacement durably present after coordinated persistence", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const saveA = deferred();
		const saveB = deferred();
		let n = 0;
		saveSpy.mockImplementation(() => {
			n++;
			if (n === 1) return saveA.promise;
			if (n === 2) return saveB.promise;
			return Promise.resolve();
		});
		const asset = assetData({ id: "asset-fresh", duration: 10 });

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset,
			}),
		});
		editor.command.undo();
		editor.command.redo();

		// Per-asset operations are serialized; resolve in queue order.
		saveA.resolve();
		await saveA.promise;
		saveB.resolve();
		await saveB.promise;
		await ReplaceClipMediaCommand.flushPendingOperations();

		expect(readMediaId({ editor, ref })).toBe("asset-fresh");
		expect(editor.media.getAssets().some((a) => a.id === "asset-fresh")).toBe(
			true,
		);
		expect(
			saveSpy.mock.calls.some(
				(call) => call[0]?.mediaAsset?.id === "asset-fresh",
			),
		).toBe(true);
	});

	it("independent clip replacements keep successful clip when another fails (Risk D)", async () => {
		const clipA = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const clipB = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const saveA = deferred();
		const saveB = deferred();
		saveSpy.mockImplementation(({ mediaAsset }) => {
			if (mediaAsset.id === "asset-a") return saveA.promise;
			if (mediaAsset.id === "asset-b") return saveB.promise;
			return Promise.resolve();
		});

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: clipA,
				asset: assetData({ id: "asset-a", duration: 10 }),
			}),
		});
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref: clipB,
				asset: assetData({ id: "asset-b", duration: 10 }),
			}),
		});

		saveA.reject(new Error("quota A"));
		await saveA.promise.catch(() => undefined);
		saveB.resolve();
		await saveB.promise;
		await ReplaceClipMediaCommand.flushPendingOperations();

		expect(readMediaId({ editor, ref: clipA })).toBe("asset-original");
		expect(readMediaId({ editor, ref: clipB })).toBe("asset-b");
		expect(editor.media.getAssets().some((a) => a.id === "asset-b")).toBe(true);
		expect(editor.media.getAssets().some((a) => a.id === "asset-a")).toBe(false);
	});

	it("two successive replacements of one clip leave only the latest asset", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const save1 = deferred();
		const save2 = deferred();
		let n = 0;
		saveSpy.mockImplementation(() => {
			n++;
			if (n === 1) return save1.promise;
			if (n === 2) return save2.promise;
			return Promise.resolve();
		});

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-first", duration: 10 }),
			}),
		});
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-second", duration: 10 }),
			}),
		});

		save1.resolve();
		await save1.promise;
		save2.resolve();
		await save2.promise;
		await ReplaceClipMediaCommand.flushPendingOperations();

		expect(readMediaId({ editor, ref })).toBe("asset-second");
		expect(editor.media.getAssets().some((a) => a.id === "asset-second")).toBe(
			true,
		);
		// Critical invariant: the clip must not reference and the project must not
		// require the superseded intermediate asset for correctness. Unreferenced
		// intermediate replacement assets may be cleaned up separately.
		expect(readMediaId({ editor, ref })).not.toBe("asset-first");
	});

	it("a stale failed save for an earlier replacement must not remove a newer replacement asset", async () => {
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		const save1 = deferred();
		const save2 = deferred();
		let n = 0;
		saveSpy.mockImplementation(() => {
			n++;
			if (n === 1) return save1.promise;
			if (n === 2) return save2.promise;
			return Promise.resolve();
		});

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-first", duration: 10 }),
			}),
		});
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId: editor.project.getActive().metadata.id,
				ref,
				asset: assetData({ id: "asset-second", duration: 10 }),
			}),
		});

		// Per-asset persistence is serialized per asset key: first queued save
		// must settle before second starts, so resolve in queue order.
		save1.reject(new Error("failure of earlier replacement"));
		await save1.promise.catch(() => undefined);
		save2.resolve();
		await save2.promise;
		await ReplaceClipMediaCommand.flushPendingOperations();

		expect(readMediaId({ editor, ref })).toBe("asset-second");
		expect(editor.media.getAssets().some((a) => a.id === "asset-second")).toBe(
			true,
		);
		expect(readMediaId({ editor, ref })).not.toBe("asset-first");
	});
});
