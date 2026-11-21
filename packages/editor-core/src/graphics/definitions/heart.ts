import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";

interface HeartParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
}

const HEART_PARAMS: ParamDefinition<keyof HeartParams & string>[] = [
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
];

/**
 * Heart sticker. Two symmetric cubic curves anchored on the vertical centre
 * line, sized from the smaller axis so it stays a heart on any canvas aspect
 * rather than stretching into a blob.
 */
export const heartGraphicDefinition: GraphicDefinition = {
	id: "heart",
	name: "Heart",
	keywords: ["heart", "love", "like", "favourite", "favorite"],
	params: HEART_PARAMS,
	render({ ctx, params, width, height }) {
		const fill = String(params.fill ?? "#ffffff");
		const stroke = String(params.stroke ?? "#000000");
		const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
		const strokeAlign = (params.strokeAlign ?? "center") as GraphicStrokeAlign;
		const inset = strokeAlign === "center" ? strokeWidth / 2 : 0;
		const size = Math.max(1, Math.min(width, height) - inset * 2);
		const centerX = width / 2;
		const centerY = height / 2;

		ctx.clearRect(0, 0, width, height);
		const path = new Path2D();
		const bottom = centerY + size * 0.34;
		const notch = centerY - size * 0.2;
		path.moveTo(centerX, bottom);
		path.bezierCurveTo(
			centerX + size * 0.56,
			centerY + size * 0.02,
			centerX + size * 0.44,
			centerY - size * 0.44,
			centerX,
			notch,
		);
		path.bezierCurveTo(
			centerX - size * 0.44,
			centerY - size * 0.44,
			centerX - size * 0.56,
			centerY + size * 0.02,
			centerX,
			bottom,
		);
		path.closePath();
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
	},
};
