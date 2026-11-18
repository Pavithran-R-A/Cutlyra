/**
 * Transform gesture core for the mobile preview.
 *
 * Extracted from `preview-renderer.tsx` so the pointer math can be exercised
 * deterministically by `preview-gesture.test.ts` instead of only by hand on a
 * device. The component keeps every DOM/React/engine concern (pointer capture,
 * haptics, `previewElements`/`commitPreview`) and calls these functions; the
 * tests call the same functions, so they are not a re-implementation.
 *
 * Product complaint this guards (2026-11 QA): dragging or resizing an element
 * makes it jump — most visibly the moment a second finger touches down or a
 * finger lifts.
 *
 * Second complaint (same report): an element that had only wobbled a few px
 * before a second finger landed still jumped when the gesture finished. The
 * drag-slop gate (`DRAG_SLOP_PX`) withholds the preview below that threshold,
 * so a topology change must not bank a delta the user never saw; see
 * `applyPointerTopologyChange`'s `bank` parameter.
 */
import {
	NO_SNAP,
	SNAP_CAPTURE_PX,
	SNAP_RELEASE_PX,
	snapToCenterAxes,
	type AxisSnapFlags,
} from "../../editor/axis-snap";

export interface GesturePointer {
	x: number;
	y: number;
}

/** The mutable geometry a gesture session anchors on. */
export interface GestureAnchors {
	pointers: Map<number, GesturePointer>;
	startCentroid: GesturePointer;
	startDistance: number | null;
	anchorPositionX: number;
	anchorPositionY: number;
	anchorScaleX: number;
	anchorScaleY: number;
	/** Which axes are currently held by the centre-line detent. Hysteretic:
	 *  the snap decision depends on whether the axis was already snapped. */
	snapped: AxisSnapFlags;
}

export interface GestureTransform {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
	snapped: AxisSnapFlags;
}

/**
 * Movement below this many CSS px is a tap, not a drag: the session exists but
 * nothing is previewed and nothing will be committed.
 *
 * Lives here (not in the component) so the unit tests exercise the same
 * threshold the pointer handlers use.
 */
export const DRAG_SLOP_PX = 6;

export const pointerCentroidAndDistance = (
	pointers: ReadonlyMap<number, GesturePointer>,
): { centroid: GesturePointer; distance: number | null } => {
	const points = [...pointers.values()];
	if (points.length === 0) {
		// No pointers means no geometry; callers must not preview from this.
		// Returning the origin rather than NaN keeps that a visible no-op
		// instead of a corrupted (NaN) transform.
		return { centroid: { x: 0, y: 0 }, distance: null };
	}
	const centroid = {
		x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
		y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
	};
	const distance =
		points.length >= 2
			? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
			: null;
	return { centroid, distance };
};

/**
 * Has the pointer centroid travelled far enough to count as a real drag?
 *
 * A second finger always counts: a two-finger pinch is never a tap, even when
 * the centroid has not moved yet.
 */
export const centroidMovedBeyondSlop = ({
	pointers,
	startCentroid,
	slop = DRAG_SLOP_PX,
}: {
	pointers: ReadonlyMap<number, GesturePointer>;
	startCentroid: GesturePointer;
	slop?: number;
}): boolean => {
	const { centroid } = pointerCentroidAndDistance(pointers);
	return Math.hypot(centroid.x - startCentroid.x, centroid.y - startCentroid.y) >= slop;
};

/**
 * The element's effective transform under the current pointer deltas, with the
 * centre-axis detent applied.
 *
 * The snap is applied HERE rather than at commit time on purpose: the whole
 * point is that the element visibly leaves the finger and sits on the axis
 * during the drag. Snapping only on release would land in the same place while
 * showing the user nothing.
 *
 * `scale` converts CSS px (pointer space) to canvas units.
 */
export const gestureTransform = ({
	anchors,
	scale,
}: {
	anchors: GestureAnchors;
	scale: number;
}): GestureTransform => {
	const { centroid, distance } = pointerCentroidAndDistance(anchors.pointers);
	const factor =
		distance !== null && anchors.startDistance && anchors.startDistance > 0
			? distance / anchors.startDistance
			: 1;
	// Thresholds are authored in CSS px and converted with the same px ->
	// canvas factor the drag itself uses, so the detent is the same physical
	// size on any preview size or project resolution.
	const rawX = anchors.anchorPositionX + (centroid.x - anchors.startCentroid.x) * scale;
	const rawY = anchors.anchorPositionY + (centroid.y - anchors.startCentroid.y) * scale;
	const snap = snapToCenterAxes({
		x: rawX,
		y: rawY,
		wasSnapped: anchors.snapped,
		capture: SNAP_CAPTURE_PX * scale,
		release: SNAP_RELEASE_PX * scale,
	});
	return {
		positionX: snap.x,
		positionY: snap.y,
		scaleX: anchors.anchorScaleX * factor,
		scaleY: anchors.anchorScaleY * factor,
		snapped: snap.snapped,
	};
};

/**
 * Apply a pointer-topology change (a finger joined or left) without moving the
 * element.
 *
 * The transform is read from the pointer set that was live while that
 * transform was on screen — BEFORE `mutate` runs — then banked as the new
 * anchor and the delta origin is moved to the new pointer geometry.
 *
 * Reading it after the mutation (the pre-fix behaviour) instead measured the
 * old anchor against a centroid that already included the joining finger, so
 * the very next move snapped the element by however far the centroid had
 * shifted — half the inter-finger distance for a second finger.
 *
 * `bank` is the second half of that guarantee. Banking is only correct for a
 * transform that WAS on screen. Below the drag-slop threshold nothing is
 * previewed, so the gesture has an accumulated delta the user never saw;
 * banking it would make the next frame jump by that invisible amount. Callers
 * therefore pass `bank: false` until the session is actually dragging, which
 * keeps the current anchors and only re-origins the delta measurement.
 */
export const applyPointerTopologyChange = ({
	state,
	mutate,
	scale,
	bank = true,
}: {
	state: GestureAnchors;
	mutate: (pointers: Map<number, GesturePointer>) => void;
	scale: number;
	bank?: boolean;
}): GestureTransform => {
	const before = gestureTransform({ anchors: state, scale });
	mutate(state.pointers);
	if (bank) {
		state.anchorPositionX = before.positionX;
		state.anchorPositionY = before.positionY;
		state.anchorScaleX = before.scaleX;
		state.anchorScaleY = before.scaleY;
	}
	const { centroid, distance } = pointerCentroidAndDistance(state.pointers);
	state.startCentroid = centroid;
	state.startDistance = distance;
	// What the screen shows after this change: the banked transform when it was
	// presented, otherwise the untouched anchors (nothing was ever previewed).
	return bank
		? before
		: {
				positionX: state.anchorPositionX,
				positionY: state.anchorPositionY,
				scaleX: state.anchorScaleX,
				scaleY: state.anchorScaleY,
				snapped: state.snapped,
			};
};

/** Session state a fresh gesture starts from, given its first pointer. */
export const initialAnchors = ({
	pointers,
	positionX,
	positionY,
	scaleX,
	scaleY,
}: {
	pointers: Map<number, GesturePointer>;
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
}): GestureAnchors => {
	const { centroid, distance } = pointerCentroidAndDistance(pointers);
	return {
		pointers,
		startCentroid: centroid,
		startDistance: distance,
		anchorPositionX: positionX,
		anchorPositionY: positionY,
		anchorScaleX: scaleX,
		anchorScaleY: scaleY,
		snapped: NO_SNAP,
	};
};
