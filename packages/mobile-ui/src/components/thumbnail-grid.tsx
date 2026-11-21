import { useState } from "react";
import { ArrowDown } from "lucide-react";
import { CC_ICON_STROKE } from "../tokens";
import { cn } from "../lib/cn";

export interface ThumbnailDef {
	id: string;
	label?: string;
	imageSrc?: string;
	/** Not yet cached locally — corpus 06 §4/04 §3.6: grid tiles in
	 *  ip_7.jpg carry a download-arrow badge for un-downloaded effects. */
	needsDownload?: boolean;
	/** Corpus 04 §3.3/3.6: gem/diamond badge marks Pro-gated presets.
	 *  Cutlyra has no paid tier — this prop exists so the visual language
	 *  can be reused for "bundled" vs "not-yet-bundled" or simply omitted
	 *  by a consumer that doesn't need a monetization badge at all. */
	badge?: "pro" | null;
}

interface ThumbnailGridProps {
	items: ThumbnailDef[];
	selectedId?: string | null;
	onSelect?: (id: string) => void;
	columns?: number;
	className?: string;
}

/**
 * One tile. Kept as its own component because a failed image is per-tile
 * state: the sticker/effect registry promises a preview URL, and if that URL
 * cannot be fetched the old markup painted an empty tile — indistinguishable
 * from "this category has nothing in it", which is exactly how a whole
 * library reads as broken. A failed tile now names itself instead.
 */
function Thumbnail({
	item,
	selected,
	onSelect,
}: {
	item: ThumbnailDef;
	selected: boolean;
	onSelect?: (id: string) => void;
}) {
	// Remember WHICH src failed rather than a boolean: a new url is then a new
	// key, so the tile recovers without resetting state from an effect (which
	// would be a cascading render on every prop change).
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const failed = failedSrc !== null && failedSrc === item.imageSrc;

	return (
		<button
			type="button"
			className={cn("cc-thumb", selected && "cc-thumb--selected")}
			onClick={() => onSelect?.(item.id)}
			aria-pressed={selected}
		>
			{/* Plain <img>, deliberately: this package has no Next.js
			    dependency (it also ships to the plain-Vite apps/mobile
			    shell), so next/image is not available here. */}
			{item.imageSrc && !failed && (
				<img src={item.imageSrc} alt="" onError={() => setFailedSrc(item.imageSrc ?? null)} />
			)}
			{failed && (
				<span
					style={{
						display: "block",
						fontSize: 11,
						lineHeight: 1.2,
						opacity: 0.72,
						padding: "4px 6px",
						textAlign: "center",
						wordBreak: "break-word",
					}}
				>
					{item.label ?? "Preview unavailable"}
				</span>
			)}
			{item.needsDownload && (
				<span className="cc-thumb__badge cc-thumb__badge--download" aria-hidden="true">
					<ArrowDown size={11} strokeWidth={CC_ICON_STROKE} />
				</span>
			)}
			{item.badge === "pro" && (
				<span className="cc-thumb__badge cc-thumb__badge--pro" aria-label="Premium">
					◆
				</span>
			)}
			{item.label && <span className="cc-thumb__label">{item.label}</span>}
		</button>
	);
}

/**
 * Matches iphone_shots/ip_7.jpg (Effects) and ip_1.jpg (Caption styles)
 * exactly: 4-column grid, generously-rounded tiles, top-left download-arrow
 * badge, top-right Pro-gem badge, selected tile gets a light outline ring
 * (same convention corpus 04 §2.1 documents for selected timeline clips —
 * "Clip selection state: white border per CapCut" — reused here for visual
 * consistency across the kit).
 */
export function ThumbnailGrid({
	items,
	selectedId,
	onSelect,
	columns = 4,
	className,
}: ThumbnailGridProps) {
	return (
		<div
			className={cn("cc-thumbgrid", className)}
			style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
		>
			{items.map((item) => (
				<Thumbnail
					key={item.id}
					item={item}
					selected={item.id === selectedId}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}
