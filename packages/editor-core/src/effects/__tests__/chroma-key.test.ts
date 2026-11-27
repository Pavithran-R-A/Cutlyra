import { describe, expect, test } from "bun:test";
import { effectsRegistry, registerDefaultEffects, buildDefaultEffectInstance } from "@/effects";
import {
	CHROMA_KEY_EFFECT_TYPE,
	DEFAULT_CHROMA_KEY,
	MAX_CHROMA_DISTANCE,
	chromaKeyAlpha,
	chromaKeyFromParams,
	chromaKeySpillColor,
	chromaKeyUniforms,
	parseHexColor,
} from "@/effects/chroma-key";
import { chromaKeyEffectDefinition } from "@/effects/definitions/chroma-key";

const GREEN: [number, number, number] = [0, 177 / 255, 64 / 255];
const RED: [number, number, number] = [1, 0, 0];
const BLUE: [number, number, number] = [0, 0, 1];

describe("chroma key model", () => {
	test("defaults are the green-screen values the panel starts from", () => {
		expect(chromaKeyFromParams(undefined)).toEqual(DEFAULT_CHROMA_KEY);
		expect(parseHexColor(DEFAULT_CHROMA_KEY.keyColor)).toEqual(GREEN);
	});

	test("parses 3- and 6-digit hex, and falls back to green on junk", () => {
		expect(parseHexColor("#f00")).toEqual([1, 0, 0]);
		expect(parseHexColor("00ff00")).toEqual([0, 1, 0]);
		expect(parseHexColor("not-a-colour")).toEqual(GREEN);
		expect(parseHexColor(undefined)).toEqual(GREEN);
	});

	test("clamps the sliders into 0..100 and normalises the colour spelling", () => {
		const key = chromaKeyFromParams({
			keyColor: "00ff00",
			similarity: 999,
			softness: -4,
			spill: Number.NaN,
		});
		expect(key.keyColor).toBe("#00ff00");
		expect(key.similarity).toBe(100);
		expect(key.softness).toBe(0);
		// NaN is not a value the exporter could read, so the default stands.
		expect(key.spill).toBe(DEFAULT_CHROMA_KEY.spill);
	});

	test("uniforms scale the sliders onto the Cb/Cr distance range", () => {
		const uniforms = chromaKeyUniforms(DEFAULT_CHROMA_KEY);
		expect(uniforms.u_key).toEqual([...GREEN]);
		expect(uniforms.u_similarity).toBeCloseTo((30 / 100) * MAX_CHROMA_DISTANCE);
		expect(uniforms.u_softness).toBeCloseTo((8 / 100) * MAX_CHROMA_DISTANCE);
		expect(uniforms.u_spill).toBeCloseTo(0.6);
	});

	test("the key colour itself is fully transparent, a subject is fully opaque", () => {
		const key = chromaKeyUniforms(DEFAULT_CHROMA_KEY);
		expect(chromaKeyAlpha({ rgb: GREEN, key })).toBe(0);
		expect(chromaKeyAlpha({ rgb: RED, key })).toBe(1);
		expect(chromaKeyAlpha({ rgb: BLUE, key })).toBe(1);
		// A grey shadow on the screen keeps almost all of its luma change: only
		// the chroma moved, and only a little.
		expect(chromaKeyAlpha({ rgb: [0.25, 0.3, 0.25], key })).toBeGreaterThan(0.9);
	});

	test("softness produces a real ramp and similarity moves the threshold", () => {
		// A colour just past the default threshold: with an 8% ramp it is only
		// partly opaque; with no ramp it snaps fully opaque.
		const edgePixel: [number, number, number] = [0.3, 0.6, 0.3];
		const soft = chromaKeyUniforms({ ...DEFAULT_CHROMA_KEY, softness: 8 });
		expect(chromaKeyAlpha({ rgb: edgePixel, key: soft })).toBeCloseTo(0.16379, 3);
		const hard = chromaKeyUniforms({ ...DEFAULT_CHROMA_KEY, softness: 0 });
		expect(chromaKeyAlpha({ rgb: edgePixel, key: hard })).toBe(1);
		expect(chromaKeyUniforms({ ...DEFAULT_CHROMA_KEY, similarity: 100 }).u_similarity).toBe(
			MAX_CHROMA_DISTANCE,
		);
	});

	test("spill removes green excess only, leaving a red subject untouched", () => {
		expect(chromaKeySpillColor({ rgb: [0.6, 0.9, 0.5], spill: 1 })[1]).toBeCloseTo(0.6);
		expect(chromaKeySpillColor({ rgb: RED, spill: 1 })).toEqual(RED);
		expect(chromaKeySpillColor({ rgb: [0.2, 0.8, 0.2], spill: 0 })).toEqual([0.2, 0.8, 0.2]);
	});
});

describe("chroma key effect definition", () => {
	registerDefaultEffects();

	test("is registered with the four shared params", () => {
		const definition = effectsRegistry.get(CHROMA_KEY_EFFECT_TYPE);
		expect(definition.name).toBe("Chroma key");
		expect(definition.params.map((p) => p.key)).toEqual([
			"keyColor",
			"similarity",
			"softness",
			"spill",
		]);
		// Keyframing is deliberately off: a threshold that animates in preview
		// but not in the MP4 would be a preview-only control.
		for (const param of definition.params) {
			expect(param.keyframable).toBe(false);
		}
	});

	test("builds the preview pass with the shared uniforms", () => {
		const instance = buildDefaultEffectInstance({ effectType: CHROMA_KEY_EFFECT_TYPE });
		expect(instance.enabled).toBe(true);
		const passes = chromaKeyEffectDefinition.renderer.buildPasses?.({
			effectParams: instance.params,
			width: 320,
			height: 240,
		});
		expect(passes).toEqual([
			{
				shader: "chroma-key",
				uniforms: { ...chromaKeyUniforms(DEFAULT_CHROMA_KEY) },
			},
		]);
	});
});
