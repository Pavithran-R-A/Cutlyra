/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures deliberately contain only timing fields needed by the pure export bound contract. */
import { describe, expect, it } from "bun:test";
import type { MediaTime } from "@/wasm";
import type { SceneTracks, TSceneTransition } from "./types";
import { getVideoExportBounds } from "./export-video-end";

const t = (sec: number) => Math.round(sec * 120_000) as MediaTime;
const clip = ({
	id,
	start,
	duration,
	type = "video",
}: {
	id: string;
	start: number;
	duration: number;
	type?: string;
}) => ({
	id, type, startTime: t(start), duration: t(duration),
});

function scene({
	main,
	overlays = [],
	audio = [],
}: {
	main: ReturnType<typeof clip>[];
	overlays?: Array<{ type: string; clips: ReturnType<typeof clip>[] }>;
	audio?: ReturnType<typeof clip>[];
}): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: main } as unknown as SceneTracks["main"],
		overlay: overlays.map((a, n) => ({ id: `overlay-${n}`, name: a.type, type: a.type, hidden: false, elements: a.clips })) as SceneTracks["overlay"],
		audio: audio.length ? [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: audio }] as SceneTracks["audio"] : [],
	};
}
const fade: TSceneTransition = { id: "fade", afterElementId: "a", kind: "fade", duration: t(1.9) };

describe("video export end and discarded authored text (#17)", () => {
	it("uses the compressed 10.1s video end, not 15s nominal text end", () => {
		const tracks = scene({
			main: [clip({ id: "a", start: 0, duration: 6 }), clip({ id: "b", start: 6, duration: 6 })],
			overlays: [{ type: "text", clips: [clip({ id: "title", start: 9, duration: 6, type: "text" })] }],
		});
		const got = getVideoExportBounds({ tracks, transitions: [fade] });
		expect(got.visualEnd).toBe(t(10.1));
		expect(got.nominalEnd).toBe(t(15));
		expect(got.truncatedTextCount).toBe(1);
		expect(got.lastTruncatedTextEnd).toBe(t(13.1));
	});
	it("never extends an 8s video to trailing 15s audio", () => {
		const got = getVideoExportBounds({
			tracks: scene({
				main: [clip({ id: "a", start: 0, duration: 8 })],
				audio: [clip({ id: "song", start: 0, duration: 15, type: "audio" })],
			}),
		});
		expect(got.visualEnd).toBe(t(8));
		expect(got.nominalEnd).toBe(t(15));
		expect(got.truncatedTextCount).toBe(0);
	});
	it("flags captions past the 8s visual end rather than adding a black tail", () => {
		const got = getVideoExportBounds({
			tracks: scene({
				main: [clip({ id: "a", start: 0, duration: 8 })],
				overlays: [{ type: "caption", clips: [clip({ id: "word", start: 7, duration: 8, type: "caption" })] }],
			}),
		});
		expect(got.visualEnd).toBe(t(8));
		expect(got.truncatedTextCount).toBe(1);
		expect(got.lastTruncatedTextEnd).toBe(t(15));
	});
	it("extends video for a real graphic overlay, but not text alone", () => {
		const tracks = scene({
			main: [clip({ id: "a", start: 0, duration: 8 })],
			overlays: [
				{ type: "graphic", clips: [clip({ id: "card", start: 8, duration: 7, type: "graphic" })] },
				{ type: "text", clips: [clip({ id: "label", start: 9, duration: 5, type: "text" })] },
			],
		});
		const got = getVideoExportBounds({ tracks });
		expect(got.visualEnd).toBe(t(15));
		expect(got.truncatedTextCount).toBe(0);
	});
	it("keeps a full no-transition 12s video unchanged", () => {
		const got = getVideoExportBounds({
			tracks: scene({ main: [clip({ id: "a", start: 0, duration: 6 }), clip({ id: "b", start: 6, duration: 6 })] }),
		});
		expect(got.visualEnd).toBe(t(12));
		expect(got.nominalEnd).toBe(t(12));
	});
	it("reports zero visual end for audio-only with empty main track", () => {
		const got = getVideoExportBounds({
			tracks: scene({ main: [], audio: [clip({ id: "song", start: 0, duration: 15, type: "audio" })] }),
		});
		expect(got.visualEnd).toBe(t(0));
		expect(got.nominalEnd).toBe(t(15));
	});
	it("ignores text that ends exactly at the compressed video boundary", () => {
		const tracks = scene({
			main: [clip({ id: "a", start: 0, duration: 6 }), clip({ id: "b", start: 6, duration: 6 })],
			overlays: [{ type: "text", clips: [clip({ id: "title", start: 6, duration: 6, type: "text" })] }],
		});
		// Text's nominal 6s start is remapped back 1.9s, so its end is 10.1.
		const got = getVideoExportBounds({ tracks, transitions: [fade] });
		expect(got.visualEnd).toBe(t(10.1));
		expect(got.truncatedTextCount).toBe(0);
	});
});
