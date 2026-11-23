import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { SceneTracks, VideoElement } from "@/timeline";
import { FreezeFrameCommand } from "@/commands/timeline/element/freeze-frame";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

function videoElement({ id, name }: { id: string; name: string }): VideoElement {
	return {
		id,
		type: "video",
		name,
		mediaId: "m1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			framing: "fit",
		},
		animations: undefined,
	};
}

const canvas = { width: 1080, height: 1920 };

function buildHarness(elements: VideoElement[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main", isMain: true }),
		id: "scene-freeze",
	};
	scene.tracks.main.elements = elements;
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	return {
		editor,
		get tracks(): SceneTracks {
			return editor.scenes.getActiveScene().tracks;
		},
		mainTrackId: scene.tracks.main.id,
		canvas,
	};
}

describe("FreezeFrameCommand", () => {
	afterEach(() => EditorCore.reset());

	it("splits source and inserts a still image interval", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		const elems = h.tracks.main.elements;
		expect(elems.length).toBe(3);
		expect(elems[0].type).toBe("video");
		expect(elems[1].type).toBe("image");
		expect(elems[2].type).toBe("video");
		expect(elems[1].duration).toBe(hold);
	});

	it("preserves total timeline span", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		const elems = h.tracks.main.elements;
		const total =
			elems[0].duration + elems[1].duration + elems[2].duration;
		// left (60k) + hold (30k) + right (60k) = 150k vs original 120k + 30k hold
		expect(total).toBe(mediaTime({ ticks: 150_000 }));
	});

	it("undo restores original", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		expect(h.tracks.main.elements.length).toBe(3);
		cmd.undo();
		expect(h.tracks.main.elements.length).toBe(1);
		expect(h.tracks.main.elements[0].id).toBe("v1");
	});

	it("does not delete source media (mediaId preserved on halves)", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		const elems = h.tracks.main.elements;
		expect((elems[0] as VideoElement).mediaId).toBe("m1");
		expect((elems[2] as VideoElement).mediaId).toBe("m1");
	});

	it("is a no-op when split time outside element", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime: mediaTime({ ticks: 200_000 }),
			holdDuration: mediaTime({ ticks: 30_000 }),
			frozenMediaId: "frame-asset-1",
		});
		const res = cmd.execute();
		expect(h.tracks.main.elements.length).toBe(1);
	});
});