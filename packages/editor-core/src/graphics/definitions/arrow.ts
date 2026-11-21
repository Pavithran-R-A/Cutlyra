import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";

interface ArrowParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	/** Degrees clockwise; 0 points right. */
	rotation: number;
}

const ARROW_PARAMS: ParamDefinition<keyof ArrowParams & string>[] = [
	{
		key: "fill",
		label: "Fill",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#000000",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 0,
		min: 0,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	STROKE_ALIGN_PARAM,
	{
		key: "rotation",
		label: "Rotation",
		type: "number",
		default: 0,
		min: 0,
		max: 359,
		step: 1,
		shortLabel: "°",
	},
];

/**
 * Arrow sticker: a shaft plus a triangular head, drawn in a normalised box and
 * then rotated about the centre. Points right at 0 degrees, so it starts as a
 * usable callout instead of needing a transform tweak before it reads.
 */
export const arrowGraphicDefinition: GraphicDefinition = {
	id: "arrow",
	name: "Arrow",
	keywords: ["arrow", "pointer", "direction", "callout"],
	params: ARROW_PARAMS,
	render({ ctx, params, width, height }) {
		const fill = String(params.fill ?? "#ffffff");
		const stroke = String(params.stroke ?? "#000000");
		const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
		const strokeAlign = (params.strokeAlign ?? "center") as GraphicStrokeAlign;
		const rotation = Number(params.rotation ?? 0);
		const inset = strokeAlign === "center" ? strokeWidth / 2 : 0;
		const size = Math.max(1, Math.min(width, height) - inset * 2);
		const centerX = width / 2;
		const centerY = height / 2;

		ctx.clearRect(0, 0, width, height);
		const path = new Path2D();
		const left = centerX - size * 0.4;
		const shaftEnd = centerX + size * 0.12;
		const tip = centerX + size * 0.42;
		const shaftHalf = size * 0.1;
		const headHalf = size * 0.26;
		path.moveTo(left, centerY - shaftHalf);
		path.lineTo(shaftEnd, centerY - shaftHalf);
		path.lineTo(shaftEnd, centerY - headHalf);
		path.lineTo(tip, centerY);
		path.lineTo(shaftEnd, centerY + headHalf);
		path.lineTo(shaftEnd, centerY + shaftHalf);
		path.lineTo(left, centerY + shaftHalf);
		path.closePath();

		ctx.save();
		if (rotation !== 0) {
			ctx.translate(centerX, centerY);
			ctx.rotate((rotation * Math.PI) / 180);
			ctx.translate(-centerX, -centerY);
		}
		ctx.fillStyle = fill;
		ctx.fill(path);
		if (strokeWidth > 0) {
			applyAlignedStroke({
				ctx,
				path,
				strokeWidth,
				strokeAlign,
				strokeColor: stroke,
			});
		}
		ctx.restore();
	},
};
