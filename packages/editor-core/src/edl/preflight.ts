/**
 * GitHub #55 / Linear PAV-148 — pre-flight media-reference check.
 *
 * The field report was an export refusal on a real device:
 *
 *     clip 71a7d579-a4ed-4bbd-98aa-7023b28c0925 has no assetId
 *
 * That message comes from the Android exporter
 * (`EdlToComposition.requireAsset()`), which needs a resolved asset for every
 * video/image/audio clip. By the time the exporter sees the document the only
 * surviving identifier is the clip UUID, so the user is told nothing they can
 * act on. Worse, the export sheet used to send the EDL straight to native
 * without validating it first (`validateEdl()` existed but had no production
 * caller), so the refusal arrived as a native error text mid-export.
 *
 * This module is the missing pre-flight. It answers exactly one question —
 * "does every media-backed clip in this document still point at a usable
 * asset?" — and produces a message that names the clips. It deliberately does
 * NOT run the full `validateEdl({ strict: true })`: a schema warning must
 * never newly block an export that used to work, only a lost media reference
 * does, because only that one is guaranteed to fail in the exporter.
 *
 * Generated content (text, caption, sticker, graphic) intentionally carries
 * `assetId: null` — the EDL contract says so — and is never flagged.
 */

import type { Edl, EdlAsset, EdlClip } from "./types";

export type UnresolvedMediaReason =
	| "missing-asset-id"
	| "unknown-asset"
	| "missing-source-uri";

export interface UnresolvedMediaClip {
	trackId: string;
	clipId: string;
	name: string;
	kind: EdlClip["kind"];
	reason: UnresolvedMediaReason;
}

const MEDIA_KINDS: ReadonlySet<EdlClip["kind"]> = new Set([
	"video",
	"image",
	"audio",
]);

/** Every media clip whose asset reference cannot be resolved to a source URI. */
export function findUnresolvedMediaClips({ edl }: { edl: Edl }): UnresolvedMediaClip[] {
	const assetsById = new Map<string, EdlAsset>(
		edl.assets.map((asset) => [asset.assetId, asset]),
	);
	const unresolved: UnresolvedMediaClip[] = [];

	for (const track of edl.tracks) {
		for (const clip of track.clips) {
			if (!MEDIA_KINDS.has(clip.kind)) continue;
			const asset = clip.assetId ? assetsById.get(clip.assetId) : undefined;
			const reason: UnresolvedMediaReason | null = !clip.assetId
				? "missing-asset-id"
				: !asset
					? "unknown-asset"
					: !asset.sourceUri
						? "missing-source-uri"
						: null;
			if (!reason) continue;
			unresolved.push({
				trackId: track.trackId,
				clipId: clip.clipId,
				name: clip.name,
				kind: clip.kind,
				reason,
			});
		}
	}

	return unresolved;
}

function describeOne({ clip }: { clip: UnresolvedMediaClip }): string {
	const what =
		clip.reason === "missing-asset-id"
			? "lost its media reference"
			: clip.reason === "unknown-asset"
				? "points at media that is no longer in this project"
				: "points at media whose file is no longer available";
	return `“${clip.name}” (${clip.kind}) ${what}`;
}

/**
 * A message a user can act on: which clips are broken, how many, and the two
 * repairs that exist in v0.1 (there is no relink flow yet — re-importing the
 * file and replacing the clip is the documented recovery).
 */
export function describeUnresolvedMediaClips({
	clips,
}: {
	clips: UnresolvedMediaClip[];
}): string {
	if (clips.length === 0) return "";
	const listed = clips.slice(0, 3).map((clip) => describeOne({ clip }));
	const rest = clips.length - listed.length;
	const sentences = [
		clips.length === 1
			? `Can't export: clip ${listed[0]}`
			: `Can't export: ${clips.length} clips have lost their media: ${listed.join("; ")}${
					rest > 0 ? ` and ${rest} more` : ""
				}`,
		"Re-import the file and replace the clip, or delete the clip, then export again.",
	];
	return sentences.join(". ");
}

/**
 * Throws a user-facing `Error` when any media clip lost its reference.
 * Call before handing an EDL to a native exporter.
 */
export function assertMediaReferencesResolved({ edl }: { edl: Edl }): void {
	const clips = findUnresolvedMediaClips({ edl });
	if (clips.length === 0) return;
	throw new Error(describeUnresolvedMediaClips({ clips }));
}
