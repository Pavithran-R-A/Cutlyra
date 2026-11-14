/**
 * Gesture frame -> engine preview payload.
 *
 * Split from `preview-gesture.ts` so the pointer maths stays free of the
 * keyframe/param modules (and their wasm import chain) and can be unit tested
 * in isolation. The component sends `buildSessionPatches(...)` straight to
 * `timeline.previewElements`, so this mapping is the production one.
 */
import type { MediaTime } from "@cutlyra/editor-core";
import type { ParamValues } from "@cutlyra/editor-core/params";
import type { TimelineElement } from "@cutlyra/editor-core/timeline";
import {
	upsertClipAnimationValues,
	type ClipKeyframeValues,
} from "../../editor/keyframes";
import type { GestureTransform } from "./preview-gesture";

export interface GestureTarget {
	trackId: string;
	elementId: string;
	/** PRE-gesture element: every frame's params/animations build from it. */
	element: TimelineElement;
	keyed: boolean;
	/** Frame-snapped clip-local playhead at gesture start. */
	localTime: MediaTime;
	/** The keyframe group's values at `localTime` — the drag anchors here
	 *  (so a keyed clip is grabbed where it IS at this time, not at its base
	 *  params) and rotate/opacity ride along unchanged so the keyframe the
	 *  drag writes is complete. */
	baseValues: ClipKeyframeValues;
}

export interface SessionUpdate {
	trackId: string;
	elementId: string;
	updates: {
		params?: ParamValues;
		animations?: ReturnType<typeof upsertClipAnimationValues>;
	};
}

/**
 * Map one gesture frame's transform onto the engine's preview payload: params
 * for an un-keyed element, a complete keyframe group at the playhead for a
 * keyed one. Every caption in the scene is its own target, so a caption drag
 * fans out here rather than in the drag math.
 */
export const buildSessionPatches = ({
	targets,
	transform,
}: {
	targets: readonly GestureTarget[];
	transform: GestureTransform;
}): SessionUpdate[] => {
	const transformPatch: ParamValues = {
		"transform.positionX": transform.positionX,
		"transform.positionY": transform.positionY,
		"transform.scaleX": transform.scaleX,
		"transform.scaleY": transform.scaleY,
	};
	return targets.map((target) => ({
		trackId: target.trackId,
		elementId: target.elementId,
		updates: target.keyed
			? {
					// Auto-keyframe: the whole group at the playhead, built from
					// the PRE-gesture animations so re-writing the same time
					// every frame replaces one key instead of stacking.
					animations: upsertClipAnimationValues({
						element: target.element,
						localTime: target.localTime,
						values: {
							...target.baseValues,
							"transform.positionX": transform.positionX,
							"transform.positionY": transform.positionY,
							"transform.scaleX": transform.scaleX,
							"transform.scaleY": transform.scaleY,
						},
					}),
				}
			: { params: { ...target.element.params, ...transformPatch } },
	}));
};
