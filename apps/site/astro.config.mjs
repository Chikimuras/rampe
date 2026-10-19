import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

// Astro écrit la règle d'affichage de ses îlots dans un <style> juste avant le premier îlot, donc dans <body> : HTML
// invalide (« A style element in body must be the first child of its parent », validateur W3C ; critère RGAA 8.2).
// Aucune option d'Astro 7 ne le déplace (astro/dist/runtime/server/scripts.js, getPrescripts). Ce post-traitement du
// build le replace à la fin de <head>, où il s'applique avant tout îlot. Le serveur de développement n'est pas
// concerné. `pnpm audit:rampe` valide chaque page construite avec le validateur W3C : une régression casse le gate.
const ISLAND_STYLE = "<style>astro-island,astro-slot,astro-static-slot{display:contents}</style>";

/** Fichiers .html du build, récursivement. */
const htmlFiles = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
	);

const islandStyleInHead = {
	name: "rampe:island-style-in-head",
	hooks: {
		"astro:build:done": ({ dir }) => {
			for (const file of htmlFiles(fileURLToPath(dir))) {
				const html = readFileSync(file, "utf8");
				const body = html.indexOf("<body");
				if (body === -1 || !html.includes(ISLAND_STYLE, body)) continue;
				const moved = html.slice(0, body) + html.slice(body).replace(ISLAND_STYLE, "");
				writeFileSync(file, moved.replace("</head>", `${ISLAND_STYLE}</head>`));
			}
		},
	},
};

export default defineConfig({
	site: "https://chikimuras.github.io",
	base: "/rampe",
	// Un seul îlot, sur /audit/ (ADR-0013 §2) : le reste du site reste sans JavaScript.
	integrations: [preact(), islandStyleInHead],
});
