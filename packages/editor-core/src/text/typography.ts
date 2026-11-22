export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 300;
export const DEFAULT_TEXT_COLOR = "#000000";

/**
 * higher value: smaller font size
 * lower value: larger font size
 */
export const FONT_SIZE_SCALE_REFERENCE = 90;

/**
 * The "thin black border" weight, as a PERCENT OF FONT SIZE (round 33) —
 * the same unit CoreText's `kCTStrokeWidth` takes, so the preview's
 * canvas `lineWidth = strokeWidth/100 × scaledFontSize` and the export's
 * stroke attribute are the same number by construction, at any canvas
 * size. (Round 31 shipped these as "font-size units" scaled by
 * scaledFontSize/fontSize, which silently turned a preset's `6` into 33%
 * of the font size and buried exported captions in black.)
 *
 * MEASURED, not guessed: CapCut Web's text stroke defaults to Size 40
 * (of 100), which pixel-analysis of their canvas put at ~13px of visible
 * outline on a ~135px cap height — a heavy poster outline, ~10% of the
 * font size per side (~20% total). That is their DEFAULT-when-enabled;
 * the founder asked for a THIN border, so this ships at 2% total (~1%
 * per side, since a stroke straddles the glyph outline): a crisp
 * legibility edge, not a sticker outline. The Border slider reaches
 * CapCut's own weight.
 */
export const DEFAULT_TEXT_BORDER_WIDTH = 2;

/**
 * The drop shadow a text element gets when its Shadow toggle is switched on.
 * Every value is in the SAME percent-of-font-size unit as
 * `DEFAULT_TEXT_BORDER_WIDTH`, so a shadow keeps its proportion to the
 * glyphs at any canvas size and the preview raster (which the native
 * exporters composite verbatim — see `export/overlay-frames.ts`) is the only
 * implementation.
 *
 * `blurPercent` is the canvas `shadowBlur` radius as a percent of the scaled
 * font size; the offsets are per-axis percentages of the same size, which
 * keeps the shadow down-right like the poster look this mirrors.
 */
export const DEFAULT_TEXT_SHADOW = {
	color: "#000000",
	blurPercent: 25,
	offsetXPercent: 4,
	offsetYPercent: 6,
} as const;
