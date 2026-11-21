import type { ParamDefinition } from "@/params";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

/**
 * Narrow an arbitrary param value to a stroke alignment. Renderer params arrive
 * as `Record<string, unknown>`, so trusting `params.strokeAlign` blindly is one
 * imported or persisted project away from an invalid enum member.
 */
export function resolveStrokeAlign(value: unknown): GraphicStrokeAlign {
	return value === "inside" || value === "outside" ? value : "center";
}

export const STROKE_ALIGN_PARAM: ParamDefinition<"strokeAlign"> = {
	key: "strokeAlign",
	label: "Stroke align",
	type: "select",
	default: "center",
	group: "stroke",
	options: [
		{ value: "inside", label: "Inside" },
		{ value: "center", label: "Center" },
		{ value: "outside", label: "Outside" },
	],
};
