import { describe, expect, it } from "bun:test";

import {
	buildGifFrameTimeline,
	getGifFrameIndexAtTime,
	gifDecodeStrategy,
	isGifFileName,
	isGifMimeType,
	normalizeGifFrameDelay,
	supportsImageDecoder,
} from "@/media/gif";

describe("normalizeGifFrameDelay", () => {
	it("uses default for 0", () => {
		expect(normalizeGifFrameDelay(0)).toBe(100);
	});
	it("uses default for invalid", () => {
		expect(normalizeGifFrameDelay(NaN)).toBe(100);
		expect(normalizeGifFrameDelay(-5)).toBe(100);
	});
	it("clamps tiny delays up", () => {
		expect(normalizeGifFrameDelay(5)).toBe(100); // <=10 -> default
		expect(normalizeGifFrameDelay(15)).toBe(20); // <20 -> 20
	});
	it("keeps valid delays", () => {
		expect(normalizeGifFrameDelay(100)).toBe(100);
		expect(normalizeGifFrameDelay(33.3)).toBe(33);
	});
});

describe("buildGifFrameTimeline", () => {
	it("empty input", () => {
		const r = buildGifFrameTimeline([]);
		expect(r.frames.length).toBe(0);
		expect(r.totalDurationMs).toBe(0);
	});
	it("single frame", () => {
		const r = buildGifFrameTimeline([50]);
		expect(r.frames.length).toBe(1);
		expect(r.frames[0].startMs).toBe(0);
		expect(r.frames[0].delayMs).toBe(50);
		expect(r.totalDurationMs).toBe(50);
	});
	it("multiple frames with zero delay normalized", () => {
		const r = buildGifFrameTimeline([0, 100, 50]);
		expect(r.frames[0].delayMs).toBe(100);
		expect(r.frames[1].startMs).toBe(100);
		expect(r.frames[2].startMs).toBe(200);
		expect(r.totalDurationMs).toBe(250);
	});
	it("variable durations", () => {
		const r = buildGifFrameTimeline([20, 80]);
		expect(r.totalDurationMs).toBe(100);
	});
});

describe("getGifFrameIndexAtTime", () => {
	it("empty -> 0", () => {
		expect(getGifFrameIndexAtTime(0, [])).toBe(0);
	});
	it("selects correct frame", () => {
		const d = [100, 100, 100];
		expect(getGifFrameIndexAtTime(0, d)).toBe(0);
		expect(getGifFrameIndexAtTime(50, d)).toBe(0);
		expect(getGifFrameIndexAtTime(100, d)).toBe(1);
		expect(getGifFrameIndexAtTime(250, d)).toBe(2);
	});
	it("loops", () => {
		const d = [100, 100];
		expect(getGifFrameIndexAtTime(250, d)).toBe(0); // 250%200=50 -> frame0
	});
	it("handles zero/invalid delays", () => {
		const d = [0, 100];
		expect(getGifFrameIndexAtTime(0, d)).toBe(0);
		expect(getGifFrameIndexAtTime(150, d)).toBe(1);
	});
});

describe("capability detection", () => {
	it("returns boolean", () => {
		expect(typeof supportsImageDecoder()).toBe("boolean");
	});
	it("strategy matches", () => {
		const s = gifDecodeStrategy();
		expect(s === "image-decoder" || s === "fallback").toBe(true);
	});
});

describe("file/mime helpers", () => {
	it("isGifFileName", () => {
		expect(isGifFileName("a.gif")).toBe(true);
		expect(isGifFileName("a.GIF")).toBe(true);
		expect(isGifFileName("a.png")).toBe(false);
	});
	it("isGifMimeType", () => {
		expect(isGifMimeType("image/gif")).toBe(true);
		expect(isGifMimeType("image/GIF")).toBe(true);
		expect(isGifMimeType("image/png")).toBe(false);
	});
});