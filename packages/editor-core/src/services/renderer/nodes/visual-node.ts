import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, CropRect, FramingMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	framing?: FramingMode;
	/** Normalised source region, resolved by `scene-builder.ts`. Absent = full frame. */
	crop?: CropRect;
	effects?: Effect[];
	masks?: Mask[];
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	/**
	 * Identity of the PIXELS currently in `source`, for sources whose backing
	 * object is reused while its content changes (mediabunny's `CanvasSink`
	 * cycles a small pool of canvases, so a later frame can arrive in the very
	 * same canvas object as an earlier one). The texture cache compares this
	 * before skipping an upload; absent (images, stickers, graphics) means the
	 * source's object identity alone is enough.
	 */
	sourceRevision?: string;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
