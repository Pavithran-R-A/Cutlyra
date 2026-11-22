/**
 * Fades through the REAL editor: the same `UpdateElementsCommand` the Edit
 * panel executes, then Undo, then Redo, reading the params and the EDL
 * envelope each time.
 *
 * This is the "survives undo/redo" half of the fade contract; the
 * save/reopen half lives in `services/storage/scene-serialization.test.ts`.
 * The wasm stub is preloaded repo-wide via bunfig.toml, and the fixture
 * project/scene come from the EDL golden fixture so the clip timing is the
 * same one every export test uses.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EditorCore } from "@/core";
import { UpdateElementsCommand } from "@/commands";
import { buildFixtureProject, buildFixtureScene } from "@/edl/__tests__/fixture";
import { buildAudioFadeEnvelope, buildAudioFadeParamsPatch } from "../audio-fades";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { AudioElement } from "@/timeline/types";

function bootEditor(): EditorCore {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	const project = buildFixtureProject();
	const scene = buildFixtureScene();
	project.scenes = [scene];
	project.currentSceneId = scene.id;
	editor.project.setActiveProject({ project });
	editor.media.clearAllAssets();
	editor.scenes.initializeScenes({ scenes: [scene], currentSceneId: scene.id });
	return editor;
}

function readAudioClip(editor: EditorCore): AudioElement {
	const scene = editor.scenes.getActiveScene();
	const track = scene.tracks.audio.find((candidate) => candidate.id === "track-audio");
	const element = track?.elements.find((candidate) => candidate.id === "clip-music");
	if (!element) throw new Error("fixture audio clip missing");
	return element as AudioElement;
}

function fadeTrack(editor: EditorCore): void {
	const element = readAudioClip(editor);
	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId: "track-audio",
					elementId: element.id,
					patch: {
						params: {
							...element.params,
							...buildAudioFadeParamsPatch({
								params: { fadeIn: 0.5, fadeOut: 0.25 },
								durationTicks: element.duration,
							}),
						},
					},
				},
			],
		}),
	});
}

afterEach(() => {
	EditorCore.reset();
});

describe("audio fade through the editor", () => {
	it("writes fade params, survives undo and redo, and yields the same envelope", () => {
		const editor = bootEditor();
		const clipDuration = mediaTime({ ticks: 4 * TICKS_PER_SECOND });

		expect(readAudioClip(editor).params.fadeIn).toBeUndefined();

		fadeTrack(editor);
		const faded = readAudioClip(editor);
		expect(faded.params.fadeIn).toBe(0.5);
		expect(faded.params.fadeOut).toBe(0.25);
		expect(buildAudioFadeEnvelope({ params: faded.params, durationTicks: faded.duration })).toEqual({
			inTicks: TICKS_PER_SECOND / 2,
			outTicks: TICKS_PER_SECOND / 4,
		});

		editor.command.undo();
		const undone = readAudioClip(editor);
		expect(undone.params.fadeIn).toBeUndefined();
		expect(buildAudioFadeEnvelope({ params: undone.params, durationTicks: undone.duration })).toBeNull();

		editor.command.redo();
		const redone = readAudioClip(editor);
		expect(redone.params.fadeIn).toBe(0.5);
		expect(redone.duration).toBe(clipDuration);
		expect(buildAudioFadeEnvelope({ params: redone.params, durationTicks: redone.duration })).toEqual({
			inTicks: TICKS_PER_SECOND / 2,
			outTicks: TICKS_PER_SECOND / 4,
		});
	});
});
