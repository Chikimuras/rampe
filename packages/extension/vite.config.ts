// Build de l'extension (ADR-0019) : Vite est déjà installé dans le dépôt (via Astro), rien de neuf à télécharger.
// Sortie : dist/ (extension non empaquetée) ; l'archive .zip est faite par le script `build`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { uncoveredCriteria } from "@rampe/core";
import axe from "axe-core";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
	root: "src",
	base: "./",
	publicDir: "../public",
	define: { __RAMPE_UNCOVERED__: JSON.stringify(uncoveredCriteria(axe.getRules())) },
	build: {
		outDir: "../dist",
		emptyOutDir: true,
		target: "es2022",
		// Aucun script en ligne (la CSP n'admet que 'self') ni polyfill de préchargement.
		modulePreload: false,
		rollupOptions: { input: "src/popup.html" },
	},
	// Tests (vitest) : à la racine du paquet, pas dans src/.
	test: { root: import.meta.dirname },
	plugins: [
		{
			name: "axe-core-embarque",
			// axe-core est copié tel que publié, jamais chargé à distance (ADR-0019 §3), avec sa licence (MPL-2.0).
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "axe.min.js",
					source: readFileSync(require.resolve("axe-core/axe.min.js")),
				});
				this.emitFile({
					type: "asset",
					fileName: "axe-core-LICENSE.txt",
					source: readFileSync(require.resolve("axe-core/LICENSE")),
				});
			},
		},
	],
});
