import { describe, expect, test } from "bun:test";

import { buildEdl, type EdlAssetResolver } from "../build";
import {
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	FIXTURE_OUTPUT,
} from "./fixture";

const TPS = 120_000;

function buildWithResolver(resolveAsset: EdlAssetResolver) {
	return buildEdl({
		project: buildFixtureProject(),
		scene: buildFixtureScene(),
		mediaAssets: buildFixtureMediaAssets(),
		output: FIXTURE_OUTPUT,
		resolveAsset,
	});
}

const GIF_RESOLVER: EdlAssetResolver = ({ mediaId }) => ({
	sourceUri: `cutlyra-media://sandbox/${mediaId}`,
	gif: {
		loopCount: 2,
		frames: [
			{ uri: `cutlyra-media://sandbox/gif/${mediaId}/frame-000.png`, durationTicks: 0.2 * TPS },
			{ uri: `cutlyra-media://sandbox/gif/${mediaId}/frame-001.png`, durationTicks: 0.3 * TPS },
			{ uri: `cutlyra-media://sandbox/gif/${mediaId}/frame-002.png`, durationTicks: 0.5 * TPS },
		],
	},
});

describe("EDL v1 additive GIF assets", () => {
	test("a resolver-supplied gif is emitted on the asset with frame handles", () => {
		const edl = buildWithResolver(GIF_RESOLVER);
		const asset = edl.assets.find((candidate) => candidate.assetId === "asset-video-1");

		expect(asset?.gif?.loopCount).toBe(2);
		expect(asset?.gif?.frames.map((frame) => frame.durationTicks)).toEqual([24_000, 36_000, 60_000]);
		expect(asset?.gif?.frames[0]?.uri).toContain("frame-000.png");
	});

	test("assets without a gif resolution stay byte-identical (no gif key)", () => {
		const edl = buildWithResolver(({ mediaId }) => ({
			sourceUri: `cutlyra-media://sandbox/${mediaId}`,
		}));
		for (const asset of edl.assets) {
			expect("gif" in asset).toBe(false);
		}
	});
});
