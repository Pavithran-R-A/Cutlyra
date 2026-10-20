/**
 * GitHub #30 / Linear PAV-81 — preview/export parity for the canvas size.
 *
 * The preview renders `project.settings.canvasSize` directly
 * (preview-renderer.tsx reads `activeProject.settings.canvasSize`, and the
 * renderer-manager export path builds its scene at the same size), and the
 * export's contract is the EDL's `canvas` field, which `buildEdl` fills from
 * the SAME `project.settings.canvasSize` (build.ts). The two can only
 * disagree if some code path writes a different field — which is precisely
 * what the pre-#30 InsertElementCommand did, silently flipping a user's
 * explicit 1:1 canvas to 1080x1920 so preview AND export both rendered the
 * wrong shape.
 *
 * These tests pin the EDL side of the contract with real `buildEdl` output:
 * whatever the (now-guarded) adoption decision leaves in settings IS the
 * canvas the exporter receives. Preview parity is structural — the preview
 * component reads the same field — and is re-verified visually on-device in
 * Stage 7's POCO certification.
 *
 * The wasm stub is preloaded repo-wide via bunfig.toml.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CANVAS_SIZE,
	getAdoptedCanvasSizeForFirstVisualElement,
} from "@/canvas/sizes";
import { buildEdl } from "../index";
import {
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	FIXTURE_OUTPUT,
	fixtureAssetResolver,
} from "./fixture";

const explicitSquare = { width: 1080, height: 1080 };

function exportedCanvas({
	canvasSize,
}: {
	canvasSize: { width: number; height: number };
}): { width: number; height: number } {
	const project = buildFixtureProject();
	project.settings = { ...project.settings, canvasSize };
	const edl = buildEdl({
		project,
		scene: buildFixtureScene(),
		mediaAssets: buildFixtureMediaAssets(),
		output: FIXTURE_OUTPUT,
		resolveAsset: fixtureAssetResolver,
	});
	return edl.meta.canvas;
}

describe("canvas adoption -> export parity (GitHub #30)", () => {
	test("an explicit 1:1 canvas reaches the exported EDL unchanged, even for a portrait import", () => {
		// The #30 scenario end-to-end at the EDL boundary: the user picked
		// 1:1, the first portrait clip did NOT get to adopt (guarded), so the
		// exporter must receive 1080x1080 — not the 1080x1920 the pre-fix
		// command wrote into settings.
		expect(
			getAdoptedCanvasSizeForFirstVisualElement({
				currentSize: explicitSquare,
				currentMode: "preset",
				isFirstVisualElement: true,
				asset: { type: "video", width: 1080, height: 1920 },
			}),
		).toBeNull();
		expect(exportedCanvas({ canvasSize: explicitSquare })).toEqual({
			width: 1080,
			height: 1080,
		});
	});

	test("a legitimately adopted portrait canvas reaches the exported EDL", () => {
		const adopted = getAdoptedCanvasSizeForFirstVisualElement({
			currentSize: { ...DEFAULT_CANVAS_SIZE },
			currentMode: "preset",
			isFirstVisualElement: true,
			asset: { type: "video", width: 1080, height: 1920 },
		});
		expect(adopted).toEqual({ width: 1080, height: 1920 });
		expect(exportedCanvas({ canvasSize: adopted! })).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	test("an explicit non-default size keeps its exact pixels through export", () => {
		expect(exportedCanvas({ canvasSize: { width: 1280, height: 720 } })).toEqual(
			{ width: 1280, height: 720 },
		);
		expect(
			exportedCanvas({ canvasSize: { width: 1440, height: 1080 } }),
		).toEqual({ width: 1440, height: 1080 });
	});
});
