/**
 * Rotation/flip transform params (#50): UpdateElementsCommand must update
 * transform.* params as real editor commands (single undoable step per batch),
 * preserve unrelated params/animations, and restore prior state on undo.
 * Uses the same mocked EditorCore seam as insert-element-canvas-adoption.test.ts.
 */
import { describe, expect, it, mock } from "bun:test";
import { buildDefaultScene } from "@/timeline/scenes";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import type { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

type Harness = { tracks: SceneTracks; updates: SceneTracks[] };

const commandCtor: typeof UpdateElementsCommand = (
	await import("@/commands/timeline/element/update-elements")
).UpdateElementsCommand;

function videoElement(): VideoElement {
	return {
		id: "v1",
		type: "video",
		name: "clip",
		mediaId: "m1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 0, framing: "fit", "transform.rotate": 0, "transform.scaleX": 1, "transform.scaleY": 1 },
		animations: undefined,
	};
}

function buildHarness(element: TimelineElement): Harness {
	const scene = buildDefaultScene({ name: "Main", isMain: true });
	scene.tracks.main.elements = [element];
	const h: Harness = { tracks: scene.tracks, updates: [] };
	const editor = {
		scenes: { getActiveScene: () => ({ tracks: h.tracks }) },
		timeline: { updateTracks: (tracks: SceneTracks) => { h.tracks = tracks; h.updates.push(tracks); } },
	};
	mock.module("@/core", () => ({ EditorCore: { getInstance: () => editor } }));
	return h;
}

function getEl(h: Harness): TimelineElement {
	const el = h.tracks.main.elements.find((e) => e.id === "v1");
	if (!el) throw new Error("missing element");
	return el;
}

describe("transform param updates", () => {
	it("rotates 90 degrees and restores on undo, preserving unrelated params", () => {
		const h = buildHarness(videoElement());
		const cmd = new commandCtor({
			updates: [{ trackId: h.tracks.main.id, elementId: "v1", patch: { params: { ...getEl(h).params, "transform.rotate": 90 } } }],
		});
		cmd.execute();
		expect(getEl(h).params["transform.rotate"]).toBe(90);
		expect(getEl(h).params.framing).toBe("fit");
		expect(getEl(h).params.volume).toBe(0);
		cmd.undo();
		expect(getEl(h).params["transform.rotate"]).toBe(0);
		expect(getEl(h).params.framing).toBe("fit");
	});

	it("flips horizontal by sign while preserving magnitude, and restores on undo", () => {
		const el = videoElement();
		el.params["transform.scaleX"] = 0.75;
		const h = buildHarness(el);
		new commandCtor({
			updates: [{ trackId: h.tracks.main.id, elementId: "v1", patch: { params: { ...getEl(h).params, "transform.scaleX": -0.75 } } }],
		}).execute();
		expect(getEl(h).params["transform.scaleX"]).toBe(-0.75);
		expect(getEl(h).params["transform.scaleY"]).toBe(1);
	});

	it("flips vertical and supports combined rotation+flip state", () => {
		const h = buildHarness(videoElement());
		const ref = { trackId: h.tracks.main.id, elementId: "v1" };
		new commandCtor({ updates: [{ ...ref, patch: { params: { ...getEl(h).params, "transform.rotate": 90 } } }] }).execute();
		new commandCtor({ updates: [{ ...ref, patch: { params: { ...getEl(h).params, "transform.scaleY": -1 } } }] }).execute();
		expect(getEl(h).params["transform.rotate"]).toBe(90);
		expect(getEl(h).params["transform.scaleY"]).toBe(-1);
		expect(getEl(h).params["transform.scaleX"]).toBe(1);
	});

	it("preserves animations field when patching transform params", () => {
		const el = videoElement();
		el.animations = { channels: [] } as never;
		const h = buildHarness(el);
		new commandCtor({
			updates: [{ trackId: h.tracks.main.id, elementId: "v1", patch: { params: { ...getEl(h).params, "transform.rotate": 180 } } }],
		}).execute();
		expect(getEl(h).params["transform.rotate"]).toBe(180);
		expect(getEl(h).animations).toEqual({ channels: [] });
	});
});
