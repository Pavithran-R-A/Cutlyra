import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { SceneTracks, VideoElement } from "@/timeline";
import { FreezeFrameCommand } from "@/commands/timeline/element/freeze-frame";
import { UnfreezeFrameCommand } from "@/commands/timeline/element/unfreeze-frame";
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

function buildHarness(elements: VideoElement[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.project.setActiveProject({ project: buildFixtureProject() });
	const scene = {
		...buildDefaultScene({ name: "Main", isMain: true }),
		id: "scene-unfreeze",
	};
	scene.tracks.main.elements = elements;
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	return {
		editor,
		get tracks(): SceneTracks {
			return editor.scenes.getActiveScene().tracks;
		},
		mainTrackId: scene.tracks.main.id,
	};
}

describe("UnfreezeFrameCommand", () => {
	afterEach(() => EditorCore.reset());

	it("removes freeze and rejoins video halves", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const freeze = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		freeze.execute();
		const frozenId = freeze.getFrozenElementId();
		expect(h.tracks.main.elements.length).toBe(3);

		const unfreeze = new UnfreezeFrameCommand({
			trackId: h.mainTrackId,
			frozenElementId: frozenId,
		});
		unfreeze.execute();
		expect(h.tracks.main.elements.length).toBe(1);
		const v = h.tracks.main.elements[0] as VideoElement;
		expect(v.duration).toBe(mediaTime({ ticks: 120_000 }));
	});

	it("undo restores frozen state", () => {
		const h = buildHarness([videoElement({ id: "v1", name: "clip" })]);
		const splitTime = mediaTime({ ticks: 60_000 });
		const hold = mediaTime({ ticks: 30_000 });
		const freeze = new FreezeFrameCommand({
			trackId: h.mainTrackId,
			elementId: "v1",
			splitTime,
			holdDuration: hold,
			frozenMediaId: "frame-asset-1",
		});
		freeze.execute();
		const frozenId = freeze.getFrozenElementId();
		const unfreeze = new UnfreezeFrameCommand({
			trackId: h.mainTrackId,
			frozenElementId: frozenId,
		});
		unfreeze.execute();
		expect(h.tracks.main.elements.length).toBe(1);
		unfreeze.undo();
		expect(h.tracks.main.elements.length).toBe(3);
	});
});