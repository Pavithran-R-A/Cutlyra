import { describe, expect, test } from "bun:test";
import {
	FIXTURE_OUTPUT,
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	fixtureAssetResolver,
} from "@/edl/__tests__/fixture";
import { buildEdl } from "@/edl/build";
import { validateEdl } from "@/edl/validate";
import { EDL_SCHEMA_ID, type Edl } from "@/edl/types";
import {
	LEGACY_EDL_SCHEMA_ID,
	LEGACY_FILESYSTEM_ROOT_BASENAMES,
} from "../legacy-filesystem-compat";
import {
	getRegisteredNativeMediaRoot,
	__resetNativeMediaPathResolverForTests,
	registerNativeMediaPathResolver,
	resolveNativeMediaPath,
	relativeMediaPathFromPlaybackUrl,
	relativeMediaPathFromRawPath,
	resolveNativeMediaRawPath,
	salvageRelativeMediaPathFromStaleUrl,
} from "../native-paths";

describe("legacy filesystem compat (pre-rebrand project migration)", () => {
	test("the compat module isolates the pre-rebrand root + frozen schema literal", () => {
		expect(LEGACY_FILESYSTEM_ROOT_BASENAMES).toContain("kneecap");
		expect(LEGACY_FILESYSTEM_ROOT_BASENAMES).toContain("cutlyra");
		expect(LEGACY_EDL_SCHEMA_ID).toBe("https://kneecap.dev/schema/edl-v1.json");
	});

	test("pre-rebrand iOS URLs (Application Support/kneecap/...) still salvage", () => {
		const stale = "capacitor://localhost/_capacitor_file_/var/mobile/Containers/Data/Application/OLD-UUID/Library/Application%20Support/kneecap/Media/native-1.mp4";
		expect(salvageRelativeMediaPathFromStaleUrl(stale)).toBe(
			"Media/native-1.mp4",
		);
	});

	test("pre-rebrand Android URLs (noBackupFilesDir) still salvage", () => {
		const stale =
			"https://localhost/_capacitor_file_/data/user/0/app.cutlyra.editor/no_backup/media/uuid-1.mp4";
		expect(salvageRelativeMediaPathFromStaleUrl(stale)).toBe(
			"media/uuid-1.mp4",
		);
	});

	test("current iOS root URLs salvage through the new basename", () => {
		const stale = "capacitor://localhost/_capacitor_file_/var/mobile/Containers/Data/Application/NEW-UUID/Library/Application%20Support/cutlyra/Proxies/asset-9.bin";
		expect(salvageRelativeMediaPathFromStaleUrl(stale)).toBe(
			"Proxies/asset-9.bin",
		);
	});

	test("URLs with no recognizable custody segment return undefined", () => {
		expect(
			salvageRelativeMediaPathFromStaleUrl(
				"https://localhost/_capacitor_file_/var/mobile/unknown-root/x.mp4",
			),
		).toBeUndefined();
		expect(salvageRelativeMediaPathFromStaleUrl("blob:https://x/y")).toBeUndefined();
	});

	test("old-project flow: salvaged relative path re-anchors to the CURRENT root", () => {
		__resetNativeMediaPathResolverForTests();
		const CURRENT_ROOT =
			"/var/mobile/Containers/Data/Application/NEW-UUID/Library/Application Support/cutlyra";
		registerNativeMediaPathResolver({
			root: CURRENT_ROOT,
			toPlaybackUri: (p) => `capacitor://localhost/_capacitor_file_${p}`,
		});
		const staleUrl =
			"capacitor://localhost/_capacitor_file_/var/mobile/Containers/Data/Application/OLD-UUID/Library/Application%20Support/kneecap/Media/native-1.mp4";
		const salvaged = salvageRelativeMediaPathFromStaleUrl(staleUrl);
		expect(salvaged).toBe("Media/native-1.mp4");
		expect(resolveNativeMediaPath(salvaged!)).toBe(
			`capacitor://localhost/_capacitor_file_${CURRENT_ROOT}/Media/native-1.mp4`,
		);
	});

	test("new-project flow: paths registered under the current root resolve; raw-path round-trip works", () => {
		__resetNativeMediaPathResolverForTests();
		const CURRENT_ROOT =
			"/var/mobile/Containers/Data/Application/NEW-UUID/Library/Application Support/cutlyra";
		registerNativeMediaPathResolver({
			root: CURRENT_ROOT,
			toPlaybackUri: (p) => `capacitor://localhost/_capacitor_file_${p}`,
		});
		const rel = relativeMediaPathFromPlaybackUrl({
			url: `capacitor://localhost/_capacitor_file_${CURRENT_ROOT}/Media/new-asset.mp4`,
			root: CURRENT_ROOT,
		});
		expect(rel).toBe("Media/new-asset.mp4");
		expect(resolveNativeMediaRawPath(rel!)).toBe(
			`${CURRENT_ROOT}/Media/new-asset.mp4`,
		);
		expect(getRegisteredNativeMediaRoot()).toBe(CURRENT_ROOT);
		__resetNativeMediaPathResolverForTests();
	});

	test("new EDL writes carry only the Cutlyra schema id", () => {
		expect(EDL_SCHEMA_ID).toBe("https://cutlyra.dev/schema/edl-v1.json");
	});

	test("an EDL document persisted with the frozen pre-rebrand $schema still validates", () => {
		const oldDoc = {
			...buildEdl({
				project: buildFixtureProject(),
				scene: buildFixtureScene(),
				mediaAssets: buildFixtureMediaAssets(),
				output: FIXTURE_OUTPUT,
				resolveAsset: fixtureAssetResolver,
			}),
			$schema: LEGACY_EDL_SCHEMA_ID,
		};
		const result = validateEdl({ edl: oldDoc as Edl });
		expect(result.ok).toBe(true);
	});
});
