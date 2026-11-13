import { describe, expect, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	GraphicElement,
	GraphicTrack,
	SceneTracks,
	TextElement,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@cutlyra/editor-core/timeline";
import { trackDisplayOrder, trackLaneKind } from "./track-order";

/**
 * Fixtures carry only what this module reads (element `type`/`name` and track
 * `type`); everything else belongs to the engine's own element tests. The cast
 * keeps the fixture honest about WHICH element type a lane holds without
 * fabricating trim/param fields that no assertion here looks at.
 */
function element<T>(type: string, name: string): T {
	return { type, name } as unknown as T;
}

function videoTrack(id: string, elementName: string, elements?: string[]): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: (elements ?? [elementName]).map((name) =>
			element<VideoElement>("video", name),
		),
		hidden: false,
		muted: false,
	};
}

function textTrack(id: string, elementName: string): TextTrack {
	return {
		id,
		name: id,
		type: "text",
		elements: [element<TextElement>("text", elementName)],
		hidden: false,
	};
}

function graphicTrack(id: string, elementName: string): GraphicTrack {
	return {
		id,
		name: id,
		type: "graphic",
		elements: [element<GraphicElement>("graphic", elementName)],
		hidden: false,
	};
}

function audioTrack(id: string, elementName: string): AudioTrack {
	return {
		id,
		name: id,
		type: "audio",
		elements: [element<AudioElement>("audio", elementName)],
		muted: false,
	};
}

/** The scene the report describes: a main clip, its duplicate, a text layer,
 *  a shape, and one music clip. */
function reportedScene(): SceneTracks {
	return {
		main: videoTrack("main", "main-clip"),
		overlay: [
			// DuplicateElementsCommand: alwaysNew + highest -> overlay[0].
			videoTrack("layer-copy", "main-clip (copy)"),
			textTrack("layer-text", "title"),
			graphicTrack("layer-shape", "arrow"),
		],
		audio: [audioTrack("layer-music", "song")],
	};
}

function lanes(tracks: SceneTracks) {
	return trackDisplayOrder(tracks).map((entry) => ({
		id: entry.track.id,
		kind: trackLaneKind(entry),
		isMain: entry.isMain,
		types: entry.track.elements.map((item) => item.type),
		names: entry.track.elements.map((item) => item.name),
	}));
}

describe("timeline lane order", () => {
	test("duplicate, text and shape render above the main clip; music below", () => {
		expect(lanes(reportedScene()).map((lane) => lane.id)).toEqual([
			"layer-copy",
			"layer-text",
			"layer-shape",
			"main",
			"layer-music",
		]);
	});

	test("every lane reports the kind its content needs", () => {
		expect(lanes(reportedScene()).map((lane) => lane.kind)).toEqual([
			"overlay",
			"text",
			"sticker",
			"main",
			"audio",
		]);
	});

	test("lane contents keep their identity after ordering", () => {
		const byId = new Map(lanes(reportedScene()).map((lane) => [lane.id, lane]));
		expect(byId.get("main")?.types).toEqual(["video"]);
		expect(byId.get("main")?.names).toEqual(["main-clip"]);
		expect(byId.get("main")?.isMain).toBe(true);
		expect(byId.get("layer-copy")?.names).toEqual(["main-clip (copy)"]);
		expect(byId.get("layer-copy")?.isMain).toBe(false);
		expect(byId.get("layer-text")?.types).toEqual(["text"]);
		expect(byId.get("layer-shape")?.types).toEqual(["graphic"]);
		expect(byId.get("layer-music")?.types).toEqual(["audio"]);
	});

	test("the duplicate is above main and the music is below it", () => {
		const order = lanes(reportedScene());
		const laneOf = (id: string) => order.findIndex((lane) => lane.id === id);
		expect(laneOf("layer-copy")).toBeLessThan(laneOf("main"));
		expect(laneOf("layer-text")).toBeLessThan(laneOf("main"));
		expect(laneOf("main")).toBeLessThan(laneOf("layer-music"));
	});

	test("display order matches the placement engine's own indexing", () => {
		const tracks = reportedScene();
		// `resolveTrackPlacement`/`applyPlacement` index this exact list, and
		// `getHighestInsertIndexForTrack` returns 0 for the top overlay slot.
		expect(trackDisplayOrder(tracks).map((entry) => entry.track.id)).toEqual([
			...tracks.overlay.map((track) => track.id),
			tracks.main.id,
			...tracks.audio.map((track) => track.id),
		]);
	});

	test("an empty overlay list leaves main alone and music last", () => {
		const tracks: SceneTracks = {
			main: videoTrack("main", "clip"),
			overlay: [],
			audio: [audioTrack("music", "song")],
		};
		expect(lanes(tracks).map((lane) => [lane.id, lane.kind])).toEqual([
			["main", "main"],
			["music", "audio"],
		]);
	});

	test("a caption track keeps its own lane kind above main", () => {
		const tracks: SceneTracks = {
			main: videoTrack("main", "clip"),
			overlay: [
				{
					id: "layer-caption",
					name: "captions",
					type: "caption",
					elements: [],
					hidden: false,
				},
			],
			audio: [],
		};
		expect(lanes(tracks).map((lane) => lane.kind)).toEqual([
			"caption",
			"main",
		]);
	});
});
