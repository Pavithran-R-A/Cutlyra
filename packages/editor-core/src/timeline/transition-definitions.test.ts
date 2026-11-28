/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test-only MediaTime casts, same convention as transitions.test.ts */
import { describe, expect, it } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { TimelineElement } from "./types";
import {
	deriveTransitionAnimations,
	deriveTransitionExtras,
	normalizeTransitionDirection,
	normalizeTransitionKind,
	SUPPORTED_TRANSITION_KINDS,
	TRANSITION_BLUR_INTENSITY,
	TRANSITION_DEFINITIONS,
	transitionEffectId,
	type TransitionWindowLike,
} from "./transition-definitions";

const t = (seconds: number): MediaTime => Math.round(seconds * 120_000) as MediaTime;

function element({
	id,
	params = {},
	animations,
	durationSec = 2,
}: {
	id: string;
	params?: Record<string, unknown>;
	animations?: TimelineElement["animations"];
	durationSec?: number;
}): TimelineElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "media-1",
		startTime: t(0),
		duration: t(durationSec),
		trimStart: t(0),
		trimEnd: t(durationSec),
		params,
		...(animations ? { animations } : {}),
	} as unknown as TimelineElement;
}

const CANVAS = { width: 1080, height: 1920 };

function window({
	kind,
	direction,
	durationSec = 0.6,
}: {
	kind: string;
	direction?: string;
	durationSec?: number;
}): TransitionWindowLike {
	return {
		kind,
		...(direction ? { direction } : {}),
		outgoingElementId: "out",
		incomingElementId: "in",
		durationTicks: t(durationSec),
	};
}

/** Scalar keyframes of one derived channel, or a hard failure. */
function scalarKeys({
	derived,
	id,
	path,
}: {
	derived: ReturnType<typeof deriveTransitionAnimations>;
	id: string;
	path: string;
}): Array<{ time: number; value: number }> {
	const channel = derived.get(id)?.[path];
	if (!channel || !("keys" in channel)) throw new Error(`no scalar channel ${id}.${path}`);
	const keys = channel.keys as Array<{ time: number; value: number }>;
	return keys;
}

function channelValues(args: {
	derived: ReturnType<typeof deriveTransitionAnimations>;
	id: string;
	path: string;
}): number[] {
	return scalarKeys(args).map((key) => key.value);
}

describe("normalizeTransitionKind", () => {
	it("keeps every supported kind", () => {
		for (const kind of SUPPORTED_TRANSITION_KINDS) {
			expect(normalizeTransitionKind(kind)).toBe(kind);
		}
	});

	it("maps the exporter's historical cross-fade tokens onto fade", () => {
		expect(normalizeTransitionKind("cross_fade")).toBe("fade");
		expect(normalizeTransitionKind("crossfade")).toBe("fade");
		expect(normalizeTransitionKind("Cross-Fade")).toBe("fade");
		expect(normalizeTransitionKind("dissolve")).toBe("fade");
	});

	it("falls back to fade for unsupported or missing kinds (never a dead kind)", () => {
		expect(normalizeTransitionKind("spiral")).toBe("fade");
		expect(normalizeTransitionKind(undefined)).toBe("fade");
		expect(normalizeTransitionKind(42)).toBe("fade");
	});
});

describe("normalizeTransitionDirection", () => {
	it("defaults to left and accepts the four directions", () => {
		expect(normalizeTransitionDirection({ kind: "slide", raw: undefined })).toBe("left");
		expect(normalizeTransitionDirection({ kind: "slide", raw: "up" })).toBe("up");
		expect(normalizeTransitionDirection({ kind: "push", raw: "right" })).toBe("right");
	});

	it("ignores direction on non-directional kinds and on junk", () => {
		expect(normalizeTransitionDirection({ kind: "fade", raw: "up" })).toBe("left");
		expect(normalizeTransitionDirection({ kind: "zoom", raw: "down" })).toBe("left");
		expect(normalizeTransitionDirection({ kind: "push", raw: "sideways" })).toBe("left");
	});
});

describe("transition definitions", () => {
	it("declares an audio policy and a compositing order for every kind", () => {
		for (const kind of SUPPORTED_TRANSITION_KINDS) {
			const definition = TRANSITION_DEFINITIONS[kind];
			expect(definition.audio).toBe("cut");
			expect(["incoming-above", "incoming-below"]).toContain(definition.layerOrder);
		}
		// The exporter paints heads above the base only where motion (not alpha)
		// does the reveal — this is the ordering the preview also uses.
		expect(TRANSITION_DEFINITIONS.slide.layerOrder).toBe("incoming-above");
		expect(TRANSITION_DEFINITIONS.push.layerOrder).toBe("incoming-above");
		expect(TRANSITION_DEFINITIONS.fade.layerOrder).toBe("incoming-below");
		expect(TRANSITION_DEFINITIONS.zoom.layerOrder).toBe("incoming-below");
	});

	it("declares the visual pass each kind needs in both renderers", () => {
		expect(TRANSITION_DEFINITIONS.wipe.visual).toBe("wipe");
		expect(TRANSITION_DEFINITIONS.wipe.layerOrder).toBe("incoming-above");
		expect(TRANSITION_DEFINITIONS["dip-black"].visual).toBe("dip");
		expect(TRANSITION_DEFINITIONS["dip-black"].dipColour).toEqual([0, 0, 0]);
		expect(TRANSITION_DEFINITIONS["dip-white"].dipColour).toEqual([1, 1, 1]);
		expect(TRANSITION_DEFINITIONS.blur.visual).toBe("blur");
		expect(TRANSITION_DEFINITIONS.fade.visual).toBe("none");
	});
});

describe("deriveTransitionExtras", () => {
	function channelOf({
		extras,
		id,
		path,
	}: {
		extras: ReturnType<typeof deriveTransitionExtras>;
		id: string;
		path: string;
	}): Array<{ time: number; value: number }> {
		const channel = extras.get(id)?.animations?.[path];
		if (!channel || !("keys" in channel)) throw new Error(`no channel ${id}.${path}`);
		return (channel.keys as Array<{ time: number; value: number }>).map((key) => ({
			time: key.time,
			value: key.value,
		}));
	}

	it("wipe puts a directional wipe effect and a 0..1 progress channel on the incoming clip", () => {
		const extras = deriveTransitionExtras({
			windows: [window({ kind: "wipe", direction: "up" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
		});
		const id = transitionEffectId({ elementId: "in", kind: "wipe" });
		const effect = extras.get("in")?.effects[0];
		expect(effect?.type).toBe("transition-wipe");
		expect(effect?.params.directionX).toBe(0);
		expect(effect?.params.directionY).toBe(-1);
		expect(
			channelOf({ extras, id: "in", path: `effects.${id}.params.progress` }),
		).toEqual([
			{ time: 0, value: 0 },
			{ time: t(0.6), value: 1 },
		]);
		expect(extras.get("out")).toBeUndefined();
	});

	it("dip-black recolours both ends with mirror ramps around the midpoint", () => {
		const extras = deriveTransitionExtras({
			windows: [window({ kind: "dip-black" })],
			elements: [
				element({ id: "out", durationSec: 3 }),
				element({ id: "in", durationSec: 2 }),
			],
		});
		const outId = transitionEffectId({ elementId: "out", kind: "dip-black" });
		const inId = transitionEffectId({ elementId: "in", kind: "dip-black" });
		expect(extras.get("out")?.effects[0]?.params.white).toBe(0);
		expect(extras.get("in")?.effects[0]?.params.amount).toBe(1);
		// Outgoing ramps over its own tail, reaching black exactly at the midpoint.
		expect(channelOf({ extras, id: "out", path: `effects.${outId}.params.amount` })).toEqual([
			{ time: t(3) - t(0.6), value: 0 },
			{ time: t(3) - t(0.3), value: 1 },
		]);
		expect(channelOf({ extras, id: "in", path: `effects.${inId}.params.amount` })).toEqual([
			{ time: 0, value: 1 },
			{ time: t(0.3), value: 1 },
			{ time: t(0.6), value: 0 },
		]);
	});

	it("dip-white selects the white dip colour", () => {
		const extras = deriveTransitionExtras({
			windows: [window({ kind: "dip-white" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
		});
		expect(extras.get("in")?.effects[0]?.params.white).toBe(1);
	});

	it("blur animates the incoming blur down to zero and leaves the outgoing clip alone", () => {
		const extras = deriveTransitionExtras({
			windows: [window({ kind: "blur" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
		});
		const id = transitionEffectId({ elementId: "in", kind: "blur" });
		const effect = extras.get("in")?.effects[0];
		expect(effect?.type).toBe("blur");
		expect(effect?.params.intensity).toBe(TRANSITION_BLUR_INTENSITY);
		expect(channelOf({ extras, id: "in", path: `effects.${id}.params.intensity` })).toEqual([
			{ time: 0, value: TRANSITION_BLUR_INTENSITY },
			{ time: t(0.6), value: 0 },
		]);
		expect(extras.get("out")).toBeUndefined();
	});

	it("adds nothing for pure-animation kinds or zero-length windows", () => {
		const zero = window({ kind: "wipe" });
		zero.durationTicks = t(0);
		expect(
			deriveTransitionExtras({
				windows: [window({ kind: "fade" }), zero],
				elements: [element({ id: "out" }), element({ id: "in" })],
			}).size,
		).toBe(0);
	});
});

describe("deriveTransitionAnimations", () => {
	it("keeps the cross-fade exactly as before: incoming opacity 0 -> 1 over the window", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "fade" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "opacity" })).toEqual([0, 1]);
		expect(derived.get("out")).toBeUndefined();
	});

	it("slide brings the incoming clip in from the direction's opposite side", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "slide", direction: "left" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "transform.positionX" })).toEqual([CANVAS.width, 0]);
		expect(derived.get("in")?.["opacity"]).toBeUndefined();
		expect(derived.get("out")).toBeUndefined();
	});

	it("slide honours vertical directions", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "slide", direction: "down" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "transform.positionY" })).toEqual([-CANVAS.height, 0]);
	});

	it("push moves BOTH clips in the same direction", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "push", direction: "right" })],
			elements: [
				element({ id: "out", durationSec: 3 }),
				element({ id: "in", durationSec: 2 }),
			],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "transform.positionX" })).toEqual([-CANVAS.width, 0]);
		expect(channelValues({ derived, id: "out", path: "transform.positionX" })).toEqual([0, CANVAS.width]);
		// Outgoing ramps over its own tail, not from its start.
		expect(scalarKeys({ derived, id: "out", path: "transform.positionX" }).map((key) => key.time)).toEqual([
			t(3) - t(0.6),
			t(3),
		]);
	});

	it("zoom scales the incoming clip down into place while it fades in", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "zoom" })],
			elements: [element({ id: "out" }), element({ id: "in" })],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "opacity" })).toEqual([0, 1]);
		expect(channelValues({ derived, id: "in", path: "transform.scaleX" })).toEqual([1.25, 1]);
		expect(channelValues({ derived, id: "in", path: "transform.scaleY" })).toEqual([1.25, 1]);
	});

	it("offsets ride on top of authored static transforms", () => {
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "slide", direction: "left" })],
			elements: [
				element({ id: "out" }),
				element({ id: "in", params: { "transform.positionX": 40 } }),
			],
			canvasSize: CANVAS,
		});
		expect(channelValues({ derived, id: "in", path: "transform.positionX" })).toEqual([
			CANVAS.width + 40,
			40,
		]);
	});

	it("never clobbers user keyframes for the same property", () => {
		const userChannel = {
			keys: [
				{ id: "u0", time: t(0), value: 0.25, segmentToNext: "linear", tangentMode: "auto" },
			],
			extrapolation: { before: "hold", after: "hold" },
		} as NonNullable<TimelineElement["animations"]>[string];
		const derived = deriveTransitionAnimations({
			windows: [window({ kind: "fade" })],
			elements: [element({ id: "out" }), element({ id: "in", animations: { opacity: userChannel } })],
			canvasSize: CANVAS,
		});
		expect(derived.get("in")).toBeUndefined();
	});

	it("needs zero-length windows to be skipped and missing neighbours to be tolerated", () => {
		const zero = window({ kind: "fade" });
		zero.durationTicks = t(0);
		expect(
			deriveTransitionAnimations({
				windows: [zero],
				elements: [element({ id: "out" }), element({ id: "in" })],
				canvasSize: CANVAS,
			}).size,
		).toBe(0);
		expect(
			deriveTransitionAnimations({
				windows: [window({ kind: "slide" })],
				elements: [element({ id: "in" })],
				canvasSize: CANVAS,
			}).size,
		).toBe(0);
	});
});
