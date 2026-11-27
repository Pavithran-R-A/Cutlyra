import { useState } from "react";
import { Check } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { CcSlider } from "../slider";
import { SegmentedControl } from "../segmented-control";
import { formatClipDuration } from "./timeline-clip";

import {
	normalizeTransitionDirection,
	normalizeTransitionKind,
	TRANSITION_DEFINITIONS,
	TRANSITION_DIRECTIONS,
	type TransitionDirection,
} from "@cutlyra/editor-core/timeline";

/**
 * Only kinds BOTH renderers implement are offered (Phase 3). Each entry comes
 * from the shared definition layer, so a kind cannot appear here before the
 * preview and the Android exporter agree on it. Wipe/dip/blur are absent on
 * purpose: they need an animated mask/wipe pass and a full-frame colour
 * layer respectively — offering them would mean a preview-only control.
 */
const TRANSITION_KINDS: Array<{ id: string; label: string }> = [
	{ id: "none", label: "None" },
	...Object.values(TRANSITION_DEFINITIONS).map((definition) => ({
		id: definition.kind,
		label: definition.label,
	})),
];

const DIRECTION_LABELS: Record<TransitionDirection, string> = {
	left: "Left",
	right: "Right",
	up: "Up",
	down: "Down",
};

/**
 * The transition picker sheet (plan M7 item 6). Duration slider is bounded
 * by `maxDurationSec` (available trim room on both neighbors — computed by
 * the caller, timeline-view.tsx, from the two adjacent clips' durations,
 * per corpus 05 §5 direct quote: "very short clips can limit how much
 * duration is available"). "Apply to all" is scoped to the main track only
 * (corpus 05 §5's own caveat: "cuts on separate tracks and overlay clips
 * may not change").
 *
 * Round 17: this sheet is now REAL — the shell commits confirms into the
 * engine's `TScene.transitions` (undoable TransitionsSnapshotCommand),
 * which drives BOTH the preview (timeline/transitions.ts placement +
 * cross-fade) and the native export (buildEdl -> MainTrackPlacement.swift).
 * "None" removes the transition. Android v0.1.0 exposes only Fade because
 * that is the transition semantic the preview and native exporter both
 * actually honor. Slide/Zoom remain representable in the engine for project
 * compatibility, but are not offered until their native render paths exist.
 */
export function TransitionSheet({
	afterClipId,
	initialKind,
	initialDirection,
	initialDurationSec,
	maxDurationSec,
	onConfirm,
	onClose,
}: {
	afterClipId: string;
	initialKind?: string;
	initialDirection?: string;
	initialDurationSec: number;
	maxDurationSec: number;
	onConfirm: (params: {
		afterClipId: string;
		kind: string;
		direction: TransitionDirection;
		durationSec: number;
		applyToAll: boolean;
	}) => void;
	onClose: () => void;
}) {
	const [kind, setKind] = useState(
		initialKind && TRANSITION_KINDS.some((k) => k.id === initialKind)
			? initialKind
			: TRANSITION_KINDS[0].id,
	);
	const [direction, setDirection] = useState<TransitionDirection>(() =>
		normalizeTransitionDirection({
			kind: normalizeTransitionKind(initialKind),
			raw: initialDirection,
		}),
	);
	const supportsDirection =
		kind !== "none" &&
		TRANSITION_DEFINITIONS[normalizeTransitionKind(kind)].supportsDirection;
	const [durationSec, setDurationSec] = useState(
		Math.min(initialDurationSec, maxDurationSec),
	);
	const [applyToAll, setApplyToAll] = useState(false);

	return (
		<PanelSheet onScrimClick={onClose}>
			<div className="cc-sheet-header-group">
				<div className="cc-sheet-header">
					<span style={{ flex: 1, fontSize: "var(--cc-text-title)" }}>
						Transition
					</span>
					<button
						type="button"
						className="cc-sheet-header__icon-btn"
						aria-label="Confirm transition"
						onClick={() =>
							onConfirm({ afterClipId, kind, direction, durationSec, applyToAll })
						}
					>
						<Check size={22} strokeWidth={CC_ICON_STROKE} />
					</button>
				</div>
			</div>
			<div style={{ display: "flex", gap: "var(--cc-space-3)", padding: "0 var(--cc-space-4)" }}>
				<SegmentedControl
					segments={TRANSITION_KINDS}
					activeId={kind}
					onSelect={setKind}
					aria-label="Transition style"
				/>
			</div>
			{supportsDirection && (
				<div style={{ display: "flex", gap: "var(--cc-space-3)", padding: "var(--cc-space-3) var(--cc-space-4) 0" }}>
					<SegmentedControl
						segments={TRANSITION_DIRECTIONS.map((id) => ({
							id,
							label: DIRECTION_LABELS[id],
						}))}
						activeId={direction}
						onSelect={(id) =>
							setDirection(
								normalizeTransitionDirection({ kind: normalizeTransitionKind(kind), raw: id }),
							)
						}
						aria-label="Transition direction"
					/>
				</div>
			)}
			<div style={{ padding: "var(--cc-space-4)", display: "flex", flexDirection: "column", gap: "var(--cc-space-2)" }}>
				<span style={{ fontSize: "var(--cc-text-label)", color: "var(--cc-text-secondary)" }}>
					Duration — {formatClipDuration({ durationSec })}
				</span>
				<CcSlider
					value={durationSec}
					min={0.1}
					max={Math.max(0.1, maxDurationSec)}
					step={0.1}
					onChange={setDurationSec}
					aria-label="Transition duration"
				/>
			</div>
			<div style={{ padding: "0 var(--cc-space-4) var(--cc-space-4)" }}>
				<SegmentedControl
					segments={[
						{ id: "this", label: "This transition" },
						{ id: "all", label: "Apply to all" },
					]}
					activeId={applyToAll ? "all" : "this"}
					onSelect={(id) => setApplyToAll(id === "all")}
					aria-label="Apply scope"
				/>
			</div>
		</PanelSheet>
	);
}
