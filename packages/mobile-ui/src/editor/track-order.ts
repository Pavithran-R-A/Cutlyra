import type { SceneTracks, TimelineTrack } from "@cutlyra/editor-core/timeline";
import type { TimelineTrackKind } from "../timeline/types";

/**
 * Lane order the mobile timeline renders, rows top-to-bottom.
 *
 * Overlays sit ABOVE the main media row and audio sits BELOW it. That is the
 * order the placement engine already assumes — `resolveTrackPlacement` indexes
 * `[...overlay, main, ...audio]`, with `getHighestInsertIndexForTrack` returning
 * `0` for a new overlay track and `overlay.length + 1` for the first audio slot
 * — and the order the web editor renders. The mobile view model used to emit
 * `[main, ...overlay, ...audio]` instead, so a duplicated clip or a freshly
 * added text track (both placed at the TOP of the overlay stack) appeared
 * directly under the main clip, in the band users read as the music lane, while
 * new audio appeared below everything (founder/user report: "if u duplicate, it
 * ends up in the music slot … if u add a text, it ends up in the music slot
 * too").
 */
export function trackDisplayOrder(tracks: SceneTracks): Array<{
	track: TimelineTrack;
	isMain: boolean;
}> {
	return [
		...tracks.overlay.map((track) => ({ track, isMain: false })),
		{ track: tracks.main, isMain: true },
		...tracks.audio.map((track) => ({ track, isMain: false })),
	];
}

/**
 * Which lane a track renders as. Kept next to the order helper so "where does
 * this row sit" and "what does this row look like" are answered by the same
 * module and can be tested together — a lane that renders with the wrong kind
 * is how a duplicated clip looked like it belonged to the music band.
 */
export function trackLaneKind({
	track,
	isMain,
}: {
	track: TimelineTrack;
	isMain: boolean;
}): TimelineTrackKind {
	if (isMain) return "main";
	switch (track.type) {
		case "video":
			return "overlay";
		case "text":
			return "text";
		case "audio":
			return "audio";
		case "graphic":
			return "sticker";
		case "effect":
			return "overlay";
		case "caption":
			return "caption";
		default:
			return "overlay";
	}
}
