import { addMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { SceneTracks, TSceneTransition, TimelineElement } from "./types";
import { applyTransitionsToSceneTracks } from "./transitions";

export interface VideoExportBounds {
	/** Authored end across all tracks. This is NOT necessarily the MP4 end. */
	nominalEnd: MediaTime;
	/** Last rendered visual frame boundary, after main-track overlaps. */
	visualEnd: MediaTime;
	/** Number of text/caption clips extending beyond visualEnd. */
	truncatedTextCount: number;
	/** Furthest remapped end of out-of-range text/caption content. */
	lastTruncatedTextEnd: MediaTime;
}

function endOf(element: Pick<TimelineElement, "startTime" | "duration">): MediaTime {
	return addMediaTime({ a: element.startTime, b: element.duration });
}

/**
 * The native video exporter ends at the compressed main visual track, or
 * the last genuine VIDEO/GRAPHIC overlay — whichever is later. AUDIO,
 * TEXT and CAPTION-only tails must NOT extend a video into black.
 *
 * Keep this contract aligned with EdlToComposition.kt's projectEndTicks.
 * Editing tracks remain nominal; applying transitions here is read-only.
 */
export function getVideoExportBounds({
	tracks,
	transitions,
}: {
	tracks: SceneTracks;
	transitions?: readonly TSceneTransition[];
}): VideoExportBounds {
	let nominalEnd: MediaTime = ZERO_MEDIA_TIME;
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			const end = endOf(element);
			if (end > nominalEnd) nominalEnd = end;
		}
	}

	const rendered = applyTransitionsToSceneTracks({ tracks, transitions });
	let visualEnd: MediaTime = ZERO_MEDIA_TIME;
	for (const element of rendered.main.elements) {
		const end = endOf(element);
		if (end > visualEnd) visualEnd = end;
	}
	for (const track of rendered.overlay) {
		if (track.type !== "video" && track.type !== "graphic") continue;
		for (const element of track.elements) {
			const end = endOf(element);
			if (end > visualEnd) visualEnd = end;
		}
	}

	let truncatedTextCount = 0;
	let lastTruncatedTextEnd: MediaTime = ZERO_MEDIA_TIME;
	for (const track of rendered.overlay) {
		if (track.type !== "text" && track.type !== "caption") continue;
		for (const element of track.elements) {
			const end = endOf(element);
			if (end <= visualEnd) continue;
			truncatedTextCount++;
			if (end > lastTruncatedTextEnd) lastTruncatedTextEnd = end;
		}
	}
	return { nominalEnd, visualEnd, truncatedTextCount, lastTruncatedTextEnd };
}
