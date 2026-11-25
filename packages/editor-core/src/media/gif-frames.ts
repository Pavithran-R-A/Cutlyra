/**
 * Runtime animated-GIF frame source for the renderer.
 *
 * Decodes the asset's bytes once with the bundled offline decoder and exposes
 * one canvas per frame, so preview and export both draw the exact frame for a
 * given source time. DOM-only (canvas), so it is not part of the pure helpers
 * covered by `bun test`; the selection maths lives in `gif-asset.ts`.
 */

import { decodeGif } from "./gif-decoder";
import {
	gifMetadataFromDecode,
	type GifAssetMetadata,
} from "./gif-asset";

export interface GifFrameSource {
	metadata: GifAssetMetadata;
	/** Number of decoded frames. */
	frameCount: number;
	/** Canvas holding the requested frame (created/cached on demand). */
	getFrameCanvas: (index: number) => CanvasImageSource | null;
}

interface LoadedGif {
	metadata: GifAssetMetadata;
	frameWidth: number;
	frameHeight: number;
	rgbaFrames: Uint8ClampedArray[];
	canvasCache: Map<number, CanvasImageSource>;
}

/** Converts decoded RGBA bytes into an ImageData whose buffer is an
 *  `ArrayBuffer` (ImageData does not accept a shared/generic-backed view). */
export function gifFrameImageData({
	rgba,
	width,
	height,
}: {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
}): ImageData {
	const pixels = new Uint8ClampedArray(new ArrayBuffer(rgba.length));
	pixels.set(rgba);
	return new ImageData(pixels, width, height);
}

const FRAME_CANVAS_CACHE_LIMIT = 24;
const gifCache = new Map<string, Promise<LoadedGif>>();

function createFrameCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): {
	canvas: CanvasImageSource;
	context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
} {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		return { canvas, context: canvas.getContext("2d") };
	}
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return { canvas, context: canvas.getContext("2d") };
	}
	return { canvas: null as unknown as CanvasImageSource, context: null };
}

async function loadGif(url: string): Promise<LoadedGif> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Could not read GIF (${response.status})`);
	}
	const decoded = await decodeGif(await response.arrayBuffer());
	const metadata = gifMetadataFromDecode(decoded);
	return {
		metadata,
		frameWidth: decoded.width,
		frameHeight: decoded.height,
		rgbaFrames: decoded.frames.map((frame) => frame.rgba),
		canvasCache: new Map(),
	};
}

function getCachedGif(url: string): Promise<LoadedGif> {
	const cached = gifCache.get(url);
	if (cached) return cached;
	const promise = loadGif(url);
	gifCache.set(url, promise);
	// A failed decode must not be cached forever: drop it so a retry can work.
	void promise.catch(() => gifCache.delete(url));
	return promise;
}

/**
 * Loads (or reuses) the decoded frames for a GIF asset URL. Throws when the
 * bytes cannot be read or decode, which the renderer treats as "not visible".
 */
export async function loadGifSource({
	url,
}: {
	url: string;
}): Promise<GifFrameSource> {
	const loaded = await getCachedGif(url);

	const getFrameCanvas = (index: number): CanvasImageSource | null => {
		const clamped = Math.max(
			0,
			Math.min(loaded.rgbaFrames.length - 1, Math.floor(index)),
		);
		const cached = loaded.canvasCache.get(clamped);
		if (cached) return cached;

		const { canvas, context } = createFrameCanvas({
			width: loaded.frameWidth,
			height: loaded.frameHeight,
		});
		const rgba = loaded.rgbaFrames[clamped];
		if (!context || !rgba) return null;
		context.putImageData(
			gifFrameImageData({
				rgba,
				width: loaded.frameWidth,
				height: loaded.frameHeight,
			}),
			0,
			0,
		);

		loaded.canvasCache.set(clamped, canvas);
		if (loaded.canvasCache.size > FRAME_CANVAS_CACHE_LIMIT) {
			const oldest = loaded.canvasCache.keys().next().value;
			if (oldest !== undefined) loaded.canvasCache.delete(oldest);
		}
		return canvas;
	};

	return {
		metadata: loaded.metadata,
		frameCount: loaded.rgbaFrames.length,
		getFrameCanvas,
	};
}

/** Test/teardown hook: forget decoded GIFs (e.g. when an asset is deleted). */
export function clearGifFrameCache(url?: string): void {
	if (url) {
		gifCache.delete(url);
		return;
	}
	gifCache.clear();
}
