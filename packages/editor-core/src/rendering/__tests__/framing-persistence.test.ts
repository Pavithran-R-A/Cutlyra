import { describe, expect, test } from "bun:test";
import { buildEdl } from "@/edl/build";
import {
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	fixtureAssetResolver,
	FIXTURE_OUTPUT,
} from "@/edl/__tests__/fixture";
import { readFramingFromParams } from "../framing";

function buildWithScene(scene: ReturnType<typeof buildFixtureScene>) {
	return buildEdl({
		project: buildFixtureProject(),
		scene,
		mediaAssets: buildFixtureMediaAssets(),
		output: FIXTURE_OUTPUT,
		resolveAsset: fixtureAssetResolver,
	});
}

function firstVideoClip(edl: ReturnType<typeof buildWithScene>) {
	const clip = edl.tracks
		.flatMap((t) => t.clips)
		.find((c) => c.kind === "video");
	if (!clip) throw new Error("expected a video clip in fixture");
	return clip;
}

describe("framing persistence/migration (#22)", () => {
	test("legacy element params without framing default to fit in EDL (migration)", () => {
		const scene = buildFixtureScene();
		const el = scene.tracks.main.elements.find((e) => e.type === "video");
		if (!el) throw new Error("fixture missing video element");
		// Simulate a project saved before framing existed.
		delete (el.params as Record<string, unknown> | undefined)?.framing;
		const edl = buildWithScene(scene);
		expect(firstVideoClip(edl).framing).toBe("fit");
		expect(readFramingFromParams({ params: el.params })).toBe("fit");
		expect(readFramingFromParams({ params: undefined })).toBe("fit");
	});

	test("explicit fill framing survives structuredClone/JSON round-trip and reaches EDL", () => {
		const scene = buildFixtureScene();
		const el = scene.tracks.main.elements.find((e) => e.type === "video");
		if (!el) throw new Error("fixture missing video element");
		el.params = { ...(el.params as Record<string, unknown> | undefined), framing: "fill" };

		const cloned = structuredClone(scene);
		const jsonRoundTrip = JSON.parse(JSON.stringify(scene)) as typeof scene;
		for (const candidate of [cloned, jsonRoundTrip]) {
			const cEl = candidate.tracks.main.elements.find((e) => e.type === "video");
			expect((cEl?.params as Record<string, unknown> | undefined)?.framing).toBe("fill");
			const edl = buildWithScene(candidate);
			expect(firstVideoClip(edl).framing).toBe("fill");
		}
	});

	test("fit framing is explicit-safe and does not regress to fill", () => {
		const scene = buildFixtureScene();
		const el = scene.tracks.main.elements.find((e) => e.type === "video");
		if (!el) throw new Error("fixture missing video element");
		el.params = { ...(el.params as Record<string, unknown> | undefined), framing: "fit" };
		expect(firstVideoClip(buildWithScene(structuredClone(scene))).framing).toBe("fit");
	});
});
