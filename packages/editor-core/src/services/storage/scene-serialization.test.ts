import { describe, expect, test } from "bun:test";
import type { TScene } from "@/timeline";
import { mediaTime } from "@/wasm";
import { deserializeScene, serializeScene } from "./scene-serialization";

const t = (ticks: number) => mediaTime({ ticks });

function fixtureScene(): TScene {
	return {
		id: "scene-poco",
		name: "Cross-fade QA",
		isMain: true,
		tracks: {
			main: {
				id: "main",
				name: "Main",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					{ id: "video-a", type: "video", name: "A", mediaId: "a", startTime: t(0), duration: t(1_440_000), trimStart: t(0), trimEnd: t(0), params: {} },
					{ id: "video-c", type: "video", name: "C", mediaId: "c", startTime: t(1_440_000), duration: t(600_000), trimStart: t(0), trimEnd: t(0), params: {} },
				],
			},
			overlay: [],
			audio: [],
		},
		transitions: [{
			id: "fade-1",
			afterElementId: "video-a",
			kind: "fade",
			duration: t(60_000),
		}],
		bookmarks: [{ time: t(300_000), note: "junction" }],
		createdAt: new Date("2026-10-08T10:00:00.000Z"),
		updatedAt: new Date("2026-10-08T11:00:00.000Z"),
	};
}

describe("scene persistence: POCO transition regression", () => {
	test("save -> JSON/IndexedDB-like clone -> load retains a cross-fade", () => {
		const scene = fixtureScene();
		const saved = serializeScene({ scene });
		expect(saved.transitions).toEqual(scene.transitions);
		const cloned = JSON.parse(JSON.stringify(saved)) as typeof saved;
		const reopened = deserializeScene({ scene: cloned });
		expect(reopened.transitions).toEqual([{
			id: "fade-1",
			afterElementId: "video-a",
			kind: "fade",
			duration: t(60_000),
		}]);
		expect(reopened.tracks.main.elements).toHaveLength(2);
		expect(reopened.bookmarks).toEqual([{ time: t(300_000), note: "junction" }]);
		expect(reopened.createdAt.toISOString()).toBe("2026-10-08T10:00:00.000Z");
		expect(reopened.updatedAt.toISOString()).toBe("2026-10-08T11:00:00.000Z");
	});

	test("a slide's kind, duration and direction survive save -> JSON clone -> reopen", () => {
		const scene = fixtureScene();
		scene.transitions = [{
			id: "slide-1",
			afterElementId: "video-a",
			kind: "slide",
			direction: "up",
			duration: t(90_000),
		}];
		const saved = serializeScene({ scene });
		const cloned = JSON.parse(JSON.stringify(saved)) as typeof saved;
		const reopened = deserializeScene({ scene: cloned });
		expect(reopened.transitions).toEqual([{
			id: "slide-1",
			afterElementId: "video-a",
			kind: "slide",
			direction: "up",
			duration: t(90_000),
		}]);
	});

	test("audio fade params survive save -> JSON clone -> reopen", () => {
		const scene = fixtureScene();
		scene.tracks.audio.push({
			id: "audio",
			name: "Audio",
			type: "audio",
			muted: false,
			elements: [
				{
					id: "music",
					type: "audio",
					sourceType: "upload",
					name: "music.wav",
					mediaId: "media-music",
					startTime: t(0),
					duration: t(1_440_000),
					trimStart: t(0),
					trimEnd: t(0),
					params: { volume: 0, fadeIn: 0.75, fadeOut: 0.5 },
				},
			],
		});

		const saved = serializeScene({ scene });
		// A real structured clone, i.e. what crosses IndexedDB: no widening
		// assertion needed (unlike the JSON.parse pattern above).
		const reopened = deserializeScene({ scene: structuredClone(saved) });
		const params = reopened.tracks.audio[0].elements[0].params;
		expect(params.fadeIn).toBe(0.75);
		expect(params.fadeOut).toBe(0.5);
	});

	test("legacy scenes without transitions still reopen unchanged", () => {
		const scene = fixtureScene();
		delete scene.transitions;
		const saved = serializeScene({ scene });
		const reopened = deserializeScene({ scene: saved });
		expect(reopened.transitions).toBeUndefined();
		expect(reopened.tracks.main.elements).toHaveLength(2);
	});

	test("an explicitly cleared transition stays cleared", () => {
		const scene = fixtureScene();
		scene.transitions = [];
		expect(deserializeScene({ scene: serializeScene({ scene }) }).transitions).toEqual([]);
	});
});
