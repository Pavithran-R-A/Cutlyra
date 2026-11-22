/**
 * VISUAL OVERLAYS — stickers and graphics in the export path.
 *
 * Until now `renderOverlayFrames` prerendered only text and captions, so a
 * sticker or graphic the user placed showed in the preview and then vanished
 * from the exported video entirely (disclosed gap in overlay-frames.ts). This
 * module supplies the geometry half of the fix: given a resolved visual
 * overlay node it produces a plain draw plan — source pixels, destination
 * quad, rotation, flip, opacity — using the SAME `computeVisualTransform`
 * the preview compositor calls. `renderOverlayFrames` then rasterizes that
 * plan into its existing full-canvas PNG, so stickers ride the compositing
 * pipeline that already has decoded-frame coverage.
 *
 * The plan is pure data so it can be tested headlessly: no canvas, no
 * `drawImage`, no GPU. Anything that cannot be drawn (missing asset, zero
 * size) yields `null` and the overlay layer simply omits that node; a broken
 * sticker must never crash an export or punch a hole in the frame.
 */
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { StickerNode } from "@/services/renderer/nodes/sticker-node";
import type { ResolvedGraphicNodeState } from "@/services/renderer/nodes/graphic-node";
import type { ResolvedVisualSourceNodeState } from "@/services/renderer/nodes/visual-node";
import type { QuadTransformDescriptor } from "@/services/renderer/compositor/types";
import { computeVisualTransform } from "@/services/renderer/compositor/frame-descriptor";
import { FULL_CROP } from "@/rendering";
import type { CropRect } from "@/rendering";

export type VisualOverlayNode = StickerNode | GraphicNode;

export interface VisualOverlaySourceRect {
	sourceX: number;
	sourceY: number;
	sourceWidth: number;
	sourceHeight: number;
}

export interface VisualOverlayDrawPlan extends QuadTransformDescriptor {
	source: CanvasImageSource;
	opacity: number;
	/** Pixel rectangle sampled out of `source`. Equal to the full source for
	 *  an uncropped element. */
	sourceRect: VisualOverlaySourceRect;
}

export function isVisualOverlayNode(node: unknown): node is VisualOverlayNode {
	return node instanceof StickerNode || node instanceof GraphicNode;
}

/** The pixels the GPU path would sample. Sticker images carry their own
 *  natural size; graphics are always rendered at the registry's source size.
 *  `resolved.sourceWidth` is the AUTHORED size (an intrinsic override saved
 *  with the element), which is not necessarily the pixel size of the image
 *  the browser decoded, so it cannot be used for `drawImage` coordinates. */
function sourcePixelSize({
	node,
}: {
	node: VisualOverlayNode;
}): { width: number; height: number } | null {
	if (node instanceof GraphicNode) {
		return {
			width: DEFAULT_GRAPHIC_SOURCE_SIZE,
			height: DEFAULT_GRAPHIC_SOURCE_SIZE,
		};
	}
	const resolved = node.resolved as ResolvedVisualSourceNodeState | null;
	const source = resolved?.source as
		| (CanvasImageSource & { naturalWidth?: number; naturalHeight?: number })
		| undefined;
	if (!source) {
		return null;
	}
	const width = source.naturalWidth ?? resolved?.sourceWidth ?? 0;
	const height = source.naturalHeight ?? resolved?.sourceHeight ?? 0;
	if (!(width > 0) || !(height > 0)) {
		return null;
	}
	return { width, height };
}

function resolveSource({
	node,
}: {
	node: VisualOverlayNode;
}): CanvasImageSource | null {
	if (node instanceof GraphicNode) {
		const resolved = node.resolved as ResolvedGraphicNodeState | null;
		if (!resolved) return null;
		try {
			return node.getSource({ resolvedParams: resolved.resolvedParams });
		} catch {
			// A bad graphic definition must not take the export down.
			return null;
		}
	}
	const resolved = node.resolved as ResolvedVisualSourceNodeState | null;
	return resolved?.source ?? null;
}

function cropSourceRect({
	pixelWidth,
	pixelHeight,
	crop,
}: {
	pixelWidth: number;
	pixelHeight: number;
	crop: CropRect;
}): VisualOverlaySourceRect {
	const rect: CropRect = crop ?? FULL_CROP;
	return {
		sourceX: rect.x * pixelWidth,
		sourceY: rect.y * pixelHeight,
		sourceWidth: rect.width * pixelWidth,
		sourceHeight: rect.height * pixelHeight,
	};
}

/** `null` when the node is invisible at this time, its asset is missing, or
 *  its geometry is degenerate. */
export function buildVisualOverlayDrawPlan({
	node,
	canvasWidth,
	canvasHeight,
}: {
	node: VisualOverlayNode;
	canvasWidth: number;
	canvasHeight: number;
}): VisualOverlayDrawPlan | null {
	if (!node.resolved) {
		return null;
	}

	const source = resolveSource({ node });
	if (!source) {
		return null;
	}
	const pixelSize = sourcePixelSize({ node });
	if (!pixelSize) {
		return null;
	}

	const transform = computeVisualTransform({
		renderer: { width: canvasWidth, height: canvasHeight },
		resolved: node.resolved as
			| Pick<ResolvedVisualSourceNodeState, "transform">
			| Pick<ResolvedGraphicNodeState, "transform">,
		sourceWidth:
			node instanceof GraphicNode
				? DEFAULT_GRAPHIC_SOURCE_SIZE
				: (node.resolved as ResolvedVisualSourceNodeState).sourceWidth,
		sourceHeight:
			node instanceof GraphicNode
				? DEFAULT_GRAPHIC_SOURCE_SIZE
				: (node.resolved as ResolvedVisualSourceNodeState).sourceHeight,
		framing: node.params.framing,
		crop: node.params.crop,
	});

	if (!(transform.width > 0) || !(transform.height > 0)) {
		return null;
	}

	return {
		...transform,
		source,
		opacity: node.resolved.opacity,
		sourceRect: cropSourceRect({
			pixelWidth: pixelSize.width,
			pixelHeight: pixelSize.height,
			crop: node.params.crop ?? FULL_CROP,
		}),
	};
}
