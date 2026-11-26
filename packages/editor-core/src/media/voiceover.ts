/**
 * Voiceover takes — the state and custody half of the Audio panel's record
 * button.
 *
 * The native recorder (`NativeBridgePlugin.startVoiceoverRecording`) writes a
 * 44.1 kHz mono WAV into `generated/voiceover-<takeId>.wav` and hands back its
 * custody-relative path. This module turns that path into ordinary project
 * state: one media asset row (a zero-byte stub pointing at custody, exactly
 * `media/library-audio.ts`'s pattern) plus one audio-track element at the
 * record position. Nothing about the EDL or the native mix changes — the
 * voiceover IS an audio clip, so preview, save/reopen, archive/restore, undo,
 * and `EdlToComposition.addAudioSequence` all already handle it.
 *
 * ## Mixing policy (implemented, not implied)
 *
 * A voiceover is mixed at **unity gain** (element volume 1.0, i.e. 0 dB) and
 * SUMMED with the clip audio underneath it — there is no automatic ducking of
 * the bed and no side-chain compression. The exporter's `LimitingAudioMixer`
 * caps the sum at full scale, so a loud voiceover over loud music is limited
 * rather than clipped. Users who want ducking lower the clip's own volume or
 * the voiceover's, per element — both are ordinary audio-element params.
 * `ExportVoiceoverInstrumentedTest` measures the unity gain against the bed.
 *
 * ## Limits and lifecycle
 *
 * - A take is at most `VOICEOVER_MAX_TAKE_SECONDS` long AND cannot outlast
 *   the project as it stands at the playhead (`voiceoverTakeLimit`), so the
 *   recording always lands on the timeline instead of creating a tail that
 *   nothing can see.
 * - The take file is generated media in custody. Undo removes the element and
 *   the asset row but not the file, so `pruneUnusedVoiceoverTakes` deletes
 *   takes no asset row references — the same "only unreferenced generated
 *   files" rule `GifFrameCleanup` uses, and only inside the
 *   `generated/voiceover-*` namespace.
 */

import { BatchCommand, AddMediaAssetCommand, InsertElementCommand } from "@/commands";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { referencedCustodyPaths } from "@/media/references";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds } from "@/wasm";

/** Hard per-take ceiling. A voiceover longer than this is several takes. */
export const VOICEOVER_MAX_TAKE_SECONDS = 300;

/** A take shorter than this is a mis-tap, and the recorder refuses it too. */
export const VOICEOVER_MIN_TAKE_SECONDS = 0.25;

/** Every voiceover file lives here, under the media custody root. */
const VOICEOVER_PREFIX = "voiceover-";

/**
 * The portion of the native bridge voiceover needs — a structural subset so
 * hosts pass their `getNativeBridge()` result directly.
 */
export interface VoiceoverSource {
	getMediaRoot(): Promise<string | null>;
	toPlaybackUri(nativeUri: string): string;
	pruneVoiceoverTakes?: (params: {
		referencedPaths: string[];
	}) => Promise<{ removed: string[] } | null>;
}

/** What the native recorder returns for a finalized take. */
export interface RecordedVoiceoverTake {
	relativePath: string;
	durationMs: number;
	sizeBytes?: number;
}

export type VoiceoverLimitReason = "max-take" | "project-end" | "none";

export interface VoiceoverTakeLimit {
	/** Passed to the recorder as `maxDurationMs`. 0 means "do not start". */
	limitSeconds: number;
	reason: VoiceoverLimitReason;
}

/** Fresh take id; the recorder turns it into the custody file name. */
export function newVoiceoverTakeId(): string {
	return `${VOICEOVER_PREFIX}${generateUUID()}`;
}

/**
 * How long the take may run, given where the playhead is.
 *
 * Recording past the end of the project would create audio the timeline
 * cannot show, so the take is capped by the remaining project duration — the
 * documented "target clip ends" behaviour: recording stops itself there and
 * what was captured is inserted.
 */
export function voiceoverTakeLimit({
	startSeconds,
	timelineEndSeconds,
}: {
	startSeconds: number;
	timelineEndSeconds: number;
}): VoiceoverTakeLimit {
	const remaining = Math.max(0, timelineEndSeconds - startSeconds);
	if (remaining < VOICEOVER_MIN_TAKE_SECONDS) {
		return { limitSeconds: 0, reason: "none" };
	}
	if (remaining <= VOICEOVER_MAX_TAKE_SECONDS) {
		return { limitSeconds: remaining, reason: "project-end" };
	}
	return { limitSeconds: VOICEOVER_MAX_TAKE_SECONDS, reason: "max-take" };
}

export interface CommittedVoiceoverTake {
	assetId: string;
	trackId: string;
	elementId: string;
	/** Element duration in seconds (what was actually inserted). */
	durationSeconds: number;
}

/**
 * Inserts a finished take as project state: one asset row + one audio element
 * at `startSeconds`, in ONE undo step (batching both commands means undo
 * removes the row and the clip together; the file is pruned as unreferenced
 * custody afterwards).
 *
 * Returns null when the platform has no writable custody (web) — the caller
 * then reports that recording is unavailable, exactly as `saveGeneratedAudio`
 * callers do.
 */
export async function commitVoiceoverTake({
	editor,
	projectId,
	source,
	take,
	startSeconds,
	name = "Voiceover",
}: {
	editor: EditorCore;
	projectId: string;
	source: VoiceoverSource;
	take: RecordedVoiceoverTake;
	startSeconds: number;
	name?: string;
}): Promise<CommittedVoiceoverTake | null> {
	const durationSeconds = take.durationMs / 1000;
	if (!(durationSeconds >= VOICEOVER_MIN_TAKE_SECONDS)) {
		throw new Error(
			`Voiceover take is ${Math.round(take.durationMs)}ms — too short to insert`,
		);
	}
	const root = await source.getMediaRoot();
	if (!root) return null;

	const asset: Omit<MediaAsset, "id"> = {
		name,
		type: "audio",
		// Zero-byte stub: the bytes are in native custody (native-import.ts).
		file: new File([], `${name}.wav`, { type: "audio/wav" }),
		url: source.toPlaybackUri(`${root}/${take.relativePath}`),
		duration: durationSeconds,
		hasAudio: true,
		// The take has exactly one file, and it is both the preview source and
		// what the exporter reads.
		nativeRelativePath: take.relativePath,
		sourceNativeRelativePath: take.relativePath,
		// Marker for the custody sweep (and for telling takes apart in the
		// media list) — a random row id would be lost on restore.
		voiceoverTakeId: take.relativePath.replace(/^.*\//, "").replace(/\.wav$/, ""),
	};
	const addAsset = new AddMediaAssetCommand({ projectId, asset });
	const insert = new InsertElementCommand({
		element: buildElementFromMedia({
			mediaId: addAsset.getAssetId(),
			mediaType: "audio",
			name,
			duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
			startTime: mediaTimeFromSeconds({ seconds: startSeconds }),
		}),
		placement: { mode: "auto", trackType: "audio" },
	});
	editor.command.execute({ command: new BatchCommand([addAsset, insert]) });
	const trackId = insert.getTrackId();
	if (!trackId) {
		// A batch that executed but placed nothing must not leave a dangling
		// asset row behind (the element insert is what makes undo atomic).
		editor.command.undo();
		return null;
	}
	return {
		assetId: addAsset.getAssetId(),
		trackId,
		elementId: insert.getElementId(),
		durationSeconds,
	};
}

/**
 * Custody paths of every voiceover take the project still references. The
 * media rows are the authority: a take whose row is gone (undo, delete) is
 * garbage even if a clip briefly pointed at it.
 */
export function referencedVoiceoverPaths(assets: MediaAsset[]): string[] {
	const paths = new Set<string>();
	for (const asset of assets) {
		if (!asset.voiceoverTakeId) continue;
		const path = asset.sourceNativeRelativePath ?? asset.nativeRelativePath;
		if (path) paths.add(path);
	}
	return [...paths];
}

/**
 * Deletes voiceover take files nothing references. Mirrors the GIF-frame
 * custody rule: generated files are swept only when unreferenced, and only
 * within this feature's namespace, so library sounds and freeze frames that
 * share `generated/` are never touched.
 */
export async function pruneUnusedVoiceoverTakes({
	editor,
	source,
}: {
	editor: EditorCore;
	source: VoiceoverSource;
}): Promise<string[]> {
	if (!source.pruneVoiceoverTakes) return [];
	const result = await source.pruneVoiceoverTakes({
		referencedPaths: await referencedCustodyPaths({
			editor,
			includeAsset: (asset) => asset.voiceoverTakeId !== undefined,
		}),
	});
	return result?.removed ?? [];
}
