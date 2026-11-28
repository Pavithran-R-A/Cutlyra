import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildFixtureProject } from "@/edl/__tests__/fixture";
import type { MediaAsset } from "@/media/types";
import type { TimelineElement } from "@/timeline";
import { mediaTime, mediaTimeToSeconds } from "@/wasm";
import { TEMPLATES, getTemplate } from "../library";
import { applyTemplateToNewProject } from "../apply";

/**
 * These drive the REAL apply path: `createNewProject` (stubbed only for the
 * IndexedDB write), `UpdateProjectSettingsCommand`, `InsertElementCommand` and
 * `TransitionsSnapshotCommand` against the real `EditorCore` managers. What is
 * asserted is what a user would see in the timeline and what the native
 * exporter reads out of the scene.
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

function asset({ id, type }: { id: string; type: "video" | "image" }): MediaAsset {
	return {
		id,
		name: `${id}.${type === "image" ? "png" : "mp4"}`,
		type,
		width: 1080,
		height: 1920,
		duration: 12,
		file: new File([], `${id}.${type === "image" ? "png" : "mp4"}`),
	};
}

type Harness = { editor: EditorCore; projectId: string };

/**
 * Boot an editor whose `createNewProject` builds a real fixture project
 * without the storage layer (no IndexedDB under `bun test`) and whose
 * `prepareMedia` can register real `MediaAsset`s — the two things the native
 * import pipeline would otherwise provide.
 */
function bootHarness(): Harness {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	const harness: Harness = { editor, projectId: "proj-template-apply" };

	spyOn(editor.project, "createNewProject").mockImplementation(async () => {
		const project = {
			...buildFixtureProject(),
			metadata: {
				...buildFixtureProject().metadata,
				id: harness.projectId,
				name: "Template",
			},
		};
		const scene = buildDefaultScene({ name: "Main scene", isMain: true });
		project.scenes = [scene];
		project.currentSceneId = scene.id;
		editor.project.setActiveProject({ project });
		editor.media.clearAllAssets();
		editor.scenes.initializeScenes({
			scenes: [scene],
			currentSceneId: scene.id,
		});
		return harness.projectId;
	});

	return harness;
}

afterEach(() => {
	EditorCore.reset();
});

function seconds(ticks: number): number {
	return mediaTimeToSeconds({ time: mediaTime({ ticks }) });
}

describe("applyTemplateToNewProject", () => {
	it("inserts every filled slot, pins the template's canvas and adds its transitions", async () => {
		const template = getTemplate({ id: "ig-reel-pop" });
		expect(template).not.toBeNull();
		if (!template) return;
		const h = bootHarness();

		const result = await applyTemplateToNewProject({
			editor: h.editor,
			template,
			prepareMedia: async ({ slots }) => {
				h.editor.media.setAssets({
					assets: [asset({ id: "clip-a", type: "video" }), asset({ id: "clip-b", type: "video" })],
				});
				const assignments: Record<string, { mediaId: string; name: string; type: "video" }> = {};
				for (const [index, slot] of slots.entries()) {
					assignments[slot.id] = {
						mediaId: index % 2 === 0 ? "clip-a" : "clip-b",
						name: slot.label,
						type: "video",
					};
				}
				return assignments;
			},
			text: { hook: "My hook" },
		});

		expect(result.summary.unfilledSlots).toHaveLength(0);
		expect(result.summary.insertedElements).toBe(
			template.mediaSlots.length + template.textSlots.length + (template.graphics?.length ?? 0),
		);

		const project = h.editor.project.getActive();
		expect(project.settings.canvasSize).toEqual(template.canvas);
		expect(project.settings.canvasSizeMode).toBe("custom");
		expect(project.settings.fps).toEqual(template.fps);
		expect(project.settings.background).toEqual(template.background);

		const scene = h.editor.scenes.getActiveScene();
		const main = scene.tracks.main.elements;
		expect(main).toHaveLength(template.mediaSlots.length);
		for (const [index, slot] of template.mediaSlots.entries()) {
			const element = main[index];
			expect(seconds(element.startTime)).toBeCloseTo(slot.startTime, 3);
			expect(seconds(element.duration)).toBeCloseTo(slot.duration, 3);
			expect(element.params.framing).toBe(slot.framing ?? "fit");
		}

		const transitions = h.editor.scenes.getActiveTransitions();
		expect(transitions).toHaveLength(template.mediaSlots.length - 1);
		for (const transition of transitions) {
			expect(transition.kind).toBe("fade");
		}

		const allElements: TimelineElement[] = [...main];
		for (const track of scene.tracks.overlay) {
			for (const element of track.elements) {
				allElements.push(element);
			}
		}
		const textElements = allElements.filter((element) => element.type === "text");
		expect(textElements).toHaveLength(template.textSlots.length);
		const hook = textElements.find((element) => element.params.content === "My hook");
		expect(hook).toBeDefined();

		for (const slot of template.graphics ?? []) {
			const graphic = allElements.find(
				(element) =>
					element.type === "graphic" &&
					"definitionId" in element &&
					element.definitionId === slot.definitionId,
			);
			expect(graphic).toBeDefined();
		}
	});

	it("keeps text and graphics when the user skips media, and reports every empty slot", async () => {
		const template = TEMPLATES.find((candidate) => (candidate.graphics ?? []).length > 0);
		expect(template).toBeDefined();
		if (!template) return;
		const h = bootHarness();

		const result = await applyTemplateToNewProject({
			editor: h.editor,
			template,
			prepareMedia: async () => ({}),
		});

		expect(result.summary.unfilledSlots.map((slot) => slot.slotId)).toEqual(
			template.mediaSlots.map((slot) => slot.id),
		);
		const scene = h.editor.scenes.getActiveScene();
		expect(scene.tracks.main.elements).toHaveLength(0);
		// `flatMap` over the overlay-track union infers arrays-of-arrays, so
		// collect with an explicit loop into the engine's own element type.
		const overlayElements: TimelineElement[] = [];
		for (const track of scene.tracks.overlay) {
			for (const element of track.elements) {
				overlayElements.push(element);
			}
		}
		const overlaysOfType = (type: TimelineElement["type"]): TimelineElement[] =>
			overlayElements.filter((element) => element.type === type);
		expect(overlaysOfType("text")).toHaveLength(template.textSlots.length);
		expect(overlaysOfType("graphic")).toHaveLength((template.graphics ?? []).length);
		// No clips means no transitions, not stale ones pointing at nothing.
		expect(h.editor.scenes.getActiveTransitions()).toHaveLength(0);
	});

	it("creating the project does not disturb the template descriptor", async () => {
		const template = TEMPLATES[0];
		const before = JSON.stringify(template);
		const h = bootHarness();
		await applyTemplateToNewProject({
			editor: h.editor,
			template,
			prepareMedia: async () => ({}),
		});
		expect(JSON.stringify(template)).toBe(before);
	});

	it("asks the picker only for slots that are not already filled", async () => {
		const template = getTemplate({ id: "ig-reel-pop" });
		expect(template).not.toBeNull();
		if (!template || template.mediaSlots.length < 2) return;
		const h = bootHarness();
		const prefilled = template.mediaSlots[0];
		if (!prefilled) return;
		const asked: string[][] = [];

		const result = await applyTemplateToNewProject({
			editor: h.editor,
			template,
			media: {
				[prefilled.id]: {
					mediaId: "already-there",
					name: "Already there",
					type: prefilled.kind,
					sourceDuration: 9,
				},
			},
			prepareMedia: async ({ slots }) => {
				asked.push(slots.map((slot) => slot.id));
				h.editor.media.setAssets({
					assets: slots.map((slot) =>
						asset({ id: `picked-${slot.id}`, type: slot.kind }),
					),
				});
				const assignments: Record<string, {
					mediaId: string;
					name: string;
					type: "video" | "image";
					sourceDuration: number;
				}> = {};
				for (const slot of slots) {
					assignments[slot.id] = {
						mediaId: `picked-${slot.id}`,
						name: `Picked ${slot.label}`,
						type: slot.kind,
						sourceDuration: 6,
					};
				}
				return assignments;
			},
		});

		// The prefilled slot is never offered to the picker; every other slot is,
		// in template order.
		expect(asked).toHaveLength(1);
		expect(asked[0]).toEqual(
			template.mediaSlots.slice(1).map((slot) => slot.id),
		);
		expect(result.elementRefs[prefilled.id]).toBeDefined();
		expect(result.summary.unfilledSlots).toHaveLength(0);
	});
});
