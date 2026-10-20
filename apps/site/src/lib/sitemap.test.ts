import { describe, expect, it } from "vitest";
import { fixedPages, sectionOf } from "./sitemap";

const page = (title: string) => `---\n---\n<Base\n\ttitle="${title}" description={x}>\n</Base>`;

describe("fixedPages", () => {
	it("classe les pages fixes par rubrique, sans les routes à paramètre ni la 404", () => {
		expect(
			fixedPages({
				"./index.astro": page("Accueil"),
				"./404.astro": page("Page introuvable"),
				"./referentiel/[id].astro": page("x"),
				"./referentiel/glossaire.astro": page("Glossaire"),
				"./cockpit/index.astro": page("Cockpit"),
				"./plan-du-site.astro": page("Plan du site"),
			}),
		).toEqual([
			{ path: "", title: "Accueil", section: "" },
			{ path: "cockpit/", title: "Cockpit", section: "cockpit" },
			{ path: "plan-du-site/", title: "Plan du site", section: "" },
			{ path: "referentiel/glossaire/", title: "Glossaire", section: "referentiel" },
		]);
	});

	it("fait échouer le build pour un dossier de pages non prévu", () => {
		expect(() => fixedPages({ "./aide/index.astro": page("Aide") })).toThrow(
			/rubrique inconnue pour \.\/aide\/index\.astro/,
		);
		expect(() => sectionOf("./toString/x.astro")).toThrow(/rubrique inconnue/);
	});

	it("fait échouer le build pour une page sans titre littéral", () => {
		expect(() => fixedPages({ "./a.astro": "<Base title={t}>" })).toThrow(/<Base title/);
	});
});
