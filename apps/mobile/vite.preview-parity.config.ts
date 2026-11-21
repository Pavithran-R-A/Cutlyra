import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

const editorCoreSrc = fileURLToPath(
	new URL("../../packages/editor-core/src", import.meta.url),
);

/**
 * Diagnostics-only build of the crop preview parity harness
 * (`preview-parity.html` + `src/preview-parity/main.ts`).
 *
 * Deliberately separate from vite.config.ts: that config builds the bundle
 * Capacitor packages into the shipped apps, and a diagnostics page has no
 * business being in it. Same plugins/alias as the real bundle, because the
 * whole point is to exercise the REAL compositor and the REAL descriptor
 * builder, not a copy.
 *
 *   bunx vite build --config vite.preview-parity.config.ts
 *   # then serve the printed outDir over loopback and open preview-parity.html
 */
export default defineConfig({
	root: __dirname,
	plugins: [wasm()],
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "react",
	},
	resolve: {
		alias: {
			"@": editorCoreSrc,
		},
	},
	build: {
		outDir: "preview-parity-dist",
		emptyOutDir: true,
		target: "esnext",
		minify: false,
		rollupOptions: {
			input: {
				previewParity: "preview-parity.html",
			},
		},
	},
	optimizeDeps: {
		exclude: ["opencut-wasm"],
	},
});
