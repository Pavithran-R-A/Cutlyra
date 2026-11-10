/**
 * Rotation/flip transform params (#50): UpdateElementsCommand must update
 * transform.* params as real editor commands (single undoable step per batch),
 * preserve unrelated params/animations, and restore prior state on undo.
 * Uses the same mocked EditorCore seam as insert-element-canvas-adoption.test.ts.
 */
import { describe, expect, it, mock } from "bun:test";
import { buildDefaultScene } from "@/timeline/scenes";
import type { ImageElement, SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import type { ElementAnimations } from "@/animation/types";
import type { UpdateElementsCommand } from "@/commands/timeline/element/update-elements";
import { BatchCommand } from "@/commands/batch-command";
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

function buildHarness(element: VideoElement | ImageElement): Harness {
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
		const animations: ElementAnimations = {
			"transform.rotate": {
				keys: [
					{
						id: "k-rotate",
						time: ZERO_MEDIA_TIME,
						value: 45,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		el.animations = animations;
		const h = buildHarness(el);
		new commandCtor({
			updates: [{ trackId: h.tracks.main.id, elementId: "v1", patch: { params: { ...getEl(h).params, "transform.rotate": 180 } } }],
		}).execute();
		expect(getEl(h).params["transform.rotate"]).toBe(180);
		expect(getEl(h).animations).toEqual(animations);
	});
});

describe("consecutive transform actions", () => {
	it("walks a rotate-then-mirror sequence one undo/redo step at a time", () => {
		const h = buildHarness(videoElement());
		const ref = { trackId: h.tracks.main.id, elementId: "v1" };
		const rotate = new commandCtor({
			updates: [{ ...ref, patch: { params: { ...getEl(h).params, "transform.rotate": 90 } } }],
		});
		rotate.execute();
		const mirror = new commandCtor({
			updates: [{ ...ref, patch: { params: { ...getEl(h).params, "transform.scaleX": -1 } } }],
		});
		mirror.execute();
		expect(getEl(h).params["transform.rotate"]).toBe(90);
		expect(getEl(h).params["transform.scaleX"]).toBe(-1);

		// Each action is its own undoable step: undoing the mirror keeps the rotation.
		mirror.undo();
		expect(getEl(h).params["transform.scaleX"]).toBe(1);
		expect(getEl(h).params["transform.rotate"]).toBe(90);

		rotate.undo();
		expect(getEl(h).params["transform.rotate"]).toBe(0);
		expect(getEl(h).params["transform.scaleX"]).toBe(1);

		rotate.redo();
		mirror.redo();
		expect(getEl(h).params["transform.rotate"]).toBe(90);
		expect(getEl(h).params["transform.scaleX"]).toBe(-1);
	});

	it("undoes and redoes a batched rotate+mirror as one step", () => {
		const h = buildHarness(videoElement());
		const ref = { trackId: h.tracks.main.id, elementId: "v1" };
		const batch = new BatchCommand([
			new commandCtor({
				updates: [{ ...ref, patch: { params: { ...getEl(h).params, "transform.rotate": 180 } } }],
			}),
			new commandCtor({
				updates: [
					{
						...ref,
						patch: { params: { ...getEl(h).params, "transform.rotate": 180, "transform.scaleY": -1 } },
					},
				],
			}),
		]);
		batch.execute();
		expect(getEl(h).params["transform.rotate"]).toBe(180);
		expect(getEl(h).params["transform.scaleY"]).toBe(-1);

		batch.undo();
		expect(getEl(h).params["transform.rotate"]).toBe(0);
		expect(getEl(h).params["transform.scaleY"]).toBe(1);
		// Unrelated params survive the whole round trip.
		expect(getEl(h).params.framing).toBe("fit");
		expect(getEl(h).params.volume).toBe(0);

		batch.redo();
		expect(getEl(h).params["transform.rotate"]).toBe(180);
		expect(getEl(h).params["transform.scaleY"]).toBe(-1);
	});
});
