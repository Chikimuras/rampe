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

	it("garde le numéro de départ d'une liste ordonnée", () => {
		expect(renderMarkdown("3. trois\n4. quatre")).toContain('<ol start="3">');
	});

	it.each(["//evil.example", "/\\evil.example", "/chemin", "relatif", "data:text/html,x"])(
		"retire un lien hors site ou relatif : %s",
		(href) => {
			expect(renderMarkdown(`[clic](${href})`, { inline: true })).toBe("clic");
			expect(renderGlossaryHtml(`<a href="${href}">clic</a>`)).toBe("clic");
		},
	);

	it("retire un lien d'ancre mal encodée", () => {
		expect(renderMarkdown("[clic](#%E0%A4%A)", { inline: true })).toBe("clic");
	});

	it("garde les liens mailto et https", () => {
		expect(renderGlossaryHtml('<a href="mailto:a@b.fr">a</a> <a href="https://w3.org/">b</a>')).toBe(
			'<a href="mailto:a@b.fr">a</a> <a href="https://w3.org/">b</a>',
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

	it("balise les mots anglais du texte officiel sans le modifier (8.7), une seule fois", () => {
		expect(renderGlossaryHtml('<p>le style switcher et les <span lang="en">landmarks</span></p>')).toBe(
			'<p>le <span lang="en">style switcher</span> et les <span lang="en">landmarks</span></p>',
		);
		expect(renderMarkdown("rôle de type [landmark](#landmarks)", { inline: true })).toBe(
			'rôle de type <a href="/referentiel/glossaire/#landmarks"><span lang="en">landmark</span></a>',
		);
	});

	it("balise les mots anglais des méthodologies et notes officielles (8.7)", () => {
		const tests = rgaa.criteria.flatMap((c) => c.tests);
		const methodology = (id: string) => renderMarkdown(tests.find((t) => t.id === id)?.methodology ?? "");
		expect(methodology("13.2.1")).toContain(
			'(<span lang="en">pop-up</span> ou <span lang="en">pop-under</span>, par exemple)',
		);
		expect(methodology("8.2.1")).toContain('(<span lang="en">all frames</span>)');
		const notes = (rgaa.criteria.find((c) => c.id === "11.13")?.technicalNote ?? []).filter(
			(n) => typeof n === "string",
		);
		expect(notes.map((n) => renderMarkdown(n)).join("")).toContain('<span lang="en">“field name”</span>');
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
