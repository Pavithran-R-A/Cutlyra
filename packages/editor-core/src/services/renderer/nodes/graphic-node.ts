import { createCanvasSurface } from "../canvas-utils";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	getGraphicDefinition,
	registerDefaultGraphics,
} from "@/graphics";
import type { ParamValues } from "@/params";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface GraphicNodeParams extends VisualNodeParams {
	definitionId: string;
	params: ParamValues;
}

export interface ResolvedGraphicNodeState extends ResolvedVisualNodeState {
	resolvedParams: ParamValues;
}

export class GraphicNode extends VisualNode<
	GraphicNodeParams,
	ResolvedGraphicNodeState
> {
	private cachedKey: string | null = null;
	private cachedSource: OffscreenCanvas | null = null;
	// Last rendered time + canvas for animated graphics, so a single frame's
	// repeated getSource calls (preview + export) don't regenerate twice.
	private lastAnimatedTime: number | null = null;
	private lastAnimatedSource: OffscreenCanvas | null = null;

	constructor(params: GraphicNodeParams) {
		super(params);
		registerDefaultGraphics();
	}

	private isAnimated(): boolean {
		try {
			return getGraphicDefinition({ definitionId: this.params.definitionId })
				.animated === true;
		} catch {
			return false;
		}
	}

	getSource({
		resolvedParams,
		time = 0,
	}: {
		resolvedParams: ParamValues;
		time?: number;
	}): OffscreenCanvas {
		const definition = getGraphicDefinition({
			definitionId: this.params.definitionId,
		});

		if (definition.animated) {
			// Bounded cache: reuse only when the time is identical to the last
			// render, so we never grow an unbounded frame collection.
			if (
				this.lastAnimatedSource &&
				this.lastAnimatedTime !== null &&
				this.lastAnimatedTime === time
			) {
				return this.lastAnimatedSource;
			}
			const { canvas, context } = createCanvasSurface({
				width: DEFAULT_GRAPHIC_SOURCE_SIZE,
				height: DEFAULT_GRAPHIC_SOURCE_SIZE,
			});
			definition.render({
				ctx: context,
				params: resolvedParams,
				width: DEFAULT_GRAPHIC_SOURCE_SIZE,
				height: DEFAULT_GRAPHIC_SOURCE_SIZE,
				time,
			});
			this.lastAnimatedTime = time;
			this.lastAnimatedSource = canvas;
			// Drop the stale static cache so animated and static paths never
			// share a canvas.
			this.cachedSource = null;
			this.cachedKey = null;
			return canvas;
		}

		const cacheKey = JSON.stringify({
			definitionId: this.params.definitionId,
			params: resolvedParams,
		});
		if (this.cachedSource && this.cachedKey === cacheKey) {
			return this.cachedSource;
		}

		const { canvas, context } = createCanvasSurface({
			width: DEFAULT_GRAPHIC_SOURCE_SIZE,
			height: DEFAULT_GRAPHIC_SOURCE_SIZE,
		});

		definition.render({
			ctx: context,
			params: resolvedParams,
			width: DEFAULT_GRAPHIC_SOURCE_SIZE,
			height: DEFAULT_GRAPHIC_SOURCE_SIZE,
			time,
		});

		this.cachedKey = cacheKey;
		this.cachedSource = canvas;
		return canvas;
	}
}