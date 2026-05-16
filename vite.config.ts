import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		electron({
			main: {
				entry: "electron/main.ts",
				vite: {
					build: {},
				},
			},
			preload: {
				input: path.join(__dirname, "electron/preload.ts"),
				// We disable Electron's renderer sandbox on the editor window so the
				// preload can use node:net (TCP encoder transport). With sandbox off,
				// Electron loads the preload as a real Node module — and vite emits
				// CommonJS-style require() calls. Force the output extension to .cjs
				// so Node treats it as CommonJS instead of refusing the require()s
				// with "require is not defined in ES module scope".
				vite: {
					build: {
						rollupOptions: {
							output: {
								format: "cjs",
								entryFileNames: "preload.cjs",
							},
						},
					},
				},
			},
			renderer: process.env.NODE_ENV === "test" ? undefined : {},
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	worker: {
		// The render worker imports pixi.js + project utilities; with the default
		// IIFE format Vite cannot code-split a large dep graph and the build fails.
		// ES module workers are supported by all modern Chromium / Electron.
		format: "es",
	},
	build: {
		target: "esnext",
		minify: "terser",
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				pure_funcs: ["console.log", "console.debug"],
			},
		},
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("pixi.js") || id.includes("pixi-filters") || id.includes("@pixi/"))
						return "pixi";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
					if (
						id.includes("mediabunny") ||
						id.includes("mp4box") ||
						id.includes("fix-webm-duration")
					)
						return "video-processing";
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
