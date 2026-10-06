import {
	addMediaTime,
	maxMediaTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@cutlyra/editor-core/wasm";

export interface TimelineSpan {
	startTime: MediaTime;
	duration: MediaTime;
}

/**
 * Returns the first tick after the last item on the magnetic main track.
 *
 * Do not assume the element array is perfectly sorted or gap-free here. The
 * mobile timeline normally maintains both invariants, but taking the maximum
 * end makes Add clip fail safe if an older project or interrupted edit carries
 * a stale order.
 */
export function getMainTrackAppendTime({
	elements,
}: {
	elements: readonly TimelineSpan[];
}): MediaTime {
	return elements.reduce(
		(end, element) =>
			maxMediaTime({
				a: end,
				b: addMediaTime({ a: element.startTime, b: element.duration }),
			}),
		ZERO_MEDIA_TIME,
	);
}
