export {
	TEMPLATE_CATEGORIES,
	TEMPLATES,
	getTemplate,
	isTemplateCategory,
	templatesForCategory,
} from "./library";
export {
	IDENTITY_TEMPLATE_TRANSFORM,
	planDuration,
	planDurationSeconds,
	planTemplate,
} from "./plan";
export {
	applyTemplateToNewProject,
	estimateTemplateDuration,
	type AppliedTemplateRefs,
} from "./apply";
export type {
	PlannedElement,
	PlannedGraphicElement,
	PlannedMediaElement,
	PlannedTextElement,
	Template,
	TemplateApplySummary,
	TemplateCategory,
	TemplateGraphicSlot,
	TemplateMediaAssignment,
	TemplateMediaAssignments,
	TemplateMediaSlot,
	TemplatePalette,
	TemplatePlan,
	TemplateSettings,
	TemplateTextOverrides,
	TemplateTextSlot,
	TemplateTransform,
	TemplateTransition,
	UnfilledSlot,
} from "./types";
