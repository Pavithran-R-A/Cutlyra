import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { OverlayTrack, SceneTracks, VideoElement } from "@/timeline";
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

	it("ripples later main-track clips so the hold never overlaps them", () => {
		const first = videoElement({ id: "v1", name: "clip" });
		const second: VideoElement = {
			...videoElement({ id: "v2", name: "next" }),
			startTime: mediaTime({ ticks: 120_000 }),
		};
		const h = buildHarness([first, second]);
		const hold = mediaTime({ ticks: 30_000 });
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime: mediaTime({ ticks: 60_000 }),
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		const elems = h.tracks.main.elements;
		// left 60k, hold 30k, right 60k, then the next clip pushed by the hold.
		expect(elems.map((el) => el.id)).toEqual(["v1", cmd.getFrozenElementId(), expect.any(String), "v2"]);
		expect(elems.map((el) => el.startTime)).toEqual([
			mediaTime({ ticks: 0 }),
			mediaTime({ ticks: 60_000 }),
			mediaTime({ ticks: 90_000 }),
			mediaTime({ ticks: 150_000 }),
		]);
		// The following clip keeps its own content length (only its position moved).
		expect(elems[3].duration).toBe(mediaTime({ ticks: 120_000 }));
	});

	it("does not ripple overlay tracks (they are free-position)", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const overlayElement: VideoElement = {
			...videoElement({ id: "o1", name: "overlay" }),
			startTime: mediaTime({ ticks: 30_000 }),
			duration: mediaTime({ ticks: 60_000 }),
		};
		const overlayTrack: Extract<OverlayTrack, { type: "video" }> = {
			id: "overlay-track",
			type: "video",
			name: "Overlay",
			muted: false,
			hidden: false,
			elements: [overlayElement],
		};
		h.editor.timeline.updateTracks({
			...h.tracks,
			overlay: [overlayTrack],
		});
		const cmd = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime: mediaTime({ ticks: 60_000 }),
			holdDuration: mediaTime({ ticks: 30_000 }),
			frozenMediaId: "frame-asset-1",
		});
		cmd.execute();
		const overlay = h.tracks.overlay.find((t) => t.id === "overlay-track");
		// A freeze on the main track must not move a free-position caption.
		expect(overlay?.elements[0].startTime).toBe(mediaTime({ ticks: 30_000 }));
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