/**
 * DOM canvas doubles for headless tests.
 *
 * `bun test` runs without a DOM, so `new OffscreenCanvas(...)` and every other
 * member of `CanvasImageSource` are unavailable. Geometry and frame-descriptor
 * tests only ever forward a source reference into a texture descriptor — the
 * actual WebGL upload happens in the browser — so a bare object is a faithful
 * stand-in for that reference.
 *
 * The type assertion these need lives here, once, instead of in every test:
 * `CanvasImageSource` is a DOM union with no constructible member off-browser,
 * and the alternative (casting at each call site) just spreads the same
 * unverifiable claim across the suite.
 */
export function canvasDouble(): CanvasImageSource {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {} as CanvasImageSource;
}

/** OffscreenCanvas twin of {@link canvasDouble}, for `rendered` texture entries. */
export function offscreenCanvasDouble(): OffscreenCanvas {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return {} as OffscreenCanvas;
}
