import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

/**
 * Reads one pixel out of the compositor's present canvas, as `#rrggbb`.
 *
 * The chroma-key eyedropper uses exactly this: the user taps the preview, and
 * the colour under the finger becomes the key. It reads the SAME canvas the
 * preview presents (a WebGL2 readback through a 2D probe, the path the
 * preview-parity harness already measures), never the element's source frame —
 * so what is picked is what the user sees.
 *
 * `x`/`y` are normalised 0..1 across the canvas. Returns `null` when there is
 * no canvas or no readable context (a degraded/GPU-less preview).
 */
export function sampleCompositorColor({ x, y }: { x: number; y: number }): string | null {
	const canvas = wasmCompositor.getCanvas();
	if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
	const probe = createCanvasSurface({ width: canvas.width, height: canvas.height });
	try {
		probe.context.drawImage(canvas, 0, 0);
	} catch {
		return null;
	}
	const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x * canvas.width)));
	const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y * canvas.height)));
	const data = probe.context.getImageData(px, py, 1, 1).data;
	const hex = (value: number) => value.toString(16).padStart(2, "0");
	return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
}

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		return wasmCompositor.getCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.render({ node, time });

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		measureSpanSync({
			name: "drawImage",
			fn: () =>
				ctx.drawImage(
					wasmCompositor.getCanvas(),
					0,
					0,
					targetCanvas.width,
					targetCanvas.height,
				),
		});
		onRenderPerfFrameComplete();
	}
}
