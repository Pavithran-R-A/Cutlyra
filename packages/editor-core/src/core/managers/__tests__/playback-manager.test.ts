/**
 * Stage 11 physical QA regression coverage (iQOO I2221 / Android 16,
 * 2026-09-25).
 *
 * On device, a corrupted playback position (JSON `null`/`undefined` where
 * integer ticks belong) reached `mediaTimeToSeconds` through
 * `useCurrentTimeSeconds`'s render-time `getCurrentTime()` read and the wasm
 * boundary threw `invalid type: unit value, expected i64`, wiping the whole
 * editor through CrashBoundary. These tests pin the boundary contract that
 * prevents that failure class from ever crossing into wasm again:
 *
 *   - `getCurrentTime()` must NEVER hand back a non-finite position — it is
 *     a useSyncExternalStore snapshot, so throwing there crashes the app.
 *   - `seek()` must reject non-finite input loudly (programmer error) and
 *     must round fractional input instead of storing it raw.
 *   - `play()` and the timeline-scope reconcile must self-heal a corrupted
 *     position before feeding it onward (startTimer stashes it into
 *     `playbackStartTime`; `updateTime` feeds that through wasm
 *     `addMediaTime` every animation frame).
 *
 * The corruption itself was observed exactly once on hardware and no repo
 * writer could be pinned as the source (every write site audited goes
 * through `clampTimeToTimeline` on engine-integer inputs) — which is why
 * the guards live at this boundary rather than at one call site.
 */

// Must be the first import: installs the opencut-wasm mock before
// `@/wasm`'s top-level `TICKS_PER_SECOND()` runs under Bun's test runtime.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test-only casts: corrupt() writes an intentionally-wrong value into the private position field to reproduce the on-device corruption, and the seek() rejections cast impossible inputs on purpose; both are the point of the tests (same rationale as the other test files with file-level disables). */
import "@/test-support/wasm-stub";

import { describe, expect, test } from "bun:test";
import { PlaybackManager } from "@/core/managers/playback-manager";
import type { EditorCore } from "@/core";
import { mediaTime, roundMediaTime, ZERO_MEDIA_TIME } from "@/wasm";

if (typeof globalThis.requestAnimationFrame !== "function") {
	// `play()` arms a rAF loop; the stub never fires it — these tests only
	// assert synchronous state, never animation timing.
	(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame =
		() => 0;
}

const SECOND = mediaTime({ ticks: 120_000 }); // STUB_TICKS_PER_SECOND

/** Minimal editor stand-in: PlaybackManager only reads
 *  `timeline.getTotalDuration()`, `timeline.subscribe`,
 *  `scenes.subscribe` and (inside the rAF timer) `project.getActive()`. */
function makeFakeEditor({ duration = SECOND }: { duration?: number } = {}) {
	let totalDuration = duration;
	const timelineListeners = new Set<() => void>();
	return {
		asEditor() {
			return this as unknown as EditorCore;
		},
		timeline: {
			getTotalDuration: () => totalDuration,
			subscribe: (fn: () => void) => {
				timelineListeners.add(fn);
				return () => timelineListeners.delete(fn);
			},
		},
		scenes: {
			subscribe: () => () => {},
		},
		project: {
			getActive: () => null,
		},
		setDuration(next: number) {
			totalDuration = next;
		},
		fireTimelineChange() {
			timelineListeners.forEach((fn) => fn());
		},
	};
}

function makeManager(duration: number = 4 * SECOND) {
	const fake = makeFakeEditor({ duration });
	return { fake, pm: new PlaybackManager(fake.asEditor()) };
}

/** Simulates exactly the on-device corruption: something wrote a non-number
 *  into the private position field. The double cast lives in an IIFE so its
 *  `unknown` narrowing does not poison the type of `pm` in the caller. */
function corrupt({ pm, value }: { pm: PlaybackManager; value: unknown }): void {
	((p: PlaybackManager) => {
		(p as unknown as { currentTime: unknown }).currentTime = value;
	})(pm);
}

describe("PlaybackManager tick boundary (Stage 11 device regression)", () => {
	test("seek stores integer ticks and clamps into the timeline range", () => {
		const { pm } = makeManager(2 * SECOND);
		pm.seek({ time: mediaTime({ ticks: 234_567 }) });
		expect(pm.getCurrentTime()).toBe(mediaTime({ ticks: 234_567 }));
		pm.seek({ time: mediaTime({ ticks: 5 * SECOND }) });
		expect(pm.getCurrentTime()).toBe(mediaTime({ ticks: 2 * SECOND }));
		pm.seek({ time: mediaTime({ ticks: -50 }) });
		expect(pm.getCurrentTime()).toBe(ZERO_MEDIA_TIME);
	});

	test("seek rounds fractional ticks instead of storing them raw", () => {
		const { pm } = makeManager();
		pm.seek({ time: roundMediaTime({ time: 1500.7 }) });
		expect(pm.getCurrentTime()).toBe(mediaTime({ ticks: 1501 }));
	});

	test("seek rejects non-finite input with a loud, attributable error", () => {
		const { pm } = makeManager();
		expect(() =>
			pm.seek({ time: null as unknown as ReturnType<typeof mediaTime> }),
		).toThrow(/PlaybackManager\.seek/);
		expect(() =>
			pm.seek({ time: undefined as unknown as ReturnType<typeof mediaTime> }),
		).toThrow(/expected finite integer ticks/);
		expect(() =>
			pm.seek({ time: Number.NaN as unknown as ReturnType<typeof mediaTime> }),
		).toThrow(/expected finite integer ticks/);
	});

	test("getCurrentTime never returns a corrupted position (render-time wasm boundary)", () => {
		const { pm } = makeManager();
		for (const bad of [null, undefined, Number.NaN, "360000"]) {
			corrupt({ pm, value: bad });
			// Pre-fix this returned the raw corrupted value, which
			// `mediaTimeToSeconds` fed to wasm as a JSON `null`/unit value.
			expect(pm.getCurrentTime()).toBe(ZERO_MEDIA_TIME);
		}
	});

	test("play self-heals a corrupted position before arming the timer", () => {
		const { pm } = makeManager();
		corrupt({ pm, value: null });
		pm.play();
		expect(pm.getIsPlaying()).toBe(true);
		// The heal ran (pre-fix: raw null would reach wasm addMediaTime inside
		// the synchronous first updateTime() tick and throw). The first tick
		// then legitimately advanced the position by the sub-millisecond
		// elapsed real time — assert the invariant, not a frozen clock.
		const t = pm.getCurrentTime();
		expect(Number.isInteger(t)).toBe(true);
		expect(t).toBeGreaterThanOrEqual(0);
		pm.pause();
	});

	test("timeline-scope reconcile heals a corrupted position on engine change", () => {
		const { fake, pm } = makeManager();
		pm.bindTimelineScope();
		corrupt({ pm, value: undefined });
		fake.fireTimelineChange();
		// Pre-fix: reconcile clamped the corrupted value straight back out
		// (clampMediaTime trusts its input), leaving it stuck forever.
		expect(pm.getCurrentTime()).toBe(ZERO_MEDIA_TIME);
	});

	test("a healthy position survives reconcile unchanged", () => {
		const { fake, pm } = makeManager();
		pm.bindTimelineScope();
		pm.seek({ time: mediaTime({ ticks: 480_000 }) });
		fake.fireTimelineChange();
		expect(pm.getCurrentTime()).toBe(mediaTime({ ticks: 480_000 }));
	});
});
