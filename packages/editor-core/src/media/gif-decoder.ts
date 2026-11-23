/**
 * Bundled offline GIF decoder fallback.
 *
 * Pure TypeScript, no DOM/canvas/decoder dependencies, so it runs under
 * `bun test`. Used when the host does not expose WebCodecs `ImageDecoder`
 * with GIF support (see `supportsImageDecoder` in ./gif.ts).
 *
 * Output frames are RGBA buffers sized to the GIF's logical screen, with
 * disposal methods applied between frames so seeking/repeated playback works.
 */

export interface GifDecoderFrame {
	/** RGBA pixel data for this frame's logical screen (width*height*4). */
	rgba: Uint8ClampedArray;
	/** Frame delay in ms (normalized via normalizeGifFrameDelay). */
	delayMs: number;
	/** Cumulative start time of this frame within one loop, in ms. */
	startMs: number;
	/** Image descriptor left/top within logical screen. */
	left: number;
	top: number;
	width: number;
	height: number;
	/** Disposal method: 0 none, 1 leave, 2 restore bg, 3 restore previous. */
	disposal: number;
	transparentIndex: number | null;
}

export interface GifDecodeResult {
	width: number;
	height: number;
	loopCount: number; // 0 = infinite (Netscape loop count 0)
	frames: GifDecoderFrame[];
	totalDurationMs: number;
}

const DEFAULT_DELAY_MS = 100;

function readU16(buf: Uint8Array, off: number): number {
	return buf[off] | (buf[off + 1] << 8);
}

function normalizeDelay(cs: number): number {
	// centiseconds -> ms
	const ms = cs * 10;
	if (ms <= 10) return 100; // browsers treat 0/1 as 100ms
	if (ms < 20) return 20;
	return Math.round(ms);
}

// LZW decode for a GIF image data stream.
function lzwDecode(
	data: Uint8Array,
	minCodeSize: number,
	expectedPixels: number,
): Uint8Array {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	let codeSize = minCodeSize + 1;
	let nextCode = endCode + 1;
	const maxCode = 1 << 12;

	// code table
	const table: number[][] = [];
	for (let i = 0; i < clearCode; i++) table[i] = [i];
	table[clearCode] = [];
	table[endCode] = [];

	const output = new Uint8Array(expectedPixels);
	let outIdx = 0;

	// bit reader
	let bitPos = 0;
	function readCode(): number {
		let code = 0;
		for (let i = 0; i < codeSize; i++) {
			const byteIndex = (bitPos + i) >> 3;
			const bitIndex = (bitPos + i) & 7;
			if (byteIndex < data.length) {
				if (data[byteIndex] & (1 << bitIndex)) code |= 1 << i;
			}
		}
		bitPos += codeSize;
		return code;
	}

	let prevCode = -1;
	while (outIdx < expectedPixels) {
		const code = readCode();
		if (code === clearCode) {
			// reset
			table.length = endCode + 1;
			for (let i = table.length; i < clearCode; i++) {} // noop
			// rebuild base
			// (table already has 0..clearCode-1, clear, end)
			codeSize = minCodeSize + 1;
			nextCode = endCode + 1;
			prevCode = -1;
			continue;
		}
		if (code === endCode) break;

		let entry: number[];
		if (code < table.length && table[code]) {
			entry = table[code];
		} else if (code === nextCode && prevCode >= 0 && table[prevCode]) {
			entry = table[prevCode].concat([table[prevCode][0]]);
		} else {
			// malformed
			break;
		}

		for (let i = 0; i < entry.length && outIdx < expectedPixels; i++) {
			output[outIdx++] = entry[i];
		}

		if (prevCode >= 0 && prevCode !== clearCode && table[prevCode]) {
			if (nextCode < maxCode) {
				table[nextCode] = table[prevCode].concat([entry[0]]);
				nextCode++;
				if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
			}
		}
		prevCode = code;
	}
	return output;
}

function parseSubBlocks(buf: Uint8Array, start: number): { data: Uint8Array; end: number } {
	const chunks: number[] = [];
	let i = start;
	while (i < buf.length && buf[i] !== 0) {
		const size = buf[i];
		i++;
		for (let j = 0; j < size && i + j < buf.length; j++) {
			chunks.push(buf[i + j]);
		}
		i += size;
	}
	// skip terminator
	if (i < buf.length && buf[i] === 0) i++;
	return { data: new Uint8Array(chunks), end: i };
}

export function decodeGif(buffer: ArrayBuffer): GifDecodeResult {
	const buf = new Uint8Array(buffer);
	// Header
	const sig = String.fromCharCode(buf[0], buf[1], buf[2]);
	if (sig !== "GIF") throw new Error("Not a GIF");
	const ver = String.fromCharCode(buf[3], buf[4], buf[5]);
	if (ver !== "87a" && ver !== "89a") throw new Error("Unsupported GIF version");

	let pos = 6;
	const width = readU16(buf, pos); pos += 2;
	const height = readU16(buf, pos); pos += 2;
	const packed = buf[pos]; pos += 1;
	const bgIndex = buf[pos]; pos += 1;
	const aspect = buf[pos]; pos += 1;

	const hasGct = (packed & 0x80) !== 0;
	const gctSize = hasGct ? 1 << ((packed & 0x07) + 1) : 0;
	let gct: Uint8Array[] | null = null;
	if (hasGct) {
		gct = [];
		for (let i = 0; i < gctSize; i++) {
			gct.push(new Uint8Array([buf[pos], buf[pos + 1], buf[pos + 2]]));
			pos += 3;
		}
	}

	let loopCount = 0;
	let loopSpecified = false;

	// frames accumulator
	interface RawFrame {
		left: number; top: number; w: number; h: number;
		hasLct: boolean; lctSize: number;
		lct: Uint8Array[] | null;
		interlace: boolean;
		minCodeSize: number;
		imageData: Uint8Array;
		delayCs: number;
		disposal: number;
		transparentIndex: number | null;
		hasTransparent: boolean;
	}
	const rawFrames: RawFrame[] = [];

	// current graphic control state
	let delayCs = 0;
	let disposal = 0;
	let transparentIndex: number | null = null;
	let hasTransparent = false;

	while (pos < buf.length) {
		const block = buf[pos];
		if (block === 0x3b) break; // trailer
		if (block === 0x21) {
			// extension
			const label = buf[pos + 1];
			if (label === 0xf9) {
				// graphic control extension
				pos += 2;
				pos += 1; // block size (0x04)
				const gcePacked = buf[pos]; pos += 1;
				delayCs = readU16(buf, pos); pos += 2;
				transparentIndex = buf[pos]; pos += 1;
				hasTransparent = (gcePacked & 0x01) !== 0;
				disposal = (gcePacked >> 2) & 0x07;
				pos += 1; // terminator
			} else if (label === 0xff) {
				// application extension
				pos += 2;
				const blockSize = buf[pos]; pos += 1;
				let app = "";
				for (let i = 0; i < blockSize; i++) app += String.fromCharCode(buf[pos + i]);
				pos += blockSize;
				const sub = parseSubBlocks(buf, pos);
				if (app.startsWith("NETSCAPE")) {
					// loop count in sub-block: 0x01, 0x00, lo, hi
					if (sub.data.length >= 3 && sub.data[0] === 0x01) {
						loopCount = sub.data[1] | (sub.data[2] << 8);
						loopSpecified = true;
					}
				}
				pos = sub.end;
			} else {
				// other extension (comment, plain text): skip
				pos += 2;
				const sub = parseSubBlocks(buf, pos);
				pos = sub.end;
			}
			// reset gce after consumption? keep until image
		} else if (block === 0x2c) {
			// image descriptor
			pos += 1;
			const left = readU16(buf, pos); pos += 2;
			const top = readU16(buf, pos); pos += 2;
			const w = readU16(buf, pos); pos += 2;
			const h = readU16(buf, pos); pos += 2;
			const imgPacked = buf[pos]; pos += 1;
			const hasLct = (imgPacked & 0x80) !== 0;
			const interlace = (imgPacked & 0x40) !== 0;
			const lctSize = hasLct ? 1 << ((imgPacked & 0x07) + 1) : 0;
			let lct: Uint8Array[] | null = null;
			if (hasLct) {
				lct = [];
				for (let i = 0; i < lctSize; i++) {
					lct.push(new Uint8Array([buf[pos], buf[pos + 1], buf[pos + 2]]));
					pos += 3;
				}
			}
			const minCodeSize = buf[pos]; pos += 1;
			const sub = parseSubBlocks(buf, pos);
			pos = sub.end;

			rawFrames.push({
				left, top, w, h,
				hasLct, lctSize, lct, interlace,
				minCodeSize, imageData: sub.data,
				delayCs, disposal,
				transparentIndex: hasTransparent ? transparentIndex : null,
				hasTransparent,
			});

			// reset gce state
			delayCs = 0;
			disposal = 0;
			transparentIndex = null;
			hasTransparent = false;
		} else {
			// unknown, advance
			pos++;
		}
	}

	if (!loopSpecified) loopCount = 0;

	// Decode each frame into RGBA logical screen, applying disposal.
	const screen = new Uint8ClampedArray(width * height * 4);
	// fill bg
	// find bg color
	let bgR = 0, bgG = 0, bgB = 0;
	if (gct && bgIndex < gct.length) {
		bgR = gct[bgIndex][0]; bgG = gct[bgIndex][1]; bgB = gct[bgIndex][2];
	}
	function fillBg(target: Uint8ClampedArray) {
		for (let i = 0; i < width * height; i++) {
			target[i * 4] = bgR;
			target[i * 4 + 1] = bgG;
			target[i * 4 + 2] = bgB;
			target[i * 4 + 3] = 255;
		}
	}
	fillBg(screen);

	const frames: GifDecoderFrame[] = [];
	let cursor = 0;
	// previous screen for disposal 3
	let prevScreen: Uint8ClampedArray | null = null;

	for (const rf of rawFrames) {
		// save previous if disposal 3 needed later (save before drawing)
		const needPrev = rf.disposal === 3;
		const savedPrev = needPrev ? new Uint8ClampedArray(screen) : null;

		const colorTable = rf.lct || gct;
		const pixels = lzwDecode(rf.imageData, rf.minCodeSize, rf.w * rf.h);

		// de-interlace if needed (GIF interlace: rows in passes)
		let ordered = pixels;
		if (rf.interlace) {
			ordered = new Uint8Array(rf.w * rf.h);
			const passes = [
				{ start: 0, step: 8 },
				{ start: 4, step: 8 },
				{ start: 2, step: 4 },
				{ start: 1, step: 2 },
			];
			let srcRow = 0;
			for (const p of passes) {
				for (let y = p.start; y < rf.h; y += p.step) {
					for (let x = 0; x < rf.w; x++) {
						ordered[y * rf.w + x] = pixels[srcRow * rf.w + x];
					}
					srcRow++;
				}
			}
		}

		// draw frame onto screen
		for (let y = 0; y < rf.h; y++) {
			for (let x = 0; x < rf.w; x++) {
				const idx = ordered[y * rf.w + x];
				const sx = rf.left + x;
				const sy = rf.top + y;
				if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
				if (rf.hasTransparent && rf.transparentIndex !== null && idx === rf.transparentIndex) {
					const o = (sy * width + sx) * 4;
					screen[o] = 0; screen[o + 1] = 0; screen[o + 2] = 0; screen[o + 3] = 0;
					continue;
				}
				const color = colorTable && idx < colorTable.length ? colorTable[idx] : [0, 0, 0];
				const o = (sy * width + sx) * 4;
				screen[o] = color[0];
				screen[o + 1] = color[1];
				screen[o + 2] = color[2];
				screen[o + 3] = 255;
			}
		}

		const delayMs = normalizeDelay(rf.delayCs);
		const frameCopy = new Uint8ClampedArray(screen);
		frames.push({
			rgba: frameCopy,
			delayMs,
			startMs: cursor,
			left: rf.left, top: rf.top, width: rf.w, height: rf.h,
			disposal: rf.disposal,
			transparentIndex: rf.transparentIndex,
		});
		cursor += delayMs;

		// apply disposal for next frame
		if (rf.disposal === 2) {
			// restore bg in region
			for (let y = 0; y < rf.h; y++) {
				for (let x = 0; x < rf.w; x++) {
					const sx = rf.left + x;
					const sy = rf.top + y;
					if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
					const o = (sy * width + sx) * 4;
					screen[o] = bgR; screen[o + 1] = bgG; screen[o + 2] = bgB; screen[o + 3] = 255;
				}
			}
		} else if (rf.disposal === 3 && savedPrev) {
			screen.set(savedPrev);
		}
		// disposal 0/1: leave
		void prevScreen;
		prevScreen = null;
	}

	const totalDurationMs = cursor;
	// normalize delays via the shared helper? Already normalized.

	return { width, height, loopCount, frames, totalDurationMs };
}

export function getGifDecoderFrameIndexAtTime(
	timeMs: number,
	frames: GifDecoderFrame[],
): number {
	if (frames.length === 0) return 0;
	const total = frames.reduce((a, f) => a + f.delayMs, 0);
	if (total <= 0) return 0;
	let t = ((timeMs % total) + total) % total;
	for (let i = 0; i < frames.length; i++) {
		if (t < frames[i].delayMs) return i;
		t -= frames[i].delayMs;
	}
	return frames.length - 1;
}
