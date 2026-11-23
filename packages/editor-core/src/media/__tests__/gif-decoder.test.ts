import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, test } from "bun:test";
import { decodeGif, getGifDecoderFrameIndexAtTime } from "../gif-decoder";

function load(name: string): ArrayBuffer {
	const p = resolve(__dirname, "fixtures", name);
	const buf = readFileSync(p);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("gif-decoder", () => {
	test("decodes animated gif frame count and dimensions", () => {
		const r = decodeGif(load("anim.gif"));
		expect(r.width).toBe(8);
		expect(r.height).toBe(8);
		expect(r.frames.length).toBe(4);
		expect(r.loopCount).toBe(0);
	});

	test("variable frame durations preserved", () => {
		const r = decodeGif(load("anim.gif"));
		expect(r.frames.map((f) => f.delayMs)).toEqual([100, 200, 50, 150]);
	});

	test("cumulative start times", () => {
		const r = decodeGif(load("anim.gif"));
		expect(r.frames[0].startMs).toBe(0);
		expect(r.frames[1].startMs).toBe(100);
		expect(r.frames[2].startMs).toBe(300);
		expect(r.frames[3].startMs).toBe(350);
		expect(r.totalDurationMs).toBe(500);
	});

	test("seeking selects correct frame", () => {
		const r = decodeGif(load("anim.gif"));
		expect(getGifDecoderFrameIndexAtTime(0, r.frames)).toBe(0);
		expect(getGifDecoderFrameIndexAtTime(100, r.frames)).toBe(1);
		expect(getGifDecoderFrameIndexAtTime(300, r.frames)).toBe(2);
		expect(getGifDecoderFrameIndexAtTime(499, r.frames)).toBe(3);
		expect(getGifDecoderFrameIndexAtTime(500, r.frames)).toBe(0); // loop
	});

	test("loop boundaries stable", () => {
		const r = decodeGif(load("anim.gif"));
		const a = getGifDecoderFrameIndexAtTime(0, r.frames);
		const b = getGifDecoderFrameIndexAtTime(500, r.frames);
		expect(a).toBe(b);
	});

	test("visual output changes over time (pixel diff)", () => {
		const r = decodeGif(load("anim.gif"));
		// frame 0 and frame 1 should differ
		let diff = 0;
		for (let i = 0; i < r.frames[0].rgba.length; i++) {
			if (r.frames[0].rgba[i] !== r.frames[1].rgba[i]) diff++;
		}
		expect(diff).toBeGreaterThan(0);
	});

	test("transparent gif has transparent pixels", () => {
		const r = decodeGif(load("transparent.gif"));
		expect(r.frames.length).toBe(1);
		// some pixels should be fully transparent (alpha 0)
		let transparent = 0;
		for (let i = 0; i < r.frames[0].rgba.length; i += 4) {
			if (r.frames[0].rgba[i + 3] === 0) transparent++;
		}
		expect(transparent).toBeGreaterThan(0);
	});

	test("malformed input throws", () => {
		expect(() => decodeGif(new ArrayBuffer(10))).toThrow();
	});

	test("empty frame list handling", () => {
		expect(getGifDecoderFrameIndexAtTime(5, [])).toBe(0);
	});
});
