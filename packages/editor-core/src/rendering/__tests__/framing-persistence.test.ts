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

function buildWithScene({ scene }: { scene: ReturnType<typeof buildFixtureScene> }) {
	return buildEdl({
		project: buildFixtureProject(),
		scene,
		mediaAssets: buildFixtureMediaAssets(),
		output: FIXTURE_OUTPUT,
		resolveAsset: fixtureAssetResolver,
	});
}

function getFirstVideoElement(scene: ReturnType<typeof buildFixtureScene>) {
	const el = scene.tracks.main.elements.find((e) => e.type === "video");
	if (!el) throw new Error("expected a video element in fixture");
	return el;
}

function firstVideoClipFraming(scene: ReturnType<typeof buildFixtureScene>): string | undefined {
	const edl = buildWithScene({ scene });
	const clip = edl.tracks.flatMap((t) => t.clips).find((c) => c.kind === "video");
	if (!clip) throw new Error("expected a video clip in fixture");
	return clip.framing;
}

function readElementFraming(scene: ReturnType<typeof buildFixtureScene>): unknown {
	const el = getFirstVideoElement(scene);
	if (!el.params || typeof el.params !== "object" || !("framing" in el.params)) return undefined;
	return Reflect.get(el.params, "framing");
}

describe("framing persistence/migration (#22)", () => {
	test("legacy element params without framing default to fit in EDL (migration)", () => {
		const scene = buildFixtureScene();
		const el = getFirstVideoElement(scene);
		// Simulate a project saved before framing existed.
		if (el.params && typeof el.params === "object" && "framing" in el.params) {
			Reflect.deleteProperty(el.params, "framing");
		}
		expect(firstVideoClipFraming(scene)).toBe("fit");
		expect(readFramingFromParams({ params: el.params })).toBe("fit");
		expect(readFramingFromParams({ params: undefined })).toBe("fit");
	});

	test("explicit fill framing survives deep copy and reaches EDL (save/backup payload fidelity)", () => {
		const scene = buildFixtureScene();
		const el = getFirstVideoElement(scene);
		const prev = el.params && typeof el.params === "object" ? el.params : {};
		el.params = { ...prev, framing: "fill" };

		// structuredClone matches structured persistence copy semantics; JSON
		// serialization is exercised by project/backup payloads carrying params.
		const cloned = structuredClone(scene);
		expect(readElementFraming(cloned)).toBe("fill");
		expect(firstVideoClipFraming(cloned)).toBe("fill");

		const jsonParsed: unknown = JSON.parse(JSON.stringify(scene));
		expect(typeof jsonParsed).toBe("object");
		// Verify serialized params carry framing (backup/archive payload shape).
		expect(JSON.stringify(scene)).toContain('"framing":"fill"');
	});

	test("fit framing is explicit-safe and does not regress to fill", () => {
		const scene = buildFixtureScene();
		const el = getFirstVideoElement(scene);
		const prev = el.params && typeof el.params === "object" ? el.params : {};
		el.params = { ...prev, framing: "fit" };
		expect(firstVideoClipFraming(structuredClone(scene))).toBe("fit");
	});
});
