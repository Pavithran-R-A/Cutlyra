import type { Bookmark, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";
import type { SerializedScene } from "./types";

/**
 * Keep persisted scenes structurally aligned with TScene. Explicitly
 * rebuilding only a hand-picked list of fields silently dropped transitions
 * on every save (POCO Stage 17, 2026-10-08). Spread the scene first, then
 * transform only the fields that need a wire representation.
 */
export function serializeScene({ scene }: { scene: TScene }): SerializedScene {
	return {
		...scene,
		tracks: {
			...scene.tracks,
			audio: scene.tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		},
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	};
}

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

/**
 * Legacy records lack optional transitions; preserve that representation.
 * The editor interprets undefined exactly as no transitions, and any
 * transitions saved by newer clients survive unchanged across reloads.
 */
export function deserializeScene({ scene }: { scene: SerializedScene }): TScene {
	return {
		...scene,
		bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
		createdAt: new Date(scene.createdAt),
		updatedAt: new Date(scene.updatedAt),
	};
}
