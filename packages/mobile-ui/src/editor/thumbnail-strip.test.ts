/**
 * GitHub #54 — the bounded async filmstrip store (thumbnail-strip.ts).
 *
 * Drives the REAL store against an INJECTED fake bridge and saver — the
 * store's own test seams (`__setNativeBridgeGetterForTests` /
 * `__setMediaAssetSaverForTests`). Deliberately NOT bun's `mock.module`:
 * that mock is process-global in the single root `bun test` process,
 * bun has no reliable unmock, and `afterAll` restoration proved not to
 * protect later files — an earlier attempt here broke native-bridge's
 * own `getNativeBridge` suite. Success caching, idempotent kicks,
 * failure → `null` + bounded cooldown retry, the in-flight concurrency
 * cap, FIFO eviction, and the persistence hook's relative-path
 * conversion/guards are all exercised against the real implementation.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { MediaAsset } from "@cutlyra/editor-core";
import type {
	MediaHandle,
	ThumbnailStrip,
	ThumbnailStripSpec,
} from "@cutlyra/native-bridge";
import {
	__resetNativeMediaPathResolverForTests,
	registerNativeMediaPathResolver,
} from "@cutlyra/editor-core/media/native-paths";

const {
	kickThumbnailStrip,
	getThumbnailStrip,
	getThumbnailsVersion,
	subscribeThumbnails,
	makeStripPersister,
	__resetThumbnailStripForTests,
	__setNativeBridgeGetterForTests,
	__setMediaAssetSaverForTests,
} = await import("./thumbnail-strip");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface GeneratedCall {
	handle: MediaHandle;
	spec: ThumbnailStripSpec;
}

type MediaAssetSaveArgs = {
	projectId: string;
	mediaAsset: MediaAsset;
};

const generateCalls: GeneratedCall[] = [];
// The bridge contract is async, but a synchronous fake return is fine —
// the store `await`s whatever comes back.
let generateImpl: (
	params: GeneratedCall,
) => ThumbnailStrip | Promise<ThumbnailStrip> = defaultGenerate;

function defaultGenerate({ handle, spec }: GeneratedCall): ThumbnailStrip {
	return {
		assetId: handle.id,
		uris: Array.from(
			{ length: spec.count },
			(_, i) =>
				`capacitor://localhost/_capacitor_file_/data/root/thumbnails/${handle.id}/${i}.jpg`,
		),
		timestampsMicros: Array.from({ length: spec.count }, (_, i) =>
			Math.round((handle.durationMicros * (2 * i + 1)) / (2 * spec.count)),
		),
	};
}

/** Injected through the store's bridge seam — records every call and
 *  defers to the current `generateImpl` (success/failure/queue tests). */
const fakeBridge = {
	generateThumbnails: (params: GeneratedCall): Promise<ThumbnailStrip> => {
		generateCalls.push(params);
		return Promise.resolve(generateImpl(params));
	},
};

/** Injected through the store's saver seam — counts persist writes. */
const saveMediaAsset = mock(async (_args: MediaAssetSaveArgs): Promise<void> => {});

/** Drain every microtask hop (bridge → generate → store → notify). */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function kickArgs(assetId: string) {
	return {
		assetId,
		rawPath: `/data/root/Proxies/${assetId}.mp4`,
		durationMicros: 4_000_000,
		fileName: `${assetId}.mp4`,
	};
}

function fakeAsset(id = "a1"): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([], `${id}.mp4`, { type: "video/mp4" }),
	};
}

// Per-test console.warn spy: created in beforeEach and restored in
// afterEach so it can never swallow later files' warnings in the shared
// test process.
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	__resetThumbnailStripForTests(); // also restores the REAL seams
	__resetNativeMediaPathResolverForTests();
	generateCalls.length = 0;
	generateImpl = defaultGenerate;
	saveMediaAsset.mockClear();
	// Inject this test's fakes through the store's seams — no module mocks.
	__setNativeBridgeGetterForTests(async () => fakeBridge);
	__setMediaAssetSaverForTests(saveMediaAsset);
	warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("kickThumbnailStrip", () => {
	test("caches generated frames, bumps the version, notifies subscribers, and dedupes", async () => {
		const listener = mock(() => {});
		subscribeThumbnails(listener);

		kickThumbnailStrip(kickArgs("a1"));
		// Second kick while the first is in flight must not double-generate.
		kickThumbnailStrip(kickArgs("a1"));
		await flush();

		const frames = getThumbnailStrip("a1");
		expect(Array.isArray(frames)).toBe(true);
		// 4s source at 2 fps → count 8; first frame is cell-0 midpoint.
		expect(frames).toHaveLength(8);
		expect(frames?.[0]?.timeSec).toBeCloseTo(0.25, 6);
		expect(frames?.[0]?.uri).toContain("/a1/0.jpg");
		expect(generateCalls).toHaveLength(1);
		expect(getThumbnailsVersion()).toBeGreaterThan(0);
		expect(listener).toHaveBeenCalled();

		// A later render kicks again — still idempotent.
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(generateCalls).toHaveLength(1);
	});

	test("invalid arguments never reach native", async () => {
		kickThumbnailStrip({ ...kickArgs("a1"), durationMicros: 0 });
		kickThumbnailStrip({ ...kickArgs("a2"), rawPath: "" });
		kickThumbnailStrip({ ...kickArgs(""), durationMicros: 1_000_000 });
		await flush();
		expect(generateCalls).toHaveLength(0);
		expect(getThumbnailStrip("a1")).toBeUndefined();
	});

	test("failure caches null, warns once per attempt, and retries only after a cooldown up to the attempt cap", async () => {
		let clock = 0;
		__resetThumbnailStripForTests({
			retryCooldownMs: 10_000,
			now: () => clock,
		});
		// That custom reset also restored the REAL seams — put the fake
		// bridge back so the attempts are recorded (and never hit native).
		__setNativeBridgeGetterForTests(async () => fakeBridge);
		generateImpl = () => Promise.reject(new Error("corrupt source"));

		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(getThumbnailStrip("a1")).toBeNull(); // honest placeholder upstream
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(generateCalls).toHaveLength(1);

		// Within the cooldown: renders may re-kick, nothing happens.
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(generateCalls).toHaveLength(1);

		// After the cooldown: one more attempt.
		clock = 20_000;
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(generateCalls).toHaveLength(2);

		// Third failure exhausts the cap — time marching on changes nothing.
		clock = 40_000;
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(generateCalls).toHaveLength(3);
		clock = 999_999;
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(generateCalls).toHaveLength(3);
		expect(getThumbnailStrip("a1")).toBeNull();
		expect(warnSpy).toHaveBeenCalledTimes(3); // one warn per real attempt
	});

	test("an empty native strip counts as a failure, not a silent empty success", async () => {
		generateImpl = ({ handle }) => ({
			assetId: handle.id,
			uris: [],
			timestampsMicros: [],
		});
		kickThumbnailStrip(kickArgs("a1"));
		await flush();
		expect(getThumbnailStrip("a1")).toBeNull();
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("caps in-flight generations at 3 and drains the rest FIFO", async () => {
		const deferred: Array<{
			params: GeneratedCall;
			resolve: (strip: ThumbnailStrip) => void;
		}> = [];
		generateImpl = (params) =>
			new Promise((resolve) => deferred.push({ params, resolve }));

		for (let i = 1; i <= 5; i++) kickThumbnailStrip(kickArgs(`a${i}`));
		await flush();
		// Only the first three started; a4/a5 are queued.
		expect(generateCalls).toHaveLength(3);

		const first = deferred.shift();
		if (!first) throw new Error("expected an in-flight generation");
		first.resolve(defaultGenerate(first.params));
		await flush();
		expect(generateCalls).toHaveLength(4);

		// Keep resolving whatever is in flight until all five completed —
		// each resolution lets the store drain the next queued kick.
		for (
			let i = 0;
			i < 20 && (generateCalls.length < 5 || deferred.length > 0);
			i++
		) {
			const next = deferred.shift();
			next?.resolve(defaultGenerate(next.params));
			await flush();
		}
		expect(generateCalls).toHaveLength(5);
		for (let i = 1; i <= 5; i++) {
			expect(Array.isArray(getThumbnailStrip(`a${i}`))).toBe(true);
		}
	});

	test("evicts the oldest strip beyond the 48-entry bound", async () => {
		for (let i = 0; i < 49; i++) {
			kickThumbnailStrip(kickArgs(`asset-${i}`));
			await flush();
		}
		// Inserting the 49th evicted exactly the oldest entry.
		expect(getThumbnailStrip("asset-0")).toBeUndefined();
		expect(getThumbnailStrip("asset-1")).toBeDefined();
		expect(getThumbnailStrip("asset-47")).toBeDefined();
		expect(getThumbnailStrip("asset-48")).toBeDefined();
	});
});

describe("makeStripPersister", () => {
	const frame = {
		timeSec: 0.25,
		uri: "capacitor://localhost/_capacitor_file_/data/root/thumbnails/a1/0.jpg",
	};

	function registerRoot(): void {
		registerNativeMediaPathResolver({
			root: "/data/root",
			toPlaybackUri: (nativeUri) =>
				`capacitor://localhost/_capacitor_file_${nativeUri}`,
		});
	}

	test("converts playback URIs to custody-relative paths, mutates the live asset, and saves", async () => {
		registerRoot();
		const asset = fakeAsset();
		const persist = makeStripPersister({
			projectId: "p1",
			asset,
			isAssetLive: () => true,
		});
		expect(persist).toBeDefined();

		persist?.([frame]);
		await flush();

		expect(asset.thumbnailStrip).toEqual([
			{ timeSec: 0.25, relativePath: "thumbnails/a1/0.jpg" },
		]);
		expect(saveMediaAsset).toHaveBeenCalledTimes(1);
		expect(saveMediaAsset).toHaveBeenCalledWith({
			projectId: "p1",
			mediaAsset: asset,
		});
	});

	test("skips the write when the manifest is already identical (reopen fast-path)", async () => {
		registerRoot();
		const asset = fakeAsset();
		const persist = makeStripPersister({
			projectId: "p1",
			asset,
			isAssetLive: () => true,
		});

		persist?.([frame]);
		await flush();
		persist?.([frame]);
		await flush();

		expect(saveMediaAsset).toHaveBeenCalledTimes(1);
	});

	test("never resurrects metadata for an asset deleted mid-generation", async () => {
		registerRoot();
		const asset = fakeAsset();
		const persist = makeStripPersister({
			projectId: "p1",
			asset,
			isAssetLive: () => false,
		});

		persist?.([frame]);
		await flush();

		expect(asset.thumbnailStrip).toBeUndefined();
		expect(saveMediaAsset).not.toHaveBeenCalled();
	});

	test("without a custody root (web / unregistered) there is nothing durable to persist", async () => {
		// Resolver deliberately NOT registered for this test.
		const asset = fakeAsset();
		const persist = makeStripPersister({
			projectId: "p1",
			asset,
			isAssetLive: () => true,
		});

		persist?.([frame]);
		await flush();

		expect(asset.thumbnailStrip).toBeUndefined();
		expect(saveMediaAsset).not.toHaveBeenCalled();
	});

	test("no projectId → no persister at all (nothing to save against)", () => {
		expect(
			makeStripPersister({
				projectId: null,
				asset: fakeAsset(),
				isAssetLive: () => true,
			}),
		).toBeUndefined();
	});
});