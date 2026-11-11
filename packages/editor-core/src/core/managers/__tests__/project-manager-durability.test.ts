import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { storageService } from "@/services/storage/service";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { ReplaceClipMediaCommand } from "@/commands/timeline/element/replace-clip-media";
import type { MediaAsset } from "@/media/types";
import type { ElementRef } from "@/timeline";

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

const SCENE_ID = "scene-pm-durability";

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
	return { editor, projectId: editor.project.getActive().metadata.id, mainTrackId: scene.tracks.main.id };
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

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("ProjectManager saveCurrentProject durability", () => {
	let editor: EditorCore;
	let projectId: string;
	let mainTrackId: string;
	let saveMediaSpy: ReturnType<typeof spyOn<typeof storageService, "saveMediaAsset">>;
	let saveProjectSpy: ReturnType<typeof spyOn<typeof storageService, "saveProject">>;
	let deleteMediaSpy: ReturnType<typeof spyOn<typeof storageService, "deleteMediaAsset">>;
	let waitSpy: ReturnType<typeof spyOn<typeof ReplaceClipMediaCommand, "waitForPendingMediaTransactions">> | null = null;

	beforeEach(() => {
		({ editor, projectId, mainTrackId } = bootstrap());
		saveMediaSpy = spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => undefined,
		);
		deleteMediaSpy = spyOn(storageService, "deleteMediaAsset").mockImplementation(
			async () => undefined,
		);
		ReplaceClipMediaCommand.resetPendingOperations();
	});

	afterEach(async () => {
		await ReplaceClipMediaCommand.flushPendingOperations();
		ReplaceClipMediaCommand.resetPendingOperations();
		waitSpy?.mockRestore();
		waitSpy = null;
		saveMediaSpy.mockRestore();
		saveProjectSpy?.mockRestore();
		deleteMediaSpy?.mockRestore();
		EditorCore.reset();
	});

	it("waits for a pending replacement media write before saving the project", async () => {
		const ref = insertVideo({ editor, trackId: mainTrackId, mediaId: "asset-original" });
		const d = deferred();
		saveMediaSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});

		saveProjectSpy = spyOn(storageService, "saveProject").mockImplementation(
			async () => undefined,
		);

		const savePromise = editor.project.saveCurrentProject();
		await new Promise((r) => setTimeout(r, 0));
		expect(saveProjectSpy).not.toHaveBeenCalled();

		d.resolve();
		await d.promise.catch(() => undefined);
		await savePromise;
		expect(saveProjectSpy).toHaveBeenCalled();
	});

	it("fails closed when a pending replacement media write fails", async () => {
		const ref = insertVideo({ editor, trackId: mainTrackId, mediaId: "asset-original" });
		const d = deferred();
		saveMediaSpy.mockImplementation(() => d.promise);

		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId,
				ref,
				asset: assetData({ id: "asset-fresh", duration: 10 }),
			}),
		});

		const savedProjects: unknown[] = [];
		saveProjectSpy = spyOn(storageService, "saveProject").mockImplementation(
			async ({ project }: { project: unknown }) => {
				savedProjects.push(project);
				return undefined;
			},
		);

		const savePromise = editor.project.saveCurrentProject();
		await new Promise((r) => setTimeout(r, 0));
		expect(saveProjectSpy).not.toHaveBeenCalled();

		d.reject(new Error("media write failed"));
		await d.promise.catch(() => undefined);
		await ReplaceClipMediaCommand.flushPendingOperations();
		await savePromise;

		// The failed replacement is compensated and the clip is restored to the
		// original media, so the consistent restored project may be persisted.
		// It must never retain a reference to the failed replacement media.
		expect(saveProjectSpy).toHaveBeenCalled();
		const serialized = JSON.stringify(savedProjects[0] ?? {});
		expect(serialized).toContain('"mediaId":"asset-original"');
		expect(serialized).not.toContain('"mediaId":"asset-fresh"');

		const scene = editor.scenes.getActiveScene();
		const track = scene.tracks.main;
		const element = track.elements.find(
			(candidate: { id?: string }) => candidate.id === ref.elementId,
		);
		expect(element?.mediaId).toBe("asset-original");
		expect(
			editor.media.getAssets().some((asset) => asset.id === "asset-fresh"),
		).toBe(false);
	});

	it("fails closed when the durability coordinator throws", async () => {
		saveProjectSpy = spyOn(storageService, "saveProject").mockImplementation(
			async () => undefined,
		);
		waitSpy = spyOn(
			ReplaceClipMediaCommand,
			"waitForPendingMediaTransactions",
		).mockImplementation(async () => {
			throw new Error("coordinator boom");
		});

		await editor.project.saveCurrentProject();
		expect(saveProjectSpy).not.toHaveBeenCalled();
	});

	it("retries the save when a replacement mutates during storage write", async () => {
		const ref = insertVideo({ editor, trackId: mainTrackId, mediaId: "asset-original" });
		saveMediaSpy.mockImplementation(async () => undefined);

		const saveDeferred = deferred();
		saveProjectSpy = spyOn(storageService, "saveProject").mockImplementation(
			() => saveDeferred.promise,
		);

		const savePromise = editor.project.saveCurrentProject();
		// Let the first storage write start.
		await new Promise((r) => setTimeout(r, 0));
		expect(saveProjectSpy).toHaveBeenCalledTimes(1);

		// Mutate while the storage write is in flight.
		const assetB = assetData({ id: "asset-replacement-b", duration: 10 });
		editor.command.execute({
			command: new ReplaceClipMediaCommand({
				projectId,
				ref,
				asset: assetB,
			}),
		});

		// Resolve the stale write; the version change forces a retry.
		saveDeferred.resolve();
		await saveDeferred.promise.catch(() => undefined);
		await savePromise;
		expect(saveProjectSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("retries a consistent read when mutation version changes during the read", async () => {
		const { editor, projectId, mainTrackId } = bootstrap();
		const ref = insertVideo({
			editor,
			trackId: mainTrackId,
			mediaId: "asset-original",
		});
		let readCalls = 0;
		const resultPromise = ReplaceClipMediaCommand.readConsistentSnapshot({
			projectId,
			read: async () => {
				readCalls++;
				if (readCalls === 1) {
					const bumpAsset = assetData({ id: "asset-version-bump", duration: 10 });
					editor.command.execute({
						command: new ReplaceClipMediaCommand({
							projectId,
							ref,
							asset: bumpAsset,
						}),
					});
				}
				return "value";
			},
		});

		const result = await resultPromise;
		expect(result).toBe("value");
		expect(readCalls).toBe(2);
	});
});
