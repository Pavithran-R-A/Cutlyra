import { describe, expect, it } from "bun:test";

// Global path-call record used by the Path2D stub so geometry built on
// Path2D objects (heart, arrow, rectangle, ...) is observable in tests.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const G = globalThis as unknown as { __pathCalls?: string[] };
G.__pathCalls = [];
if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
	(globalThis as { Path2D: unknown }).Path2D = class Path2DStub {
		moveTo(...a: unknown[]) {
			G.__pathCalls!.push(`moveTo(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		lineTo(...a: unknown[]) {
			G.__pathCalls!.push(`lineTo(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		bezierCurveTo(...a: unknown[]) {
			G.__pathCalls!.push(`bezierCurveTo(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		quadraticCurveTo(...a: unknown[]) {
			G.__pathCalls!.push(`quadraticCurveTo(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		arc(...a: unknown[]) {
			G.__pathCalls!.push(`arc(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		arcTo(...a: unknown[]) {
			G.__pathCalls!.push(`arcTo(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		closePath() {
			G.__pathCalls!.push("closePath()");
		}
		rect(...a: unknown[]) {
			G.__pathCalls!.push(`rect(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		roundRect(...a: unknown[]) {
			G.__pathCalls!.push(`roundRect(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
		ellipse(...a: unknown[]) {
			G.__pathCalls!.push(`ellipse(${a.map((x) => JSON.stringify(x)).join(",")})`);
		}
	};
}

import {
	getGraphicDefinition,
	registerDefaultGraphics,
} from "@/graphics";

const ANIMATED_IDS = [
	"pulsing-heart",
	"spinning-star",
	"bouncing-arrow",
	"confetti",
	"rotating-ring",
	"checkmark-pop",
];

const STATIC_IDS = [
	"rectangle",
	"ellipse",
	"polygon",
	"star",
	"heart",
	"arrow",
];

function makeRecordingContext(): {
	ctx: CanvasRenderingContext2D;
	calls: string[];
} {
	const calls: string[] = [];
	// eslint-disable-next-line opencut/prefer-object-params
	const record = (name: string, ...args: unknown[]) => {
		calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
	};
	const target: Record<string, unknown> = {};
	const methods = [
		"clearRect",
		"fillRect",
		"strokeRect",
		"beginPath",
		"closePath",
		"moveTo",
		"lineTo",
		"bezierCurveTo",
		"quadraticCurveTo",
		"arc",
		"arcTo",
		"rect",
		"roundRect",
		"fill",
		"stroke",
		"save",
		"restore",
		"translate",
		"rotate",
		"scale",
		"setTransform",
		"resetTransform",
		"clip",
		"drawImage",
	];
	for (const m of methods) {
		target[m] = (...args: unknown[]) => record(m, ...args);
	}
	let fillStyle = "";
	let strokeStyle = "";
	let lineWidth = 0;
	let lineCap = "butt";
	let lineJoin = "miter";
	let shadowColor = "transparent";
	let shadowBlur = 0;
	let shadowOffsetX = 0;
	let shadowOffsetY = 0;
	Object.defineProperties(target, {
		fillStyle: { get: () => fillStyle, set: (v: string) => { fillStyle = v; } },
		strokeStyle: { get: () => strokeStyle, set: (v: string) => { strokeStyle = v; } },
		lineWidth: { get: () => lineWidth, set: (v: number) => { lineWidth = v; } },
		lineCap: { get: () => lineCap, set: (v: string) => { lineCap = v; } },
		lineJoin: { get: () => lineJoin, set: (v: string) => { lineJoin = v; } },
		shadowColor: { get: () => shadowColor, set: (v: string) => { shadowColor = v; } },
		shadowBlur: { get: () => shadowBlur, set: (v: number) => { shadowBlur = v; } },
		shadowOffsetX: { get: () => shadowOffsetX, set: (v: number) => { shadowOffsetX = v; } },
		shadowOffsetY: { get: () => shadowOffsetY, set: (v: number) => { shadowOffsetY = v; } },
		canvas: { get: () => ({ width: 64, height: 64 }) },
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return { ctx: target as unknown as CanvasRenderingContext2D, calls };
}

describe("animated graphics", () => {
	it("registers all six animated graphics", () => {
		registerDefaultGraphics();
		for (const id of ANIMATED_IDS) {
			const def = getGraphicDefinition({ definitionId: id });
			expect(def).toBeTruthy();
			expect(def.animated).toBe(true);
		}
	});

	it("static graphics are not animated", () => {
		registerDefaultGraphics();
		for (const id of STATIC_IDS) {
			const def = getGraphicDefinition({ definitionId: id });
			expect(def.animated).not.toBe(true);
		}
	});

	for (const id of ANIMATED_IDS) {
		it(`${id}: render output differs between t=0 and t=0.5`, () => {
			registerDefaultGraphics();
			const def = getGraphicDefinition({ definitionId: id });
			G.__pathCalls = [];
			const r0 = makeRecordingContext();
			def.render({ ctx: r0.ctx, params: {}, width: 64, height: 64, time: 0 });
			const snap0 = [...r0.calls, ...G.__pathCalls!];
			G.__pathCalls = [];
			const r1 = makeRecordingContext();
			def.render({ ctx: r1.ctx, params: {}, width: 64, height: 64, time: 0.1 });
			const snap1 = [...r1.calls, ...G.__pathCalls!];
			expect(snap0.length).toBeGreaterThan(0);
			expect(snap1.length).toBeGreaterThan(0);
			expect(JSON.stringify(snap0)).not.toBe(JSON.stringify(snap1));
		});

		it(`${id}: render is deterministic at a given time`, () => {
			registerDefaultGraphics();
			const def = getGraphicDefinition({ definitionId: id });
			G.__pathCalls = [];
			const rA = makeRecordingContext();
			def.render({ ctx: rA.ctx, params: {}, width: 64, height: 64, time: 0.25 });
			const snapA = [...rA.calls, ...G.__pathCalls!];
			G.__pathCalls = [];
			const rB = makeRecordingContext();
			def.render({ ctx: rB.ctx, params: {}, width: 64, height: 64, time: 0.25 });
			const snapB = [...rB.calls, ...G.__pathCalls!];
			expect(JSON.stringify(snapA)).toBe(JSON.stringify(snapB));
		});
	}

	for (const id of STATIC_IDS) {
		it(`${id}: render is time-independent`, () => {
			registerDefaultGraphics();
			const def = getGraphicDefinition({ definitionId: id });
			G.__pathCalls = [];
			const rA = makeRecordingContext();
			def.render({ ctx: rA.ctx, params: {}, width: 64, height: 64, time: 0 });
			const snapA = [...rA.calls, ...G.__pathCalls!];
			G.__pathCalls = [];
			const rB = makeRecordingContext();
			def.render({ ctx: rB.ctx, params: {}, width: 64, height: 64, time: 5 });
			const snapB = [...rB.calls, ...G.__pathCalls!];
			expect(JSON.stringify(snapA)).toBe(JSON.stringify(snapB));
		});
	}

	it("loop boundary: t=0 and t=period produce same state for pulsing heart", () => {
		registerDefaultGraphics();
		const def = getGraphicDefinition({ definitionId: "pulsing-heart" });
		G.__pathCalls = [];
		const rA = makeRecordingContext();
		def.render({ ctx: rA.ctx, params: {}, width: 64, height: 64, time: 0 });
		const snapA = [...rA.calls, ...G.__pathCalls!];
		G.__pathCalls = [];
		const rB = makeRecordingContext();
		def.render({ ctx: rB.ctx, params: {}, width: 64, height: 64, time: 0.8 });
		const snapB = [...rB.calls, ...G.__pathCalls!];
		expect(JSON.stringify(snapA)).toBe(JSON.stringify(snapB));
	});
});