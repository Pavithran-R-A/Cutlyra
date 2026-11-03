/**
 * One filmstrip frame slot. When the clip carries a real frame URI
 * (`clip.thumbnails` — GitHub #54's native strip, resolved by the
 * renderer via `nearestThumbnailUri` so every zoom level maps to the
 * closest generated frame rather than an exact float key) it renders as a
 * real `<img>`; otherwise — synthetic harness clips, a strip still
 * generating, or a strip that failed — this draws a deterministic
 * placeholder swatch (a hue-shifted gradient keyed on the clip's own
 * `colorHue` + the slot's time) so the filmstrip still reads as "many
 * distinct frames" for layout/virtualization/interaction testing WITHOUT
 * pretending to be real video content.
 *
 * The `<img>` also carries the honest-failure path the issue asks for: if
 * a persisted frame's file is gone or corrupt (restored backup, pruned
 * custody), its `onError` swaps THAT slot back to the placeholder instead
 * of leaving a transparent hole — and a later strip upgrade (new URI from
 * regeneration) naturally retries, since the failed URI no longer matches.
 */
import { useState } from "react";

export function FilmstripThumbnail({
	widthPx,
	realUri,
	colorHue,
	slotSec,
}: {
	widthPx: number;
	realUri?: string;
	colorHue: number;
	slotSec: number;
}) {
	const [failedUri, setFailedUri] = useState<string | null>(null);

	if (realUri && realUri !== failedUri) {
		return (
			<div className="cc-timeline__clip-thumbnail" style={{ width: widthPx }}>
				<img
					className="cc-timeline__clip-thumbnail-img"
					src={realUri}
					alt=""
					aria-hidden="true"
					onError={() => setFailedUri(realUri)}
				/>
			</div>
		);
	}

	const hue = (colorHue + slotSec * 11) % 360;
	return (
		<div
			className="cc-timeline__clip-thumbnail"
			style={{
				width: widthPx,
				background: `linear-gradient(180deg, hsl(${hue} 35% 32%) 0%, hsl(${hue} 30% 20%) 100%)`,
			}}
			aria-hidden="true"
		/>
	);
}