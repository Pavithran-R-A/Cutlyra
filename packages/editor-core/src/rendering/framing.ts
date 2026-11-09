export type FramingMode = "fit" | "fill";

export const DEFAULT_FRAMING: FramingMode = "fit";

export function readFramingFromParams({
	params,
}: {
	params: Record<string, unknown> | undefined;
}): FramingMode {
	const value = params?.framing;
	return value === "fill" ? "fill" : "fit";
}

export function resolveFramingScale({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	framing,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	framing: FramingMode;
}): number {
	if (sourceWidth <= 0 || sourceHeight <= 0) {
		return 1;
	}
	const scaleX = canvasWidth / sourceWidth;
	const scaleY = canvasHeight / sourceHeight;
	return framing === "fill"
		? Math.max(scaleX, scaleY)
		: Math.min(scaleX, scaleY);
}
