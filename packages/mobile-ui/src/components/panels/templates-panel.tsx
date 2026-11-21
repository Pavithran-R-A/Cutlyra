import { useMemo, useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import {
	TEMPLATE_CATEGORIES,
	isTemplateCategory,
	templatesForCategory,
	type Template,
	type TemplateCategory,
	type TemplateTextOverrides,
} from "@cutlyra/editor-core/templates";

interface TemplatesPanelProps {
	onClose: () => void;
	/** Runs the real apply path (create project → import media → insert
	 *  clips/text/graphics). Rejects with a user-readable message. */
	onApply: (args: { template: Template; text: TemplateTextOverrides }) => Promise<void>;
}

const CATEGORY_CHIPS = [
	{ id: "all", label: "All" },
	...Object.keys(TEMPLATE_CATEGORIES)
		.filter(isTemplateCategory)
		.map((id) => ({ id, label: TEMPLATE_CATEGORIES[id] })),
];

function formatAspect({ template }: { template: Template }): string {
	const { width, height } = template.canvas;
	const divisor = ({ a, b }: { a: number; b: number }): number =>
		b === 0 ? a : divisor({ a: b, b: a % b });
	const greatest = divisor({ a: width, b: height });
	return `${width / greatest}:${height / greatest}`;
}

function formatSeconds({ value }: { value: number }): string {
	return Number.isInteger(value) ? `${value}s` : `${value.toFixed(1)}s`;
}

/**
 * Templates panel — replaces the "Templates aren't in Cutlyra yet" sheet.
 *
 * The library is data (`@cutlyra/editor-core/templates`): this component only
 * filters descriptors, edits their text slots and hands the result to the
 * apply path. The preview card is derived from the descriptor itself (palette
 * gradient, the template's own headline, its aspect and length), so there is
 * no per-template artwork to drift from what applying it actually produces.
 */
export function TemplatesPanel({ onClose, onApply }: TemplatesPanelProps) {
	const [category, setCategory] = useState<"all" | TemplateCategory>("all");
	const [selected, setSelected] = useState<Template | null>(null);
	const [textOverrides, setTextOverrides] = useState<TemplateTextOverrides>({});
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const visible = useMemo(() => templatesForCategory({ category }), [category]);

	if (selected) {
		return (
			<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
				<div className="cc-template-detail">
					<div
						className="cc-template-preview"
						style={{
							background: `linear-gradient(160deg, ${selected.palette.from}, ${selected.palette.to})`,
						}}
					>
						<span
							className="cc-template-preview__headline"
							style={{ color: selected.palette.accent }}
						>
							{selected.textSlots[0]?.content ?? selected.name}
						</span>
						<span className="cc-template-preview__meta">
							{formatAspect({ template: selected })} · {formatSeconds({ value: selected.duration })}{" "}
							· {selected.mediaSlots.length} clips
						</span>
					</div>

					<p className="cc-sheet-title">{selected.name}</p>
					<p className="cc-panel-note">{selected.description}</p>

					<p className="cc-template-section">Your media</p>
					<ul className="cc-template-slots">
						{selected.mediaSlots.map((slot) => (
							<li key={slot.id}>
								<span>{slot.label}</span>
								<span className="cc-template-slot__meta">
									{slot.kind} · {formatSeconds({ value: slot.duration })}
								</span>
							</li>
						))}
					</ul>
					<p className="cc-panel-note">
						You will pick these from your gallery when you use the template. Anything you
						skip stays an empty slot — nothing is invented for you.
					</p>

					<p className="cc-template-section">Your text</p>
					{selected.textSlots.map((slot) => (
						<label key={slot.id} className="cc-template-field">
							<span>{slot.label}</span>
							<input
								type="text"
								value={textOverrides[slot.id] ?? slot.content}
								onChange={(event) =>
									setTextOverrides((previous) => ({
										...previous,
										[slot.id]: event.target.value,
									}))
								}
							/>
						</label>
					))}

					{error && <p className="cc-template-error">{error}</p>}

					<div className="cc-template-actions">
						<button
							type="button"
							className="cc-template-apply"
							disabled={applying}
							onClick={async () => {
								setApplying(true);
								setError(null);
								try {
									await onApply({ template: selected, text: textOverrides });
								} catch (cause) {
									setError(
										cause instanceof Error ? cause.message : "Couldn't apply that template.",
									);
								} finally {
									setApplying(false);
								}
							}}
						>
							{applying ? "Building…" : "Use template"}
						</button>
						<button
							type="button"
							className="cc-template-back"
							disabled={applying}
							onClick={() => {
								setSelected(null);
								setTextOverrides({});
								setError(null);
							}}
						>
							Back
						</button>
					</div>
					<p className="cc-panel-note">
						Using a template starts a new project, so your current edit is never overwritten.
					</p>
				</div>
			</PanelSheet>
		);
	}

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<ChipRow
				chips={CATEGORY_CHIPS}
				activeIds={[category]}
				onSelect={(id) => {
					if (id === "all") {
						setCategory("all");
						return;
					}
														if (isTemplateCategory(id)) setCategory(id);
				}}
			/>
			{visible.length === 0 && <p className="cc-panel-note">No templates in this category.</p>}
			<div className="cc-template-grid">
				{visible.map((template) => (
					<button
						key={template.id}
						type="button"
						className="cc-template-card"
						aria-label={`${template.name}, ${formatSeconds({ value: template.duration })}`}
						onClick={() => {
							setSelected(template);
							setError(null);
						}}
					>
						<span
							className="cc-template-card__art"
							style={{
								background: `linear-gradient(160deg, ${template.palette.from}, ${template.palette.to})`,
							}}
						>
							<span
								className="cc-template-card__title"
								style={{ color: template.palette.accent }}
							>
								{template.name}
							</span>
							<span className="cc-template-card__badge">
								{formatSeconds({ value: template.duration })}
							</span>
						</span>
						<span className="cc-template-card__meta">
							{TEMPLATE_CATEGORIES[template.category]} · {template.mediaSlots.length} clips
						</span>
					</button>
				))}
			</div>
		</PanelSheet>
	);
}
