/**
 * Crop is a normalised source-space rectangle: `x`/`y` are the top-left corner
 * and `width`/`height` its size, all in 0..1 of the source frame. The default
 * (`FULL_CROP`) covers the whole frame, so a project authored before crop
 * existed renders byte-for-byte as it did before.
 *
 * Preview (`frame-descriptor.ts` -> compositor UVs) and native export
 * (`EdlClip.crop` -> Media3 `Crop`) both derive from this one reader, which is
 * what keeps the two honest about clamping and defaults.
 */
export type CropRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export const FULL_CROP: CropRect = {
	x: 0,
	y: 0,
	width: 1,
	height: 1,
};

/** Smallest crop the UI and both renderers accept, as a fraction of the source. */
export const MIN_CROP_SIZE = 0.01;

export function readCropFromParams({
	params,
}: {
	params: Record<string, unknown> | undefined;
}): CropRect {
	const width = clamp({
		value: readNumber({ params, key: "crop.width", fallback: 1 }),
		min: MIN_CROP_SIZE,
		max: 1,
	});
	const height = clamp({
		value: readNumber({ params, key: "crop.height", fallback: 1 }),
		min: MIN_CROP_SIZE,
		max: 1,
	});
	// Offsets are clamped against the resolved size, not against 1, so a
	// persisted crop can never leave the sampled region (and a slider dragged
	// past the edge pins the rectangle instead of sampling transparent pixels).
	const x = clamp({
		value: readNumber({ params, key: "crop.x", fallback: 0 }),
		min: 0,
		max: 1 - width,
	});
	const y = clamp({
		value: readNumber({ params, key: "crop.y", fallback: 0 }),
		min: 0,
		max: 1 - height,
	});
	return { x, y, width, height };
}

export function isFullCrop(crop: CropRect): boolean {
	return (
		Math.abs(crop.x) < 1e-6 &&
		Math.abs(crop.y) < 1e-6 &&
		Math.abs(crop.width - 1) < 1e-6 &&
		Math.abs(crop.height - 1) < 1e-6
	);
}

/** Source pixels covered by `crop`, used by framing/effects sizing. */
export function croppedSourceSize({
	sourceWidth,
	sourceHeight,
	crop,
}: {
	sourceWidth: number;
	sourceHeight: number;
	crop: CropRect;
}): { width: number; height: number } {
	return {
		width: sourceWidth * crop.width,
		height: sourceHeight * crop.height,
	};
}

function readNumber({
	params,
	key,
	fallback,
}: {
	params: Record<string, unknown> | undefined;
	key: string;
	fallback: number;
}): number {
	const value = params?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.min(max, Math.max(min, value));
}
