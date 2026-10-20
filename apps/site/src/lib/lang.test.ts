import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markEnglishHtml, markEnglishText, OFFICIAL_TERMS, TECH_TERMS, termsPattern } from "./lang";

const en = (w: string) => `<span lang="en">${w}</span>`;
const mark = (html: string) => markEnglishHtml(html, TECH_TERMS);

describe("markEnglishHtml", () => {
	it("balise les termes du texte, en gardant la casse d'origine", () => {
		expect(mark("<p>Premier commit, puis Merge et BUILD.</p>")).toBe(
			`<p>Premier ${en("commit")}, puis ${en("Merge")} et ${en("BUILD")}.</p>`,
		);
	});

	it("reconnaît le pluriel en -s", () => {
		expect(mark("<p>des commits et des forks</p>")).toBe(`<p>des ${en("commits")} et des ${en("forks")}</p>`);
	});

	it.each([
		"backend",
		"fixtures",
		"headless",
		"monorepo",
		"squash",
		"runner",
		"jobs",
		"cheat sheet",
		"open source",
		"focus",
		"bugs",
		"cookies",
		"e-commerce",
		"emoji",
		"proxy",
		"dogfooding",
		"admins",
		"popup",
		"bidi",
	])("balise %s", (w) => {
		expect(mark(`<p>un ${w} ici</p>`)).toBe(`<p>un ${en(w)} ici</p>`);
	});

	it("ne balise que des mots entiers", () => {
		const html = "<p>rebuild, builder, checkoutx, gateway, sous-commit, merger, lintage</p>";
		expect(mark(html)).toBe(html);
	});

	it("préfère le terme le plus long (force-push plutôt que push)", () => {
		expect(mark("<p>pas de force-push ni de push</p>")).toBe(`<p>pas de ${en("force-push")} ni de ${en("push")}</p>`);
	});

	it("ne touche ni le code, ni le préformaté, ni un passage déjà en langue étrangère", () => {
		const html = '<p><code>pnpm build</code></p><pre><code>git commit</code></pre><p lang="en">the build</p>';
		expect(mark(html)).toBe(html);
	});

	it("ne touche ni les attributs, ni l'URL d'un lien, mais balise le texte d'un lien ordinaire", () => {
		expect(
			mark(
				'<p><a href="https://x.test/commit/build" title="build">https://x.test/commit/1</a> <a href="/a">le build</a></p>',
			),
		).toBe(
			`<p><a href="https://x.test/commit/build" title="build">https://x.test/commit/1</a> <a href="/a">le ${en("build")}</a></p>`,
		);
	});

	it("ne balise pas un mot pris dans un chemin", () => {
		const html = "<p>apps/build/x et lint.config</p>";
		expect(mark(html)).toBe(html);
	});
});

describe("markEnglishText (intitulés officiels)", () => {
	it.each([
		["Landmarks", en("Landmarks")],
		["sur le principe du style switcher.", `sur le principe du ${en("style switcher")}.`],
		["de type landmark correspondant", `de type ${en("landmark")} correspondant`],
		["(pop-up ou pop-under, par exemple)", `(${en("pop-up")} ou ${en("pop-under")}, par exemple)`],
		["Code de sécurité anti-spam", `Code de sécurité ${en("anti-spam")}`],
		["une adresse e-mail valide", `une adresse ${en("e-mail")} valide`],
		["le style au focus natif", `le style au ${en("focus")} natif`],
		["voix off…", `voix ${en("off")}…`],
		["nuage de tags", `nuage de ${en("tags")}`],
		["sites, blogs", `sites, ${en("blogs")}`],
		["image bitmap (balise", `image ${en("bitmap")} (balise`],
		["composant JavaScript (widget).", `composant JavaScript (${en("widget")}).`],
		["le plugin Word Accessibility Plug-in", `le ${en("plugin")} Word Accessibility ${en("Plug-in")}`],
		["un podcast, une playlist, une newsletter", `un ${en("podcast")}, une ${en("playlist")}, une ${en("newsletter")}`],
		["checker (all frames) ».", `checker (${en("all frames")}) ».`],
		["de type “field name” de", `de type “${en("field name")}” de`],
	])("balise %s", (input, expected) => {
		expect(markEnglishText(input, OFFICIAL_TERMS)).toBe(expected);
	});

	it("échappe le texte", () => {
		expect(markEnglishText("a < b & Landmarks", OFFICIAL_TERMS)).toBe(`a &#x3C; b &#x26; ${en("Landmarks")}`);
	});
});

describe("markEnglishText (titres des ADR et documents)", () => {
	it.each([
		[
			"ADR-0003 — Monorepo TypeScript (pnpm) : core, cli, site",
			`ADR-0003 — ${en("Monorepo")} TypeScript (pnpm) : core, cli, site`,
		],
		["ADR-0005 — Pas de backend : les données", `ADR-0005 — Pas de ${en("backend")} : les données`],
		[
			"ADR-0006 — Gates de vérification et flux de merge",
			`ADR-0006 — ${en("Gates")} de vérification et flux de ${en("merge")}`,
		],
	])("balise %s", (input, expected) => {
		expect(markEnglishText(input, TECH_TERMS)).toBe(expected);
	});
});

describe("docs/ : pas de forme francisée d'un mot anglais, titres sans anglais (8.7)", () => {
	const root = new URL("../../../../docs/", import.meta.url);
	const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
		(f) => f.endsWith(".md") && !f.startsWith("audit-rampe"),
	);
	it.each(files)("%s", (f) => {
		const text = readFileSync(new URL(f, root), "utf8");
		expect(text.match(/\b(?:commit|merg|push|squash)(?:é|ée|és|ées|er)(?![\p{L}])|adversaria/giu)).toBeNull();
	});

	// Le <title> ne peut pas porter de `lang` (critère 8.7.1) : le titre du frontmatter est écrit en français.
	it.each(files)("titre de %s", (f) => {
		const title = /^title:\s*(.*)$/m.exec(readFileSync(new URL(f, root), "utf8"))?.[1] ?? "";
		expect(title.match(termsPattern(TECH_TERMS))).toBeNull();
	});
});
