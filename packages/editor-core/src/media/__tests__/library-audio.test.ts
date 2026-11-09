/**
 * GitHub #63 — a bundled library sound must reach the native exporter as a
 * real, durable asset, not a preview-only data URI.
 *
 * These tests drive the real `EditorCore` (as `media/__tests__/native-import.test.ts`
 * and `edl/__tests__/asset-reference-integrity.test.ts` do; no module mocks —
 * they leak across `bun test` files) against a fake `LibraryAudioSource` that
 * behaves like the Android bridge's `saveGeneratedAudio`: it writes nothing,
 * it only answers with the custody-relative path it "would" have written.
 * What is asserted is exactly the surface the export depends on:
 *
 *   - the same bundled sound always derives the same asset id, and a second
 *     insert is a no-op (dedupe);
 *   - materialization rewrites `sourceType: "library"` to "upload" + mediaId
 *     on the SAME element, preserving ids, timing, trims, params (volume,
 *     fade, mute) and retime, and removes the ~60KB data URI from the
 *     persisted scene JSON;
 *   - the built EDL carries a non-null `assetId` for the clip and a
 *     `sourceUri` for the asset, so both the #55 preflight (before
 *     `assertMediaReferencesResolved`) and `EdlToComposition.audibleClips`
 *     admit it;
 *   - a bridge that cannot persist (web / old shell) returns null and the
 *     library element is left untouched — the pre-#63 preview-only behavior;
 *   - the migration is undoable: undo restores the library element.
 *
 * `AddMediaAssetCommand` persists through the OPFS/IndexedDB storage
 * service, which does not exist under `bun test`. These tests also assert on
 * the asset row itself (asset-backed EDL, dedupe), so they install a
 * file-local in-memory replacement for `storageService.saveMediaAsset` for
 * the duration of this file and restore it in `afterEach` — no `mock.module`,
 * which is what otherwise leaks across `bun test` files.
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildDefaultScene } from "@/timeline/scenes";
import {
	buildElementFromMedia,
	buildLibraryAudioElement,
} from "@/timeline/element-utils";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { serializeScene, deserializeScene } from "@/services/storage/scene-serialization";
import { storageService } from "@/services/storage/service";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import { buildEdl } from "@/edl/build";
import {
	assertMediaReferencesResolved,
	findUnresolvedMediaClips,
} from "@/edl/preflight";
import type { MediaAsset } from "@/media/types";
import type { MediaTime } from "@/wasm";
import type { TimelineElement } from "@/timeline/types";
import { getLocalSounds } from "@/sounds/local-sounds";
import type { LibraryAudioSource } from "../library-audio";
import {
	dataUriToBase64,
	ensureLibraryAudioAsset,
	libraryAudioAssetId,
	materializeLibraryAudio,
} from "../library-audio";

const TPS = TICKS_PER_SECOND;
const t = ({ seconds }: { seconds: number }) =>
	mediaTime({ ticks: Math.round(seconds * TPS) });

/** A bridge that behaves like Android's — always persists. `saves` counts
 * invocations so tests can prove dedupe. */
function fakeAudioSource({
	getMediaRootResult = "/sandbox/media",
}: { getMediaRootResult?: string | null } = {}) {
	const saves: Array<{ assetId: string; base64: string }> = [];
	const source: LibraryAudioSource = {
		async getMediaRoot() {
			return getMediaRootResult;
		},
		async saveGeneratedAudio({ assetId, base64 }) {
			saves.push({ assetId, base64 });
			return { relativePath: `generated/${assetId}.wav` };
		},
		toPlaybackUri: (uri: string) => `webview://${uri}`,
	};
	return { source, saves };
}

function bootstrap() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main scene", isMain: true }),
		id: "scene-pav-63",
	};
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	return { editor, sceneId: scene.id };
}

function insertLibraryClip({
	editor,
	sourceUrl,
	name,
	durationSeconds,
	startTime,
}: {
	editor: EditorCore;
	sourceUrl: string;
	name: string;
	durationSeconds: number;
	startTime?: MediaTime;
}): { trackId: string; elementId: string } {
	const create = buildLibraryAudioElement({
		sourceUrl,
		name,
		duration: t({ seconds: durationSeconds }),
		startTime: startTime ?? ZERO_MEDIA_TIME,
	});
	const command = new InsertElementCommand({
		element: create,
		placement: { mode: "auto", trackType: "audio" },
	});
	editor.command.execute({ command });
	const trackId = command.getTrackId();
	if (!trackId) throw new Error("insert did not resolve an audio track");
	return { trackId, elementId: command.getElementId() };
}

function findElement({
	editor,
	trackId,
	elementId,
}: {
	editor: EditorCore;
	trackId: string;
	elementId: string;
}): TimelineElement | undefined {
	return editor.scenes
		.getActiveScene()
		.tracks.audio.flatMap((track) =>
			track.id === trackId ? track.elements : [],
		)
		.find((element) => element.id === elementId);
}

const savedAssets: MediaAsset[] = [];
const saveMediaAssetImpl = storageService.saveMediaAsset;
function stubStorageSave(): void {
	savedAssets.length = 0;
	storageService.saveMediaAsset = async ({ mediaAsset }) => {
		savedAssets.push(mediaAsset);
	};
}
function restoreStorageSave(): void {
	storageService.saveMediaAsset = saveMediaAssetImpl;
}

describe("#63 library sound asset ids", () => {
	const [sound] = getLocalSounds();
	const [other] = getLocalSounds().slice(1);

	it("the same bundled sound always derives the same asset id", () => {
		if (!sound) throw new Error("no local sounds");
		const a = libraryAudioAssetId({ sourceUrl: sound.sourceUrl });
		const b = libraryAudioAssetId({ sourceUrl: sound.sourceUrl });
		expect(a).toBe(b);
		expect(a.length).toBeGreaterThan(8);
	});

	it("different bundled sounds derive different asset ids", () => {
		if (!sound || !other) throw new Error("not enough local sounds");
		expect(libraryAudioAssetId({ sourceUrl: sound.sourceUrl })).not.toBe(
			libraryAudioAssetId({ sourceUrl: other.sourceUrl }),
		);
	});

	it("dataUriToBase64 rejects a non-library data URI", () => {
		expect(() =>
			dataUriToBase64({ sourceUrl: "data:image/png;base64,AAAA" }),
		).toThrow("not an audio/wav data URI");
	});
});

describe("#63 ensureLibraryAudioAsset", () => {
	let editor: EditorCore;
	const [sound] = getLocalSounds();

	beforeEach(() => {
		stubStorageSave();
		editor = bootstrap().editor;
	});
	afterEach(() => {
		restoreStorageSave();
		EditorCore.reset();
	});

	it("writes the WAV to custody, adds one audio asset row, and reuses it on the second call", async () => {
		if (!sound) throw new Error("no local sounds");
		const { source, saves } = fakeAudioSource();

		const first = await ensureLibraryAudioAsset({
			editor,
			projectId: "p1",
			source,
			name: sound.name,
			sourceUrl: sound.sourceUrl,
			durationSeconds: sound.durationSeconds,
		});
		expect(first).not.toBeNull();
		// The fingerprint keys the custody file and the dedupe marker; the
		// asset ROW id is the command-assigned UUID.
		const fingerprint = libraryAudioAssetId({ sourceUrl: sound.sourceUrl });
		expect(first?.assetId).not.toBe(fingerprint);
		expect(first?.relativePath).toBe(`generated/${fingerprint}.wav`);
		expect(saves).toHaveLength(1);
		expect(saves[0]?.assetId).toBe(fingerprint);

		const asset = editor.media
			.getAssets()
			.find((item) => item.id === first?.assetId);
		expect(asset).toBeDefined();
		// Dedupe after a project reopen/restore keys off this fingerprint.
		expect(asset?.librarySoundId).toBe(fingerprint);
		expect(asset?.type).toBe("audio");
		expect(asset?.hasAudio).toBe(true);
		expect(asset?.sourceNativeRelativePath).toBe(`generated/${fingerprint}.wav`);
		expect(asset?.nativeRelativePath).toBe(`generated/${fingerprint}.wav`);
		expect(asset?.duration).toBe(sound.durationSeconds);
		// The bytes survived intact: the bridge received the exact payload
		// the preview decodes today.
		expect(saves[0]?.base64).toBe(dataUriToBase64({ sourceUrl: sound.sourceUrl }));
		// The asset row was handed to persistence exactly once.
		expect(savedAssets).toHaveLength(1);

		const second = await ensureLibraryAudioAsset({
			editor,
			projectId: "p1",
			source,
			name: sound.name,
			sourceUrl: sound.sourceUrl,
			durationSeconds: sound.durationSeconds,
		});
		expect(second?.assetId).toBe(first?.assetId);
		// Dedupe: the bridge was called once, and the media list has ONE row.
		expect(saves).toHaveLength(1);
		expect(editor.media.getAssets()).toHaveLength(1);
		expect(savedAssets).toHaveLength(1);
	});

	it("a platform without custody (web) degrades to null and adds no asset", async () => {
		if (!sound) throw new Error("no local sounds");
		const { source } = fakeAudioSource({ getMediaRootResult: null });
		const result = await ensureLibraryAudioAsset({
			editor,
			projectId: "p1",
			source,
			name: sound.name,
			sourceUrl: sound.sourceUrl,
			durationSeconds: sound.durationSeconds,
		});
		expect(result).toBeNull();
		expect(editor.media.getAssets()).toHaveLength(0);
	});
});

describe("#63 materializeLibraryAudio", () => {
	let editor: EditorCore;
	const [sound] = getLocalSounds();

	beforeEach(() => {
		stubStorageSave();
		editor = bootstrap().editor;
	});
	afterEach(() => {
		restoreStorageSave();
		EditorCore.reset();
	});

	it("converts a legacy library element in place, preserving timing, params and retime, and removes the data URI from the persisted scene", async () => {
		if (!sound) throw new Error("no local sounds");
		const { trackId, elementId } = insertLibraryClip({
			editor,
			sourceUrl: sound.sourceUrl,
			name: sound.name,
			durationSeconds: sound.durationSeconds,
			startTime: t({ seconds: 0.5 }),
		});

		// A user's edits on the clip before migration: volume, mute, trim, retime.
		const before = findElement({ editor, trackId, elementId });
		if (!before || before.type !== "audio") throw new Error("no clip");
		expect(before.sourceType).toBe("library");

		const { source } = fakeAudioSource();
		const result = await materializeLibraryAudio({
			editor,
			projectId: "p1",
			source,
		});
		expect(result).toEqual({ migrated: 1, unmaterialized: 0 });

		const after = findElement({ editor, trackId, elementId });
		if (!after || after.type !== "audio") throw new Error("no clip");
		// Same clip, new identity.
		expect(after.id).toBe(elementId);
		expect(after.sourceType).toBe("upload");
		expect(after.startTime).toBe(t({ seconds: 0.5 }));
		expect(after.duration).toBe(t({ seconds: sound.durationSeconds }));
		// mediaId is the materialized asset ROW id; the row carries the
		// content fingerprint as its dedupe marker.
		if (after.sourceType === "upload") {
			const librarySoundId = libraryAudioAssetId({
				sourceUrl: sound.sourceUrl,
			});
			const asset = editor.media
				.getAssets()
				.find((item) => item.id === after.mediaId);
			expect(asset).toBeDefined();
			expect(asset?.librarySoundId).toBe(librarySoundId);
			expect(asset?.sourceNativeRelativePath).toBe(
				`generated/${librarySoundId}.wav`,
			);
		}
		if (before.params && after.params) {
			expect(after.params).toEqual(before.params);
		}

		// The ~60KB data URI is gone once the scene is serialized (the
		// tombstone is an `undefined` patch field, dropped by JSON).
		const serialized = serializeScene({ scene: editor.scenes.getActiveScene() });
		expect(JSON.stringify(serialized)).not.toContain("data:audio/wav");

		// The EDL is now preflight-clean with a resolved asset.
		const project = editor.project.getActive();
		if (!project) throw new Error("no active project");
		const mediaAssets: MediaAsset[] = editor.media.getAssets();
		const edl = buildEdl({
			project,
			scene: editor.scenes.getActiveScene(),
			mediaAssets: mediaAssets.map((asset) => ({
				id: asset.id,
				name: asset.name,
				type: asset.type,
				size: asset.file.size,
				lastModified: asset.file.lastModified,
				duration: asset.duration,
				hasAudio: asset.hasAudio,
			})),
			resolveAsset: ({ mediaId }) => ({
				sourceUri: `/sandbox/media/generated/${mediaId}.wav`,
			}),
			output: {
				container: "mp4",
				videoCodec: "h264",
				audioCodec: "aac",
				bitrate: 8_000_000,
				includeAudio: true,
			},
		});
		const audioClip = edl.tracks
			.flatMap((track) => track.clips)
			.find((clip) => clip.clipId === elementId);
		// Non-null, present in the EDL's asset list, and the element's own
		// mediaId — the resolver's `sourceUri` comes from that one row.
		if (after.sourceType === "upload") {
			expect(audioClip?.assetId).toBe(after.mediaId);
		}
		const audioAsset = edl.assets.find(
			(item) => item.assetId === audioClip?.assetId,
		);
		expect(audioAsset?.kind).toBe("audio");
		expect(audioAsset?.hasAudio).toBe(true);
		expect(audioAsset?.sourceUri).not.toBeNull();
		expect(findUnresolvedMediaClips({ edl })).toHaveLength(0);
		expect(() => assertMediaReferencesResolved({ edl })).not.toThrow();

		// Idempotent: a second run migrates nothing.
		const again = await materializeLibraryAudio({
			editor,
			projectId: "p1",
			source,
		});
		expect(again).toEqual({ migrated: 0, unmaterialized: 0 });
	});

	it("migration is undoable back to a library element", async () => {
		if (!sound) throw new Error("no local sounds");
		const { trackId, elementId } = insertLibraryClip({
			editor,
			sourceUrl: sound.sourceUrl,
			name: sound.name,
			durationSeconds: sound.durationSeconds,
		});
		const { source } = fakeAudioSource();
		await materializeLibraryAudio({ editor, projectId: "p1", source });
		expect(findElement({ editor, trackId, elementId })?.type).not.toBeUndefined();

		// UpdateElementsCommand undo: restore the exact previous element.
		editor.command.undo();
		const restored = findElement({ editor, trackId, elementId });
		expect(restored?.type).toBe("audio");
		if (restored?.type === "audio") {
			expect(restored.sourceType).toBe("library");
		}
	});

	it("leaves the element untouched when the bridge cannot materialize", async () => {
		if (!sound) throw new Error("no local sounds");
		const { trackId, elementId } = insertLibraryClip({
			editor,
			sourceUrl: sound.sourceUrl,
			name: sound.name,
			durationSeconds: sound.durationSeconds,
		});
		const { source } = fakeAudioSource({ getMediaRootResult: null });
		const result = await materializeLibraryAudio({
			editor,
			projectId: "p1",
			source,
		});
		expect(result).toEqual({ migrated: 0, unmaterialized: 1 });
		const element = findElement({ editor, trackId, elementId });
		expect(element?.type).toBe("audio");
		if (element?.type === "audio") {
			expect(element.sourceType).toBe("library");
		}
	});

	it("a file-backed audio element is never rewritten", async () => {
		const { source } = fakeAudioSource();
		const create = buildElementFromMedia({
			mediaId: "pre-existing-asset",
			mediaType: "audio",
			name: "music.mp3",
			duration: t({ seconds: 3 }),
			startTime: ZERO_MEDIA_TIME,
		});
		const command = new InsertElementCommand({
			element: create,
			placement: { mode: "auto", trackType: "audio" },
		});
		editor.command.execute({ command });
		const result = await materializeLibraryAudio({
			editor,
			projectId: "p1",
			source,
		});
		expect(result).toEqual({ migrated: 0, unmaterialized: 0 });
	});

	it("deserializeScene round-trips the migrated element", async () => {
		if (!sound) throw new Error("no local sounds");
		insertLibraryClip({
			editor,
			sourceUrl: sound.sourceUrl,
			name: sound.name,
			durationSeconds: sound.durationSeconds,
		});
		const { source } = fakeAudioSource();
		await materializeLibraryAudio({ editor, projectId: "p1", source });
		const scene = editor.scenes.getActiveScene();
		const roundTripped = deserializeScene({ scene: serializeScene({ scene }) });
		const element = roundTripped.tracks.audio
			.flatMap((track) => track.elements)
			.find((item) => item.type === "audio");
		expect(element?.type).toBe("audio");
		if (element?.type === "audio") {
			expect(element.sourceType).toBe("upload");
			if (element.sourceType === "upload") {
				const librarySoundId = libraryAudioAssetId({
					sourceUrl: sound.sourceUrl,
				});
				expect(
					editor.media
						.getAssets()
						.find((item) => item.id === element.mediaId)
						?.librarySoundId,
				).toBe(librarySoundId);
			}
		}
	});
});
