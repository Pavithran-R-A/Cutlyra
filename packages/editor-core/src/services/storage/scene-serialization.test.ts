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
