import { rgaa } from "@rampe/core";
import { htmlToHast } from "satteri";
import { describe, expect, it } from "vitest";
import { renderGlossaryHtml, renderMarkdown } from "./render";

const attacks = [
	"<script>alert(1)</script>",
	'<img src="x" onerror="alert(1)">',
	'<a href="javascript:alert(1)">clic</a>',
	"[clic](javascript:alert(1))",
	'<p onclick="alert(1)" style="color:red" id="contenu">texte</p>',
];

describe("renderMarkdown", () => {
	it.each(attacks)("neutralise %s", (input) => {
		const html = renderMarkdown(input);
		expect(html).not.toMatch(/<script|<img|onerror=|onclick=|style=|id=|href="javascript/i);
	});

	it("rend le code inline comme du code, pas comme une balise", () => {
		expect(renderMarkdown("Balise `<img>` ici", { inline: true })).toBe("Balise <code>&#x3C;img></code> ici");
	});

	it("réécrit les liens du glossaire vers sa page", () => {
		expect(renderMarkdown("Une [image porteuse](#image-porteuse-d-information).", { inline: true })).toBe(
			'Une <a href="/referentiel/glossaire/#image-porteuse-d-information">image porteuse</a>.',
		);
	});

	it("retire un lien vers une ancre absente du glossaire, garde son texte", () => {
		expect(renderMarkdown("[méthodes](#table-descriptions-techniques)", { inline: true })).toBe("méthodes");
	});

	it("garde les liens externes http(s) et la langue des passages", () => {
		expect(renderMarkdown('<span lang="en">focus</span> [W3C](https://www.w3.org/)', { inline: true })).toBe(
			'<span lang="en">focus</span> <a href="https://www.w3.org/">W3C</a>',
		);
	});

	it("ne garde que le texte des liens avec stripLinks", () => {
		expect(renderMarkdown("Une [image](#image-porteuse-d-information) `<a>`", { inline: true, stripLinks: true })).toBe(
			"Une image <code>&#x3C;a></code>",
		);
	});

	it("garde les listes en mode bloc", () => {
		expect(renderMarkdown("1. un\n2. deux")).toContain("<ol>");
	});
});

describe("renderGlossaryHtml", () => {
	it.each(attacks)("neutralise %s", (input) => {
		expect(renderGlossaryHtml(input)).not.toMatch(/<script|<img|onerror=|onclick=|style=|id=|href="javascript/i);
	});

	it("laisse les ancres internes à la page du glossaire", () => {
		expect(renderGlossaryHtml('<p>Voir <a href="#lien">lien</a>.</p>')).toBe('<p>Voir <a href="#lien">lien</a>.</p>');
	});

	it("rend toutes les entrées officielles sans perdre de texte", () => {
		const text = (html: string): string => {
			const walk = (n: { type: string; value?: string; children?: unknown[] }): string =>
				n.type === "text" ? (n.value ?? "") : (n.children ?? []).map((c) => walk(c as typeof n)).join("");
			return walk(htmlToHast(html, { fragment: true }) as never);
		};
		for (const e of rgaa.glossary) expect(text(renderGlossaryHtml(e.body)), e.anchor).toBe(text(e.body));
	});
});
