import { describe, expect, it } from "vitest";
import { markEnglishHtml, markEnglishText, OFFICIAL_TERMS, TECH_TERMS } from "./lang";

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
	])("balise %s", (input, expected) => {
		expect(markEnglishText(input, OFFICIAL_TERMS)).toBe(expected);
	});

	it("échappe le texte", () => {
		expect(markEnglishText("a < b & Landmarks", OFFICIAL_TERMS)).toBe(`a &#x3C; b &#x26; ${en("Landmarks")}`);
	});
});
