import { describe, expect, test } from "bun:test";
import {
	FULL_CROP,
	MIN_CROP_SIZE,
	croppedSourceSize,
	isFullCrop,
	readCropFromParams,
} from "../crop";

describe("crop params", () => {
	test("missing params read as the full frame", () => {
		expect(readCropFromParams({ params: undefined })).toEqual(FULL_CROP);
		expect(readCropFromParams({ params: {} })).toEqual(FULL_CROP);
		expect(isFullCrop(readCropFromParams({ params: {} }))).toBe(true);
	});

	test("reads a normalised sub-rectangle", () => {
		const crop = readCropFromParams({
			params: { "crop.x": 0.25, "crop.y": 0.1, "crop.width": 0.5, "crop.height": 0.4 },
		});
		expect(crop).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 });
		expect(isFullCrop(crop)).toBe(false);
	});

	test("clamps size below the minimum and offsets past the edge", () => {
		const crop = readCropFromParams({
			params: { "crop.x": 0.9, "crop.y": 2, "crop.width": 0.5, "crop.height": 0.001 },
		});
		expect(crop.width).toBeCloseTo(0.5);
		expect(crop.x).toBeCloseTo(0.5);
		expect(crop.height).toBe(MIN_CROP_SIZE);
		expect(crop.y).toBeCloseTo(1 - MIN_CROP_SIZE);
	});

	test("ignores non-finite and wrong-typed values", () => {
		const crop = readCropFromParams({
			params: {
				"crop.x": Number.NaN,
				"crop.y": "0.5",
				"crop.width": Number.POSITIVE_INFINITY,
				"crop.height": null,
			},
		});
		expect(crop).toEqual(FULL_CROP);
	});

	test("croppedSourceSize reports the kept pixel region", () => {
		expect(
			croppedSourceSize({
				sourceWidth: 1920,
				sourceHeight: 1080,
				crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
			}),
		).toEqual({ width: 960, height: 540 });
	});

	test("isFullCrop tolerates float noise only", () => {
		expect(isFullCrop({ x: 1e-9, y: 0, width: 1, height: 1 })).toBe(true);
		expect(isFullCrop({ x: 0.001, y: 0, width: 1, height: 1 })).toBe(false);
	});
});
