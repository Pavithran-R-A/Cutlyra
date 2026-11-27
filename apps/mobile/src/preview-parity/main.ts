/**
 * Preview pixel parity harness (crop, Milestone 1A).
 *
 * The descriptor/geometry tests prove the NUMBERS. They cannot prove the
 * shader actually samples the cropped rectangle out of the uploaded texture —
 * that needs real pixels out of the real compositor. This page drives
 * `buildFrameDescriptor` (the same code the editor's preview uses) into
 * `wasmCompositor` on a real GPU context and reads the rendered pixels back.
 *
 * Fixture and expectations are deliberately the same ones the native export
 * test (`ExportCropInstrumentedTest`) decodes out of an exported MP4:
 * a 320x240 four-quadrant image (red / green / blue / yellow) sampled at the
 * same fractional points. If both paths read the same quadrant at the same
 * point, preview and export agree about what is visible.
 *
 * Open `/preview-parity.html` from `bun run dev` (apps/mobile). Results land
 * in `window.__PREVIEW_PARITY__`.
 */
import { buildFrameDescriptor } from "@cutlyra/editor-core/services/renderer/compositor/frame-descriptor";
import { wasmCompositor } from "@cutlyra/editor-core/services/renderer/compositor/wasm-compositor";
import type { FrameDescriptor } from "@cutlyra/editor-core/services/renderer/compositor/types";
import { ImageNode } from "@cutlyra/editor-core/services/renderer/nodes/image-node";
import { RootNode } from "@cutlyra/editor-core/services/renderer/nodes/root-node";
import type { ResolvedVisualSourceNodeState } from "@cutlyra/editor-core/services/renderer/nodes/visual-node";
import type { CropRect } from "@cutlyra/editor-core/rendering";
import type { Mask } from "@/masks/types";
import { registerDefaultMasks } from "@/masks";
import { initializeGpu } from "opencut-wasm";

/**
 * Force the WebGL2 backend before the compositor initialises.
 *
 * Two reasons: (1) it is the backend the real Android app uses — System
 * WebView has no WebGPU, so the shipped preview is WebGL2; (2) a WebGPU-backed
 * canvas cannot be sampled from page JS through `drawImage`/`getImageData`,
 * which is how this harness reads the rendered pixels. Shadowing
 * `navigator.gpu` on the instance is enough: the wasm side detects WebGPU by
 * reading that property.
 */
try {
	Object.defineProperty(navigator, "gpu", {
		value: undefined,
		configurable: true,
	});
} catch {
	// Best effort — a browser that refuses the shadow runs on WebGPU and the
	// readback will report that instead of failing silently.
}

const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 240;

type Channel = "red" | "green" | "blue" | "yellow" | "black" | "mixed";

type Sample = { x: number; y: number; expected: Channel };

type CaseResult = {
	name: string;
	ok: boolean;
	detail: string;
};

type Fixture = { canvas: HTMLCanvasElement; width: number; height: number };

// ---------------------------------------------------------------- fixture

/** Same four quadrants as the native export test, flat-filled so a decoded /
 * rendered pixel is unambiguous. Redrawable into an existing canvas so the
 * "video frame swap" cases can prove the cache notices new pixels in the same
 * source object. */
function paintQuadrants(
	canvas: HTMLCanvasElement,
	palette: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
	} = {
		topLeft: "#ff0000",
		topRight: "#00ff00",
		bottomLeft: "#0000ff",
		bottomRight: "#ffff00",
	},
) {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d context unavailable");
	const halfW = canvas.width / 2;
	const halfH = canvas.height / 2;
	ctx.fillStyle = palette.topLeft;
	ctx.fillRect(0, 0, halfW, halfH);
	ctx.fillStyle = palette.topRight;
	ctx.fillRect(halfW, 0, canvas.width - halfW, halfH);
	ctx.fillStyle = palette.bottomLeft;
	ctx.fillRect(0, halfH, halfW, canvas.height - halfH);
	ctx.fillStyle = palette.bottomRight;
	ctx.fillRect(halfW, halfH, canvas.width - halfW, canvas.height - halfH);
}

function createQuadrantFixture(
	width = CANVAS_WIDTH,
	height = CANVAS_HEIGHT,
): Fixture {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	paintQuadrants(canvas);
	return { canvas, width, height };
}

// ------------------------------------------------------------ node fixtures

function resolvedState({
	fixture,
	scaleX = 1,
	scaleY = 1,
	rotate = 0,
	position = { x: 0, y: 0 },
	sourceRevision,
}: {
	fixture: Fixture;
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
	position?: { x: number; y: number };
	sourceRevision?: string;
}): ResolvedVisualSourceNodeState {
	return {
		localTime: 0,
		opacity: 1,
		effectPasses: [],
		transform: { scaleX, scaleY, rotate, position },
		source: fixture.canvas,
		sourceWidth: fixture.width,
		sourceHeight: fixture.height,
		...(sourceRevision === undefined ? {} : { sourceRevision }),
	};
}

function imageNode({
	fixture,
	crop,
	framing,
	scaleX,
	scaleY,
	rotate,
	position,
	sourceRevision,
	masks,
}: {
	fixture: Fixture;
	crop?: CropRect;
	framing?: "fit" | "fill";
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
	position?: { x: number; y: number };
	sourceRevision?: string;
	masks?: Mask[];
}): ImageNode {
	const node = new ImageNode({
		url: "preview-parity-fixture.png",
		duration: 10_000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 10_000,
		transform: {
			scaleX: scaleX ?? 1,
			scaleY: scaleY ?? 1,
			rotate: rotate ?? 0,
			position: position ?? { x: 0, y: 0 },
		},
		opacity: 1,
		...(framing ? { framing } : {}),
		...(crop ? { crop } : {}),
		...(masks ? { masks } : {}),
	});
	node.resolved = resolvedState({
		fixture,
		scaleX,
		scaleY,
		rotate,
		position,
		sourceRevision,
	});
	return node;
}

function createSolidFixture(color: string): Fixture {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 240;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2d fixture context unavailable");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	return { canvas, width: canvas.width, height: canvas.height };
}

// ------------------------------------------------------------ pixel reading

/** Reads the compositor's canvas immediately after a synchronous `render()` —
 * before the browser composites and discards the drawing buffer. */
function readFrame(): ImageData {
	return readCanvas(wasmCompositor.getCanvas());
}

function readCanvas(source: HTMLCanvasElement): ImageData {
	const probe = document.createElement("canvas");
	probe.width = source.width;
	probe.height = source.height;
	const ctx = probe.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("2d readback context unavailable");
	ctx.drawImage(source, 0, 0);
	return ctx.getImageData(0, 0, probe.width, probe.height);
}

function nonBlackCount(pixels: ImageData): number {
	let count = 0;
	for (let index = 0; index < pixels.data.length; index += 4) {
		if (pixels.data[index] > 8 || pixels.data[index + 1] > 8 || pixels.data[index + 2] > 8) {
			count += 1;
		}
	}
	return count;
}

function dominantAt(
	pixels: ImageData,
	fractionX: number,
	fractionY: number,
): { channel: Channel; rgb: [number, number, number] } {
	const cx = Math.min(
		pixels.width - 5,
		Math.max(4, Math.round(pixels.width * fractionX)),
	);
	const cy = Math.min(
		pixels.height - 5,
		Math.max(4, Math.round(pixels.height * fractionY)),
	);
	let r = 0;
	let g = 0;
	let b = 0;
	let n = 0;
	// 9x9 mean, exactly like the native test's decoded-frame sampler, so
	// encoding/antialiasing noise cannot decide a channel.
	for (let y = cy - 4; y <= cy + 4; y++) {
		for (let x = cx - 4; x <= cx + 4; x++) {
			const index = (y * pixels.width + x) * 4;
			r += pixels.data[index];
			g += pixels.data[index + 1];
			b += pixels.data[index + 2];
			n += 1;
		}
	}
	const mean: [number, number, number] = [
		Math.round(r / n),
		Math.round(g / n),
		Math.round(b / n),
	];
	return { channel: classify(mean), rgb: mean };
}

/** Same classification rules as the Android test's `dominant()`. */
function classify([r, g, b]: [number, number, number]): Channel {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max < 40) return "black";
	if (max - min < 48) return "mixed";
	if (r > 96 && g > 96 && b < 96) return "yellow";
	if (r > 96 && b > 96 && g < 96) return "yellow";
	if (r > g && r > b) return "red";
	if (g > r && g > b) return "green";
	return "blue";
}

// ------------------------------------------------------------------ runner

const results: CaseResult[] = [];

function check({
	name,
	pixels,
	samples,
}: {
	name: string;
	pixels: ImageData;
	samples: Sample[];
}): CaseResult {
	const details: string[] = [];
	let ok = true;
	for (const sample of samples) {
		const actual = dominantAt(pixels, sample.x, sample.y);
		const passed = actual.channel === sample.expected;
		if (!passed) ok = false;
		details.push(
			`(${sample.x},${sample.y}) expected ${sample.expected} got ${actual.channel} rgb(${actual.rgb.join(",")})`,
		);
	}
	const result = {
		name,
		ok,
		detail: details.join(" | "),
	};
	results.push(result);
	return result;
}

async function renderAndRead({
	frame,
	textures,
}: {
	frame: FrameDescriptor;
	textures: Parameters<typeof wasmCompositor.syncTextures>[0];
}): Promise<ImageData> {
	wasmCompositor.syncTextures(textures);
	wasmCompositor.render(frame);
	return readFrame();
}

async function renderNode(node: ImageNode | RootNode): Promise<ImageData> {
	wasmCompositor.ensureInitialized({
		width: CANVAS_WIDTH,
		height: CANVAS_HEIGHT,
	});
	const { frame, textures } = await buildFrameDescriptor({
		node,
		renderer: {
			width: CANVAS_WIDTH,
			height: CANVAS_HEIGHT,
		} as never,
	});
	return renderAndRead({ frame, textures });
}

async function run(): Promise<void> {
	const host = document.getElementById("results");
	const log = (line: string) => {
		if (!host) return;
		const row = document.createElement("pre");
		row.textContent = line;
		host.appendChild(row);
	};

	// The editor bootstraps the mask registry; a bare harness must too, or
	// every mask descriptor throws "Unknown mask: <type>" before it can be
	// rendered.
	registerDefaultMasks();

	await initializeGpu();
	console.log("initializeGpu() resolved");

	const fixture = createQuadrantFixture();

	// Diagnostics hook: keeps the real canvas reachable for readback checks.
	wasmCompositor.ensureInitialized({
		width: CANVAS_WIDTH,
		height: CANVAS_HEIGHT,
	});
	const compositorCanvas = wasmCompositor.getCanvas();
	compositorCanvas.style.position = "fixed";
	compositorCanvas.style.left = "0";
	compositorCanvas.style.top = "0";
	compositorCanvas.style.width = "320px";
	compositorCanvas.style.height = "240px";
	compositorCanvas.style.zIndex = "-1";
	document.body.appendChild(compositorCanvas);
	(
		window as unknown as {
			__PARITY_DEBUG__: {
				readNow: () => number;
				readAfterRaf: () => Promise<number>;
				contexts: () => string[];
			};
		}
	).__PARITY_DEBUG__ = {
		readNow: () => nonBlackCount(readCanvas(compositorCanvas)),
		readAfterRaf: () =>
			new Promise<number>((resolve) => {
				requestAnimationFrame(() =>
					resolve(nonBlackCount(readCanvas(compositorCanvas))),
				);
			}),
		contexts: () => {
			const found: string[] = [];
			for (const type of ["webgpu", "webgl2", "2d"] as const) {
				try {
					if (compositorCanvas.getContext(type)) found.push(type);
				} catch {
					// locked to another type
				}
			}
			return found;
		},
	};

	// --- geometry/visibility cases mirroring the native export test ---------
	const cases: Array<{ name: string; node: ImageNode; samples: Sample[] }> = [
		{
			name: "uncropped",
			node: imageNode({ fixture }),
			samples: [
				{ x: 0.25, y: 0.25, expected: "red" },
				{ x: 0.75, y: 0.25, expected: "green" },
				{ x: 0.25, y: 0.75, expected: "blue" },
				{ x: 0.75, y: 0.75, expected: "yellow" },
			],
		},
		{
			// 160x240 kept region, fit scale 1 -> centred 160x240 with black
			// pillarbox bars.
			name: "left-half",
			node: imageNode({ fixture, crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
			samples: [
				{ x: 0.5, y: 0.25, expected: "red" },
				{ x: 0.5, y: 0.75, expected: "blue" },
				{ x: 0.05, y: 0.5, expected: "black" },
			],
		},
		{
			name: "right-half",
			node: imageNode({
				fixture,
				crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
			}),
			samples: [
				{ x: 0.5, y: 0.25, expected: "green" },
				{ x: 0.5, y: 0.75, expected: "yellow" },
				{ x: 0.95, y: 0.5, expected: "black" },
			],
		},
		{
			name: "top-half",
			node: imageNode({ fixture, crop: { x: 0, y: 0, width: 1, height: 0.5 } }),
			samples: [
				{ x: 0.25, y: 0.5, expected: "red" },
				{ x: 0.75, y: 0.5, expected: "green" },
				{ x: 0.5, y: 0.05, expected: "black" },
			],
		},
		{
			name: "bottom-half",
			node: imageNode({
				fixture,
				crop: { x: 0, y: 0.5, width: 1, height: 0.5 },
			}),
			samples: [
				{ x: 0.25, y: 0.5, expected: "blue" },
				{ x: 0.75, y: 0.5, expected: "yellow" },
				{ x: 0.5, y: 0.95, expected: "black" },
			],
		},
		{
			// Entirely inside the bottom-right yellow quadrant: a wrong UV
			// mapping (e.g. sampling the full texture) shows four quadrants.
			name: "centre-quarter",
			node: imageNode({
				fixture,
				crop: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 },
			}),
			samples: [
				{ x: 0.1, y: 0.1, expected: "yellow" },
				{ x: 0.5, y: 0.5, expected: "yellow" },
				{ x: 0.9, y: 0.9, expected: "yellow" },
			],
		},
		{
			name: "off-centre",
			node: imageNode({
				fixture,
				crop: { x: 0.1, y: 0.6, width: 0.3, height: 0.3 },
			}),
			samples: [
				{ x: 0.5, y: 0.5, expected: "blue" },
				{ x: 0.1, y: 0.1, expected: "blue" },
			],
		},
	];

	for (const testCase of cases) {
		const pixels = await renderNode(testCase.node);
		const result = check({
			name: testCase.name,
			pixels,
			samples: testCase.samples,
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- orientation of the input -----------------------------------------
	const portrait = createQuadrantFixture(240, 320);
	{
		const pixels = await renderNode(
			imageNode({ fixture: portrait, crop: { x: 0, y: 0, width: 0.5, height: 1 } }),
		);
		const result = check({
			name: "portrait-left-half",
			pixels,
			samples: [
				{ x: 0.5, y: 0.25, expected: "red" },
				{ x: 0.5, y: 0.75, expected: "blue" },
			],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}
	{
		const landscape = createQuadrantFixture(480, 240);
		const pixels = await renderNode(imageNode({ fixture: landscape }));
		const result = check({
			name: "landscape-uncropped",
			pixels,
			samples: [
				{ x: 0.25, y: 0.25, expected: "red" },
				{ x: 0.75, y: 0.25, expected: "green" },
				{ x: 0.25, y: 0.75, expected: "blue" },
				{ x: 0.5, y: 0.02, expected: "black" },
			],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- fit vs fill -------------------------------------------------------
	{
		const landscape = createQuadrantFixture(480, 240);
		const fillPixels = await renderNode(
			imageNode({ fixture: landscape, framing: "fill" }),
		);
		const result = check({
			name: "fill-covers-instead-of-letterboxing",
			pixels: fillPixels,
			samples: [
				// fit letterboxes here (black in the fit case below); fill
				// scales the source up until it covers the canvas.
				{ x: 0.25, y: 0.02, expected: "red" },
				{ x: 0.75, y: 0.98, expected: "yellow" },
			],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- rotation and flipping --------------------------------------------
	{
		const pixels = await renderNode(
			imageNode({
				fixture,
				crop: { x: 0, y: 0, width: 1, height: 0.5 },
				rotate: 90,
			}),
		);
		// The kept strip is 320x120; turned a quarter it is 120 wide, so the
		// old left/right axis becomes vertical and the horizontal extent
		// shrinks to a centred 120px column (black either side).
		const rotated = check({
			name: "rotate-90-turns-the-kept-strip",
			pixels,
			samples: [
				{ x: 0.25, y: 0.5, expected: "black" },
				{ x: 0.75, y: 0.5, expected: "black" },
			],
		});
		log(`${rotated.ok ? "PASS" : "FAIL"} ${rotated.name}: ${rotated.detail}`);
		const top = dominantAt(pixels, 0.5, 0.25).channel;
		const bottom = dominantAt(pixels, 0.5, 0.75).channel;
		const verticalOk =
			(top === "red" && bottom === "green") ||
			(top === "green" && bottom === "red");
		results.push({
			name: "rotate-90-keeps-the-cropped-content",
			ok: verticalOk,
			detail: `top=${top} bottom=${bottom} (expected red/green on the vertical axis)`,
		});
		log(
			`${verticalOk ? "PASS" : "FAIL"} rotate-90-keeps-the-cropped-content: top=${top} bottom=${bottom}`,
		);
	}
	{
		const pixels = await renderNode(
			imageNode({
				fixture,
				crop: { x: 0, y: 0, width: 1, height: 0.5 },
				scaleX: -1,
			}),
		);
		const result = check({
			name: "flip-x-mirrors-the-cropped-content",
			pixels,
			samples: [
				{ x: 0.25, y: 0.5, expected: "green" },
				{ x: 0.75, y: 0.5, expected: "red" },
			],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- multiple layers ---------------------------------------------------
	{
		const background = imageNode({ fixture });
		const overlay = imageNode({
			fixture,
			crop: { x: 0, y: 0, width: 0.5, height: 1 },
			// 160x240 kept -> half again, centred.
			scaleX: 0.5,
			scaleY: 0.5,
		});
		const root = new RootNode({ duration: 10_000 });
		root.children.push(background, overlay);
		const pixels = await renderNode(root);
		const result = check({
			name: "multi-layer-cropped-overlay-on-uncropped-background",
			pixels,
			samples: [
				// Centre column: overlay (cropped to the red/blue left strip).
				{ x: 0.5, y: 0.35, expected: "red" },
				{ x: 0.5, y: 0.65, expected: "blue" },
				// Outside the overlay: the uncropped background.
				{ x: 0.85, y: 0.5, expected: "yellow" },
			],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- masks: the same shape/position/feather contract the export shader
	// --- evaluates (ExportMaskInstrumentedTest) ----------------------------
	{
		const red = createSolidFixture("#ff0000");
		const blue = createSolidFixture("#0000ff");
		const base = {
			feather: 0,
			inverted: false,
			strokeColor: "#ffffff",
			strokeWidth: 0,
			strokeAlign: "center" as const,
		};
		const rectangle: Mask = {
			id: "mask-rect",
			type: "rectangle",
			params: {
				...base,
				centerX: 0,
				centerY: 0,
				width: 0.5,
				height: 0.5,
				rotation: 0,
				scale: 1,
			},
		};
		const ellipse: Mask = {
			id: "mask-ellipse",
			type: "ellipse",
			params: {
				...base,
				centerX: 0,
				centerY: 0,
				width: 0.5,
				height: 0.5,
				rotation: 0,
				scale: 1,
			},
		};
		const linear: Mask = {
			id: "mask-linear",
			type: "split",
			params: { ...base, centerX: 0, centerY: 0, rotation: 0 },
		};
		const inverted: Mask = {
			id: "mask-inverted",
			type: "rectangle",
			params: {
				...base,
				feather: 40,
				inverted: true,
				centerX: 0,
				centerY: 0,
				width: 0.6,
				height: 0.4,
				rotation: 30,
				scale: 1,
			},
		};

		async function renderMask(mask: Mask): Promise<ImageData> {
			const background = imageNode({ fixture: blue });
			const overlay = imageNode({ fixture: red, masks: [mask] });
			const root = new RootNode({ duration: 10_000 });
			root.children.push(background, overlay);
			return renderNode(root);
		}

		for (const [name, mask, samples] of [
			[
				"mask-rectangle",
				rectangle,
				[
					{ x: 0.5, y: 0.5, expected: "red" as Channel },
					{ x: 0.08, y: 0.08, expected: "blue" as Channel },
				],
			],
			[
				"mask-ellipse",
				ellipse,
				[
					{ x: 0.5, y: 0.5, expected: "red" as Channel },
					{ x: 0.08, y: 0.08, expected: "blue" as Channel },
				],
			],
			[
				"mask-linear",
				linear,
				[
					{ x: 0.2, y: 0.5, expected: "blue" as Channel },
					{ x: 0.8, y: 0.5, expected: "red" as Channel },
				],
			],
		] as const) {
			const result = check({ name, pixels: await renderMask(mask), samples: [...samples] });
			log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
		}

		// The mask is authored against the ELEMENT, not the canvas: moving the
		// element (-80px) must move the cut with it. This is the fixture that
		// caught the Android exporter evaluating masks after the element
		// matrix, where the mask stayed fixed while the clip slid underneath.
		{
			const background = imageNode({ fixture: blue });
			const overlay = imageNode({
				fixture: red,
				position: { x: -80, y: 0 },
				masks: [rectangle],
			});
			const root = new RootNode({ duration: 10_000 });
			root.children.push(background, overlay);
			const result = check({
				name: "mask-travels-with-the-element",
				pixels: await renderNode(root),
				samples: [
					// Element spans x -80..240; its mask covers 0..160.
					{ x: 0.25, y: 0.5, expected: "red" },
					{ x: 0.75, y: 0.5, expected: "blue" },
					{ x: 0.25, y: 0.08, expected: "blue" },
				],
			});
			log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
		}

		// Crop re-frames the element, so the same mask fractions are relative
		// to the CROPPED frame — the space the Android mask shader receives.
		{
			const background = imageNode({ fixture: blue });
			const overlay = imageNode({
				fixture: red,
				crop: { x: 0, y: 0, width: 0.5, height: 1 },
				masks: [rectangle],
			});
			const root = new RootNode({ duration: 10_000 });
			root.children.push(background, overlay);
			const result = check({
				name: "mask-is-relative-to-the-cropped-element",
				pixels: await renderNode(root),
				samples: [
					// Kept 160x240 fitted into 320x240 -> element x 80..240.
					{ x: 0.5, y: 0.5, expected: "red" },
					{ x: 0.5, y: 0.2, expected: "blue" },
					{ x: 0.33, y: 0.5, expected: "blue" },
				],
			});
			log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
		}

		// Rotated + feathered + inverted: centre is cut away (blue), the
		// corners stay red, and the 40px ramp is neither pure red nor pure
		// blue at the rotated long edge (96px along 30°).
		{
			const pixels = await renderMask(inverted);
			const centre = dominantAt(pixels, 0.5, 0.5);
			const corner = dominantAt(pixels, 0.04, 0.04);
			const edge = dominantAt(pixels, 0.759, 0.700);
			const edgeIsRamp = edge.rgb[0] > 60 && edge.rgb[0] < 200 && edge.rgb[2] > 60;
			const result = {
				name: "mask-rotated-feathered-inverted",
				ok: centre.channel === "blue" && corner.channel === "red" && edgeIsRamp,
				detail: `centre=${centre.channel} corner=${corner.channel} edge=rgb(${edge.rgb.join(",")})`,
			};
			results.push(result);
			log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
		}
	}

	// --- dynamic frames: same source object, new pixels --------------------
	{
		const pooled = createQuadrantFixture();
		const node = imageNode({
			fixture: pooled,
			crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
			sourceRevision: "video:0",
		});
		await renderNode(node);
		// Mediabunny's CanvasSink hands a later frame back in a canvas object it
		// already used, so identity alone must not count as a cache hit.
		paintQuadrants(pooled.canvas, {
			topLeft: "#00ffff",
			topRight: "#ff00ff",
			bottomLeft: "#ffffff",
			bottomRight: "#000000",
		});
		node.resolved = resolvedState({
			fixture: pooled,
			sourceRevision: "video:1",
		});
		const pixels = await renderNode(node);
		const result = check({
			name: "new-frame-in-the-same-canvas-is-not-stale",
			pixels,
			samples: [{ x: 0.5, y: 0.5, expected: "black" }],
		});
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- crop edits during playback ---------------------------------------
	{
		// Sampled away from the exact horizontal midline: two halves meeting at
		// y = 0.5 average to a colour that classifies like a third quadrant.
		const steps: Array<{ name: string; crop: CropRect; samples: Sample[] }> = [
			{
				name: "left-half",
				crop: { x: 0, y: 0, width: 0.5, height: 1 },
				samples: [
					{ x: 0.5, y: 0.25, expected: "red" },
					{ x: 0.5, y: 0.75, expected: "blue" },
				],
			},
			{
				name: "right-half",
				crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
				samples: [
					{ x: 0.5, y: 0.25, expected: "green" },
					{ x: 0.5, y: 0.75, expected: "yellow" },
				],
			},
			{
				name: "bottom-left-quarter",
				crop: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
				samples: [
					{ x: 0.5, y: 0.25, expected: "blue" },
					{ x: 0.5, y: 0.75, expected: "blue" },
				],
			},
			{
				name: "bottom-right-quarter",
				crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
				samples: [
					{ x: 0.5, y: 0.25, expected: "yellow" },
					{ x: 0.5, y: 0.75, expected: "yellow" },
				],
			},
		];
		const node = imageNode({ fixture });
		for (const step of steps) {
			node.params.crop = step.crop;
			node.resolved = resolvedState({ fixture });
			const pixels = await renderNode(node);
			const result = check({
				name: `crop-changes-during-playback:${step.name}`,
				pixels,
				samples: step.samples,
			});
			log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
		}
	}

	// --- sticker library: does a tile actually show anything? --------------
	const { browseCategory } = await import("@cutlyra/editor-core/stickers");
	async function loadImage(url: string): Promise<HTMLImageElement | null> {
		return new Promise((resolve) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => resolve(null);
			image.src = url;
		});
	}
	/** Fraction of pixels the sticker paints. A tile that loads but draws
	 *  nothing (transparent / off-canvas path) is the "empty stickers" bug. */
	function paintedFraction(image: HTMLImageElement): number {
		const { canvas, ctx } = (() => {
			const c = document.createElement("canvas");
			c.width = 64;
			c.height = 64;
			return { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true }) };
		})();
		if (!ctx) return 0;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let painted = 0;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index + 3] > 8) painted += 1;
		}
		return painted / (canvas.width * canvas.height);
	}

	for (const category of ["shapes", "flags"] as const) {
		const items = (await browseCategory({ category })).sections.flatMap(
			(section) => section.items,
		);
		// Every shape tile, plus a spread across the flags grid.
		const sample =
			category === "shapes" ? items : items.filter((_, index) => index % 20 === 0);
		const failures: string[] = [];
		for (const item of sample) {
			const image = await loadImage(item.previewUrl);
			if (!image) {
				failures.push(`${item.id} did not load`);
				continue;
			}
			if (image.naturalWidth === 0) {
				failures.push(`${item.id} decoded with zero width`);
				continue;
			}
			const painted = paintedFraction(image);
			if (painted < 0.05) {
				failures.push(`${item.id} painted ${(painted * 100).toFixed(1)}% of its tile`);
			}
		}
		const result = {
			name: `${category}-thumbnails-render-visible-pixels`,
			ok: failures.length === 0,
			detail: `${sample.length - failures.length}/${sample.length} tiles painted: ${failures.slice(0, 5).join("; ")}`,
		};
		results.push(result);
		log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	}

	// --- output ------------------------------------------------------------
	const failures = results.filter((result) => !result.ok);
	const summary = {
		ok: failures.length === 0,
		total: results.length,
		failed: failures.length,
		results,
		gpuCanvas: {
			width: wasmCompositor.getCanvas().width,
			height: wasmCompositor.getCanvas().height,
		},
	};
	(
		window as unknown as { __PREVIEW_PARITY__: typeof summary }
	).__PREVIEW_PARITY__ = summary;
	log(
		`SUMMARY ${summary.ok ? "PASS" : "FAIL"} ${summary.total - summary.failed}/${summary.total} cases`,
	);
}

run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	(
		window as unknown as { __PREVIEW_PARITY__: unknown }
	).__PREVIEW_PARITY__ = {
		ok: false,
		total: results.length,
		failed: results.length,
		results,
		error: message,
	};
	const host = document.getElementById("results");
	if (host) {
		const row = document.createElement("pre");
		row.textContent = `ERROR ${message}`;
		host.appendChild(row);
	}
});
