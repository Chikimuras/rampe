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

	it.each(["backend", "fixtures", "headless", "monorepo", "runner", "dogfooding", "bidi"])("balise %s", (w) => {
		expect(mark(`<p>un ${w} ici</p>`)).toBe(`<p>un ${en(w)} ici</p>`);
	});

	// Note 1 du critère 8.7 (dictionnaire de l'Académie) et note 2 (mot passé dans le langage commun) : pas de `lang`.
	it.each([
		"squash",
		"job",
		"focus",
		"bug",
		"cookie",
		"e-mail",
		"open source",
		"cheat sheet",
		"proxy",
		"emoji",
		"widget",
		"plugin",
		"spam",
		"admin",
		"popup",
		"e-commerce",
	])("ne balise pas %s (Académie ou langage commun)", (w) => {
		expect(mark(`<p>un ${w} ici</p>`)).toBe(`<p>un ${w} ici</p>`);
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
		["(pop-up ou pop-under, par exemple)", `(pop-up ou ${en("pop-under")}, par exemple)`],
		["checker (all frames) ».", `checker (${en("all frames")}) ».`],
		["de type “field name” de", `de type “${en("field name")}” de`],
	])("balise %s", (input, expected) => {
		expect(markEnglishText(input, OFFICIAL_TERMS)).toBe(expected);
	});

	// Mots de l'Académie ou passés dans le langage commun (notes 1 et 2), noms propres et titres d'œuvres : pas de `lang`.
	it.each([
		"Code de sécurité anti-spam",
		"une adresse e-mail valide",
		"le style au focus natif",
		"voix off…",
		"nuage de tags",
		"sites, blogs",
		"image bitmap (balise",
		"composant JavaScript (widget).",
		"le plugin Word Accessibility Plug-in",
		"un podcast, une playlist, une newsletter",
		"Requirements for providing text",
	])("ne balise pas %s", (input) => {
		expect(markEnglishText(input, OFFICIAL_TERMS)).toBe(input);
	});

	it("échappe le texte", () => {
		expect(markEnglishText("a < b & Landmarks", OFFICIAL_TERMS)).toBe(`a &#x3C; b &#x26; ${en("Landmarks")}`);
	});
});

/**
 * Formes francisées d'un verbe anglais de TECH_TERMS (« commité », « mergeait », « forkons »…) : à réécrire en français.
 * « merge », « rebase » et les noms anglais en -er (« checker », « linter »…) sont des mots anglais, pas des formes
 * francisées : ils relèvent du balisage, pas de ce garde-fou.
 */
const VERB_STEMS = [
	"commit",
	"committ",
	"merg",
	"push",
	"squash",
	"rebas",
	"fork",
	"checkout",
	"lint",
	"build",
	"check",
];
const ENDINGS = [
	"eaient",
	"eait",
	"eant",
	"eons",
	"ées",
	"ée",
	"és",
	"é",
	"aient",
	"ait",
	"ant",
	"ons",
	"ez",
	"ent",
	"er",
	"es",
	"e",
];
const ENGLISH = new Set([
	"merge",
	"merges",
	"rebase",
	"rebases",
	"checker",
	"linter",
	"builder",
	"pusher",
	"pushes",
	"squashes",
]);
const francizedRe = new RegExp(
	`\\b(?:${VERB_STEMS.join("|")})(?:${ENDINGS.join("|")})(?![\\p{L}])|adversaria\\p{L}*`,
	"giu",
);
const francized = (text: string) =>
	[...text.matchAll(francizedRe)].map((m) => m[0]).filter((w) => !ENGLISH.has(w.toLowerCase()));

describe("garde-fou des formes francisées", () => {
	it.each([
		"commité",
		"committée",
		"mergés",
		"mergeait",
		"pushaient",
		"squashant",
		"rebasons",
		"forkez",
		"checkoutent",
		"lintes",
		"builde",
		"Commiter",
		"adversariale",
	])("repère %s", (w) => {
		expect(francized(`un ${w} ici`)).toHaveLength(1);
	});

	it("laisse les mots anglais et les noms : merge, rebase, checker, linter, commit, builds", () => {
		expect(
			francized("un merge, des rebases, le checker, un linter, un commit, des builds, le push, des pushes"),
		).toEqual([]);
	});
});

describe("docs/ : pas de forme francisée d'un mot anglais, titres sans anglais (8.7)", () => {
	const root = new URL("../../../../docs/", import.meta.url);
	const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
		(f) => f.endsWith(".md") && !f.startsWith("audit-rampe"),
	);
	it.each(files)("%s", (f) => {
		const text = readFileSync(new URL(f, root), "utf8");
		expect(francized(text)).toEqual([]);
	});

	// Le <title> ne peut pas porter de `lang` (critère 8.7.1) : le titre du frontmatter est écrit en français.
	it.each(files)("titre de %s", (f) => {
		const title = /^title:\s*(.*)$/m.exec(readFileSync(new URL(f, root), "utf8"))?.[1] ?? "";
		expect(title.match(termsPattern(TECH_TERMS))).toBeNull();
	});
});
