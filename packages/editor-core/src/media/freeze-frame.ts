/**
 * Freeze Frame — capture geometry and the persisted capture record.
 *
 * A Freeze Frame is deliberately a SOURCE-frame capture, not a canvas grab:
 * the still is taken from the clip's own source video at the source instant
 * under the playhead, so every OTHER track (overlays, captions, stickers)
 * keeps compositing live over the held interval and stays editable. The
 * frozen still is a normal image asset in the project's media library, which
 * is what makes it survive save/reopen and the backup archive without a
 * parallel pipeline.
 *
 * Everything here is platform-agnostic and runs under `bun test`:
 *  - `freezeSourceTimestampMicros` maps TIMELINE time to SOURCE time through
 *    the clip's trim and retime rate (the same engine math the split command
 *    uses), and refuses timestamps it cannot honour instead of guessing;
 *  - `persistFreezeFrame` writes the captured-frame record onto the asset's
 *    persisted metadata with real I/O and only resolves once that write
 *    succeeded;
 *  - `freezeFrameConfigFromCapture` builds the record that links the still
 *    back to the element and instant it came from.
 *
 * Audio policy (also stated in the FreezeFrameCommand): the frozen interval
 * is a still image and therefore silent; the video before it keeps its own
 * audio up to the split and the video after it keeps its audio from its new
 * trim start. Nothing is muted or duplicated, and no source media is touched.
 */
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import type { MediaAssetData } from "@/services/storage/types";
// Imported from the specific module (not `@/retime`) so consumers that only
// need the time mapping don't pull in the audio-stretch dependency.
import { getSourceSpanAtClipTime } from "@/retime/split";
import {
	TICKS_PER_SECOND,
	addMediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";

/** Shortest/longest hold the editor offers; the command clamps to these. */
export const FREEZE_HOLD_MIN_SECONDS = 0.1;
export const FREEZE_HOLD_MAX_SECONDS = 10;
export const FREEZE_HOLD_DEFAULT_SECONDS = 1;

const MICROS_PER_SECOND = 1_000_000;

/**
 * Provenance of one captured freeze still, stored with the still's own asset
 * metadata (`MediaAssetData.freezeFrame`). It is the durable answer to "which
 * clip and which source instant does this still freeze?", and it travels with
 * the asset through save/reopen and the backup archive.
 */
export interface FreezeFrameCaptureConfig {
	/** Element the frame was captured from (the clip that got split). */
	sourceElementId: string;
	/** Media asset of that element (the SOURCE video, never deleted). */
	sourceMediaId: string;
	/** Source-relative instant of the captured frame. */
	sourceTimestampMicros: number;
	/** How long the still holds on the timeline when inserted. */
	holdDurationMicros: number;
	/** Pixel size of the written still. */
	width: number;
	height: number;
	/** ISO timestamp of the capture (diagnostics/provenance only). */
	capturedAt: string;
}

export type FreezeFrameErrorCode =
	| "ASSET_MISSING"
	| "WRITE_FAILED"
	| "NOT_VIDEO"
	| "OUTSIDE_CLIP";

export class FreezeFrameError extends Error {
	readonly code: FreezeFrameErrorCode;
	constructor({ code, message }: { code: FreezeFrameErrorCode; message: string }) {
		super(message);
		this.name = "FreezeFrameError";
		this.code = code;
	}
}

export type FreezeSourceTimestamp =
	| { ok: true; sourceMicros: number; clipTime: MediaTime }
	| { ok: false; reason: "not-video" | "outside-clip" };

/**
 * Maps a TIMELINE instant onto the SOURCE instant of a video element.
 *
 * - `timelineTime - startTime` is the clip-local time;
 * - an instant at or outside the clip's own span is refused (a freeze at the
 *   very last frame would produce a still of nothing);
 * - the clip-local time is converted through the SAME retime math the split
 *   command uses (`getSourceSpanAtClipTime`), so a speed-adjusted clip maps
 *   to the frame the user is actually looking at, not to the un-retimed one;
 * - the trimmed-away head (`trimStart`) is added, because the source instant
 *   is relative to the original file, not to the trimmed clip.
 *
 * The result is deliberately in MICROSECONDS: that is the unit the Android
 * decoder takes, and converting once here keeps every caller honest.
 */
export function freezeSourceTimestampMicros({
	element,
	timelineTime,
}: {
	element: TimelineElement;
	timelineTime: MediaTime;
}): FreezeSourceTimestamp {
	if (element.type !== "video") {
		return { ok: false, reason: "not-video" };
	}
	const clipTime = subMediaTime({ a: timelineTime, b: element.startTime });
	if (clipTime <= 0 || clipTime >= element.duration) {
		return { ok: false, reason: "outside-clip" };
	}
	const retime = element.retime;
	const sourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({ clipTime, retime }),
	});
	const sourceTicks = addMediaTime({ a: element.trimStart, b: sourceSpan });
	return {
		ok: true,
		clipTime,
		sourceMicros: Math.round((sourceTicks * MICROS_PER_SECOND) / TICKS_PER_SECOND),
	};
}

/** Clamps a requested hold into the range the editor supports. */
export function clampFreezeHoldSeconds(seconds: number): number {
	if (!Number.isFinite(seconds)) return FREEZE_HOLD_DEFAULT_SECONDS;
	return Math.min(
		FREEZE_HOLD_MAX_SECONDS,
		Math.max(FREEZE_HOLD_MIN_SECONDS, seconds),
	);
}

/** Builds the persisted record for a freshly captured still. */
export function freezeFrameConfigFromCapture({
	element,
	sourceTimestampMicros,
	holdDurationMicros,
	width,
	height,
	now = new Date(),
}: {
	element: TimelineElement;
	sourceTimestampMicros: number;
	holdDurationMicros: number;
	width: number;
	height: number;
	now?: Date;
}): FreezeFrameCaptureConfig {
	if (element.type !== "video" || !("mediaId" in element)) {
		throw new FreezeFrameError({
			code: "NOT_VIDEO",
			message: "Only a video clip can be frozen",
		});
	}
	return {
		sourceElementId: element.id,
		sourceMediaId: element.mediaId,
		sourceTimestampMicros,
		holdDurationMicros,
		width,
		height,
		capturedAt: now.toISOString(),
	};
}

/**
 * The persistence surface this module needs. `StorageService` satisfies it
 * structurally, and a test can pass a tiny in-memory implementation instead of
 * mocking the whole storage stack.
 */
export interface FreezeFrameStore {
	listMediaAssetData(params: { projectId: string }): Promise<MediaAssetData[]>;
	putMediaAssetData(params: {
		projectId: string;
		data: MediaAssetData;
	}): Promise<void>;
}

/**
 * Writes the capture record onto the generated still's persisted metadata.
 *
 * This is real persistence, not a claim: the existing record is read back,
 * the record is merged and written, and the promise only resolves after the
 * storage write did. A missing asset is an error (the still must be registered
 * before its provenance can point at it).
 */
export async function persistFreezeFrame({
	store,
	projectId,
	assetId,
	config,
}: {
	store: FreezeFrameStore;
	projectId: string;
	assetId: string;
	config: FreezeFrameCaptureConfig;
}): Promise<MediaAssetData> {
	const assets = await store.listMediaAssetData({ projectId });
	const asset = assets.find((candidate) => candidate.id === assetId);
	if (!asset) {
		throw new FreezeFrameError({
			code: "ASSET_MISSING",
			message: `Frozen still ${assetId} is not registered in project ${projectId}`,
		});
	}
	const updated: MediaAssetData = { ...asset, freezeFrame: config };
	try {
		await store.putMediaAssetData({ projectId, data: updated });
	} catch (cause) {
		throw new FreezeFrameError({
			code: "WRITE_FAILED",
			message: `Could not save the freeze-frame record: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		});
	}
	return updated;
}

/** True when the asset is a generated freeze still. */
export function isFreezeFrameAsset(asset: {
	freezeFrame?: FreezeFrameCaptureConfig;
}): boolean {
	return asset.freezeFrame !== undefined;
}
