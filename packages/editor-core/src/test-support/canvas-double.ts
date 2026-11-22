/**
 * DOM canvas doubles for headless tests.
 *
 * `bun test` runs without a DOM, so `new OffscreenCanvas(...)` and every other
 * member of `CanvasImageSource` are unavailable. Geometry and frame-descriptor
 * tests only ever forward a source reference into a texture descriptor — the
 * actual WebGL upload happens in the browser — so a bare object is a faithful
 * stand-in for that reference.
 *
 * The type assertion these need lives here, once, instead of in every test:
 * `CanvasImageSource` is a DOM union with no constructible member off-browser,
 * and the alternative (casting at each call site) just spreads the same
 * unverifiable claim across the suite.
 */
export function canvasDouble(): CanvasImageSource {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {} as CanvasImageSource;
}

/** One filled/stroked text run, captured at draw time (so a test can prove
 *  which canvas state was active for THAT draw, not just at the end). */
export interface RecordedTextDraw {
	text: string;
	x: number;
	y: number;
	fillStyle: string;
	lineWidth: number;
	shadowBlur: number;
	shadowOffsetX: number;
	shadowOffsetY: number;
}

export interface RecordingTextContext {
	/** The draw target — pass this where a `TextCanvasContext` is expected. */
	ctx: CanvasRenderingContext2D;
	fills: RecordedTextDraw[];
	strokes: RecordedTextDraw[];
	/** Live canvas state, readable between draws. */
	state: {
		font: string;
		fillStyle: string;
		lineWidth: number;
		shadowColor: string;
		shadowBlur: number;
		shadowOffsetX: number;
		shadowOffsetY: number;
	};
}

const RECORDED_STATE_KEYS = [
	"font",
	"textAlign",
	"textBaseline",
	"fillStyle",
	"strokeStyle",
	"lineWidth",
	"lineJoin",
	"lineCap",
	"shadowColor",
	"shadowBlur",
	"shadowOffsetX",
	"shadowOffsetY",
	"letterSpacing",
] as const;

/**
 * A Canvas2D stand-in that records text draws and honours save/restore for
 * the text-relevant state. `bun test` has no canvas, and text shadow/border
 * ordering is precisely a question of "which state was active for this
 * fill" — a bare spy that ignores `save`/`restore` could not tell the
 * difference between a shadow that is scoped and one that leaks onto the
 * fill.
 */
export function recordingTextContext(): RecordingTextContext {
	const fills: RecordedTextDraw[] = [];
	const strokes: RecordedTextDraw[] = [];
	const stack: Array<Record<string, string | number>> = [];

	const target = {
		font: "",
		textAlign: "center",
		textBaseline: "middle",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineJoin: "round",
		lineCap: "round",
		shadowColor: "transparent",
		shadowBlur: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		letterSpacing: "0px",
		save() {
			const snapshot: Record<string, string | number> = {};
			for (const key of RECORDED_STATE_KEYS) snapshot[key] = target[key];
			stack.push(snapshot);
		},
		restore() {
			const snapshot = stack.pop();
			if (!snapshot) return;
			// `Object.assign` rather than per-key writes: writing through a
			// union of literal keys narrows to `never` under tsc.
			Object.assign(target, snapshot);
		},
		translate() {},
		scale() {},
		rotate() {},
		beginPath() {},
		roundRect() {},
		fill() {},
		measureText() {
			// Only `.width` is read by the text layout/decorations code these
			// tests drive; a full TextMetrics cannot be constructed without a
			// real font engine, so the rest is intentionally absent.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return { width: 10 } as TextMetrics;
		},
		// Canvas2D's own signature is positional; matching it is the point of
		// the double.
		// eslint-disable-next-line opencut/prefer-object-params
		fillText(text: string, x: number, y: number) {
			fills.push({
				text,
				x,
				y,
				fillStyle: target.fillStyle,
				lineWidth: target.lineWidth,
				shadowBlur: target.shadowBlur,
				shadowOffsetX: target.shadowOffsetX,
				shadowOffsetY: target.shadowOffsetY,
			});
		},
		// eslint-disable-next-line opencut/prefer-object-params
		strokeText(text: string, x: number, y: number) {
			strokes.push({
				text,
				x,
				y,
				fillStyle: target.fillStyle,
				lineWidth: target.lineWidth,
				shadowBlur: target.shadowBlur,
				shadowOffsetX: target.shadowOffsetX,
				shadowOffsetY: target.shadowOffsetY,
			});
		},
	};

	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		ctx: target as unknown as CanvasRenderingContext2D,
		fills,
		strokes,
		state: target,
	};
}

/** OffscreenCanvas twin of {@link canvasDouble}, for `rendered` texture entries. */
export function offscreenCanvasDouble(): OffscreenCanvas {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {} as OffscreenCanvas;
}
