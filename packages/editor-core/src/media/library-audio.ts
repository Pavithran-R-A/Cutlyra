/**
 * GitHub #63 — bundled library sounds were preview-only: the element carried
 * a `data:` URI and no `mediaId`, so the EDL gave the clip `assetId: null`
 * and the native audio lane skipped it (`EdlToComposition.audibleClips`).
 * The sound played in preview (WebAudio resolves the data URI) and vanished
 * from the exported MP4 with no warning.
 *
 * The fix is to make the same sound a real, durable asset the moment it is
 * used — nothing in the EDL or the native pipeline changes:
 *
 *   1. At insert time (`insertLocalSound`), the element is inserted as an
 *      ordinary file-backed audio element against a materialized asset.
 *   2. For projects saved before the fix, `materializeLibraryAudio` rewrites
 *      each leftover preview-only element in place (same clip, same id,
 *      timing, volume, trim, mute and retime — only the source identity
 *      changes) the first time the project is exported.
 *
 * The WAV is written into native media custody by the bridge
 * (`NativeMediaSource.saveGeneratedAudio`, implemented by Android and, when
 * a native shell lacks the method, null). Where the bridge cannot persist
 * (web), every function here returns null and leaves preview-only library
 * elements exactly as they were — no behavior change on web.
 *
 * The asset id is a deterministic UUID derived from the `data:` URI itself:
 * the bundled sounds are synthesized deterministically
 * (`sounds/local-sounds.ts`), so the same sound always derives the same
 * asset id, repeat inserts dedupe to one asset, and a backup/restore shows
 * the asset row plus its custody file — export works after restore without
 * anything special.
 */

import { EditorCore } from "@/core";
import { AddMediaAssetCommand, UpdateElementsCommand } from "@/commands";
import type { MediaAsset } from "@/media/types";
import type { TimelineElement } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";
import type { NativeMediaSource } from "./native-import";

/** The portion of a bridge this module needs — a structural subset of
 * `NativeMediaSource`, so hosts can pass their `getNativeBridge()` result
 * directly (the same seam `importMediaFromNative` uses). */
export type LibraryAudioSource = Pick<
	NativeMediaSource,
	"getMediaRoot" | "saveGeneratedAudio" | "toPlaybackUri"
>;

const DATA_URI_PREFIX = "data:audio/wav;base64,";

/** Deterministic UUID from the bundled sound's data URI. FNV-1a over the
 * URI text, rendered into UUID shape with a reserved version nibble so it
 * can never collide with a `generateUUID()` v4 asset id. */
export function libraryAudioAssetId({ sourceUrl }: { sourceUrl: string }): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < sourceUrl.length; i++) {
		hash ^= sourceUrl.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const hex = hash.toString(16).padStart(8, "0");
	const [a = "", b = "", c = "", d = ""] = hex.match(/.{1,2}/g) ?? [];
	return `${a}${b}${c}${d}-0000-4fff-8000-${hex.repeat(3).slice(0, 12)}`;
}

/** The URI payload — the base64 WAV bytes the bridge writes, unchanged: the
 * same prelude-free string `synthesizeToneWavDataUri` produced. */
export function dataUriToBase64({ sourceUrl }: { sourceUrl: string }): string {
	if (!sourceUrl.startsWith(DATA_URI_PREFIX)) {
		throw new Error(
			"Library audio source is not an audio/wav data URI — refusing to materialize it",
		);
	}
	const base64 = sourceUrl.slice(DATA_URI_PREFIX.length);
	// A WAV is at least a 44-byte header; a shorter payload is not one.
	if (base64.length < 80) {
		throw new Error(
			`Library audio payload is ${base64.length} chars — too short for a WAV header`,
		);
	}
	return base64;
}

export interface MaterializedLibraryAudioAsset {
	assetId: string;
	/** Custody-ROOT-relative path of the written WAV. */
	relativePath: string;
}

/**
 * Ensures one real asset row exists for a library sound.
 *
 * Returns null when the bridge cannot persist (web / old shell) — callers
 * then keep the preview-only library element. Throws on a malformed
 * `data:` URI, which is a bug, not degradation.
 */
export async function ensureLibraryAudioAsset({
	editor,
	projectId,
	source,
	name,
	sourceUrl,
	durationSeconds,
}: {
	editor: EditorCore;
	projectId: string;
	source: LibraryAudioSource;
	name: string;
	sourceUrl: string;
	durationSeconds: number;
}): Promise<MaterializedLibraryAudioAsset | null> {
	// The content fingerprint identifies the SOUND; the media row id is the
	// command-assigned UUID. Dedupe keys on the fingerprint stored in the
	// row (`librarySoundId`), so repeat inserts converge on one asset row
	// and one custody file even across project reopens.
	const librarySoundId = libraryAudioAssetId({ sourceUrl });
	// Repeat inserts of the same bundled sound converge on this one asset
	// row — no duplicate file writes, no accumulating media list.
	const existing = editor.media
		.getAssets()
		.find(
			(asset) => asset.librarySoundId === librarySoundId && asset.type === "audio",
		);
	if (existing) {
		const relativePath =
			existing.sourceNativeRelativePath ?? existing.nativeRelativePath;
		return relativePath ? { assetId: existing.id, relativePath } : null;
	}

	const base64 = dataUriToBase64({ sourceUrl });
	const root = await source.getMediaRoot();
	if (!root) return null;

	// The file name rides the fingerprint, so a re-save of the same sound
	// lands on the same custody path with the same bytes.
	const saved = await source.saveGeneratedAudio?.({ assetId: librarySoundId, base64 });
	if (!saved) return null;
	const relativePath = saved.relativePath;

	const asset: Omit<MediaAsset, "id"> = {
		name,
		type: "audio",
		// Zero-byte stub — the bytes live in native custody (the
		// native-import.ts pattern; every decode path goes through
		// createPlayableSource/readPlayableBytes).
		file: new File([], `${name}.wav`, { type: "audio/wav" }),
		// Playback URI so the preview decode path (and, after a project
		// reopen, asset rehydration) can stream the WAV without a re-save.
		url: source.toPlaybackUri(`${root}/${relativePath}`),
		duration: durationSeconds,
		hasAudio: true,
		// A library sound has exactly one file — the custody copy IS the
		// source, so the resolver and the backup recipe both read it.
		nativeRelativePath: relativePath,
		sourceNativeRelativePath: relativePath,
		librarySoundId,
	};
	const command = new AddMediaAssetCommand({ projectId, asset });
	command.execute();
	return { assetId: command.getAssetId(), relativePath };
}


export interface LibraryAudioMigrationResult {
	/** Library elements converted to file-backed audio elements. */
	migrated: number;
	/** Library elements left preview-only (no materialization possible). */
	unmaterialized: number;
}

/**
 * Converts every preview-only library element in the active scene into a
 * file-backed audio element. Only elements in audio tracks — library sounds
 * were only ever inserted there. Idempotent: elements already converted are
 * not library elements anymore.
 */
export async function materializeLibraryAudio({
	editor,
	projectId,
	source,
}: {
	editor: EditorCore;
	projectId: string;
	source: LibraryAudioSource;
}): Promise<LibraryAudioMigrationResult> {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return { migrated: 0, unmaterialized: 0 };

	const updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}> = [];
	let unmaterialized = 0;

	for (const track of [...scene.tracks.audio]) {
		for (const element of track.elements) {
			if (element.type !== "audio" || element.sourceType !== "library") {
				continue;
			}
			const saved = await ensureLibraryAudioAsset({
				editor,
				projectId,
				source,
				name: element.name,
				sourceUrl: element.sourceUrl,
				durationSeconds: mediaTimeToSeconds({ time: element.duration }),
			});
			if (!saved) {
				unmaterialized++;
				continue;
			}
			// Timing, trim, volume, mute, fades and retime all live in `params`
			// and the timing scalars — preserved by the patch. Only the source
			// identity changes; `sourceUrl` is tombstoned (undefined keys are
			// dropped by the scene JSON serialization on save, so the data URI
			// leaves the persisted project) and the preview switches to the
			// media-asset decode path on `sourceType: "upload"`.
			updates.push({
				trackId: track.id,
				elementId: element.id,
				patch: {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- remapping a library audio element to an upload audio element; both are BaseAudioElement with the same timing/params.
					...( {
						sourceType: "upload",
						mediaId: saved.assetId,
						sourceUrl: undefined,
					} as unknown as Partial<TimelineElement> ),
				},
			});
		}
	}

	if (updates.length > 0) {
		// A recorded edit, so an unexpected auto-migration is itself
		// undoable (and the undo restores the original library element).
		editor.command.execute({ command: new UpdateElementsCommand({ updates }) });
	}

	return { migrated: updates.length, unmaterialized };
}
