import { describe, expect, it } from "vitest";
import { type AuditPage, type AuditReport, type AuditResult, buildReport, uncoveredCriteria } from "../src/audit.ts";
import { escapeHtml, renderHtmlReport } from "../src/rapport.ts";

const result = (over: Partial<AuditResult>): AuditResult => ({
	ruleId: "image-alt",
	kind: "non-conformite",
	level: "rgaa",
	tests: ["1.1.1"],
	criteria: ["1.1"],
	wcag: [],
	flags: { bestPractice: false, experimental: false },
	impact: "critical",
	nodes: [{ target: ["img"], html: "<img src=a>", failureSummary: "Fix any of the following" }],
	...over,
});
const page = (over: Partial<AuditPage>): AuditPage => ({
	url: "https://exemple.fr/",
	finalUrl: "https://exemple.fr/",
	title: "Accueil",
	warnings: [],
	results: [],
	error: null,
	...over,
});
const report = (pages: AuditPage[]): AuditReport =>
	buildReport({ startedAt: new Date("2026-10-15T09:25:01Z"), axeVersion: "4.14.0", browserVersion: "156.0", pages });

/** Balises du gabarit : tout le reste vient forcément d'une donnée non échappée. */
const TEMPLATE_TAGS = new Set(
	"html head meta title style body a header main footer section article h1 h2 h3 h4 p dl dt dd ul ol li details summary code pre time strong span div br bdi".split(
		" ",
	),
);

describe("escapeHtml", () => {
	it("échappe les cinq caractères significatifs du contexte HTML (OWASP, Output Encoding)", () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});
});

describe("renderHtmlReport", () => {
	const hostile = report([
		page({
			url: "https://exemple.fr/?q=javascript:alert(1)&x=<script>",
			finalUrl: "https://exemple.fr/?q=javascript:alert(1)&x=<script>",
			title: "<script>alert(1)</script>",
			warnings: ['<img src=x onerror="alert(2)">'],
			results: [
				result({
					nodes: [
						{
							target: ['a[title="x"><img src=x onerror=alert(3)>"]', ["#hote", "<svg onload=alert(4)>"]],
							html: '<img src=x onerror="alert(5)"><script>alert(6)</script>',
							failureSummary: "</code><script>alert(7)</script>",
						},
					],
				}),
			],
		}),
		page({ url: "javascript:alert(8)", finalUrl: null, title: null, error: "<b onmouseover=alert(9)>" }),
	]);
	const html = renderHtmlReport(hostile);

	it("n'insère aucune balise active venue de la page auditée", () => {
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i);
		const tags = new Set([...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => (m[1] as string).toLowerCase()));
		expect([...tags].filter((t) => !TEMPLATE_TAGS.has(t))).toEqual([]);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(5)&quot;&gt;");
	});

	it("ne fait un lien que vers une adresse http(s)", () => {
		expect(html).not.toMatch(/href="javascript:/i);
		expect(html).toContain('href="https://exemple.fr/?q=javascript:alert(1)&amp;x=&lt;script&gt;"');
	});

	it("est autonome : ni script, ni ressource externe, langue française", () => {
		expect(html).toMatch(/^<!doctype html>\n<html lang="fr">/);
		expect(html).not.toMatch(/<(link|img|iframe|object|embed|svg)\b|@import|url\(/i);
	});

	const sample = renderHtmlReport(
		report([
			page({
				url: "https://exemple.fr/",
				results: [
					result({}),
					result({ ruleId: "label", tests: ["11.1.1"], criteria: ["11.1"] }),
					result({ ruleId: "color-contrast", tests: ["3.2.1"], criteria: ["3.2"] }),
					result({ ruleId: "frame-title", tests: ["2.1.1"], criteria: ["2.1"] }),
					result({
						ruleId: "region",
						kind: "incertain",
						tests: ["9.2.1"],
						criteria: ["9.2"],
						flags: { bestPractice: true, experimental: false },
					}),
					result({
						ruleId: "aria-allowed-role",
						kind: "incertain",
						level: "wcag",
						tests: [],
						criteria: ["7.1", "8.2", "9.1", "11.1"],
						wcag: ["4.1.2"],
					}),
					result({ ruleId: "landmark-one-main", kind: "bonne-pratique", level: "hors-rgaa", criteria: [] }),
					result({ ruleId: "video-caption", kind: "a-verifier", criteria: ["4.3"] }),
				],
			}),
			page({ url: "https://exemple.fr/contact", finalUrl: "https://exemple.fr/contact", results: [result({})] }),
			page({ url: "https://exemple.fr/panne", finalUrl: null, title: null, error: "HTTP 500 pour …/panne" }),
		]),
	);

	it("trie les critères en ordre naturel et compte les pages concernées", () => {
		const ids = [...sample.matchAll(/id="critere-(\d+-\d+)"/g)].map((m) => m[1]);
		expect(ids).toEqual(["1-1", "2-1", "3-2", "11-1"]);
		expect(sample).toMatch(
			/Critère 1\.1<\/a> — Chaque image porteuse d’information a-t-elle une alternative textuelle\s\?<\/strong> : 2 pages/,
		);
		expect(sample).toContain("https://chikimuras.github.io/rampe/referentiel/11-1/");
	});

	it("présente les autres résultats dans l'ordre : incertains, à vérifier, bonnes pratiques", () => {
		const order = ["Rattachement incertain", "À vérifier par un humain", "Bonnes pratiques"].map((t) =>
			sample.indexOf(t),
		);
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("liste les pages en erreur sans les compter comme sans défaut", () => {
		expect(sample).toContain("1 page en erreur");
		expect(sample).toContain("<dd>2</dd>");
		expect(sample).toContain("Elle n’est pas comptée comme sans défaut.");
	});

	it("explique une erreur de page en français, message technique replié", () => {
		expect(sample).toContain("La page n’a pas pu être chargée : le serveur a répondu HTTP 500.");
		expect(sample).toMatch(/<summary>Message technique<\/summary><pre><code>HTTP 500 pour …\/panne<\/code><\/pre>/);
	});

	it("rend le rattachement sans parenthèses imbriquées et réserve « bonne pratique » à la rubrique hors RGAA", () => {
		expect(sample).toContain(
			'— lié au critère <a href="https://chikimuras.github.io/rampe/referentiel/9-2/">9.2</a> (test 9.2.1), mais axe classe cette règle comme indicative : à confirmer par une personne : 1 page',
		);
		const body = sample.replace(/<style>[\s\S]*<\/style>/, "");
		expect(body).not.toMatch(/\([^()]*\(/);
		expect(body.match(/bonnes? pratiques?/gi)).toEqual(["Bonnes pratiques", "bonnes pratiques"]);
	});

	it("affiche la description d'axe en anglais et replie au-delà de 3 critères possibles", () => {
		expect(sample).toContain('<code>image-alt</code> « <span lang="en">Images must have alternative text</span> »');
		expect(sample).toContain("4 critères RGAA possibles, listés ci-dessous");
		expect(sample).toContain("<summary>Voir les 4 critères RGAA possibles</summary>");
	});

	it("nomme le contenu de chaque bloc replié et n'a pas deux titres identiques", () => {
		expect(sample).toContain(
			"<summary>Voir l’élément concerné par image-alt sur <bdi>https://exemple.fr/</bdi></summary>",
		);
		const headings = [...sample.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map((m) => m[1]);
		expect(new Set(headings).size).toBe(headings.length);
	});

	it("donne, par page, le nombre de points à vérifier par un humain", () => {
		expect(sample).toContain("4 règles en non-conformité ; 1 point à vérifier par un humain");
	});

	it("ne propose de corriger que s'il y a des non-conformités ; obligation légale conditionnelle et sourcée", () => {
		expect(sample).toContain("<li>Corriger les non-conformités détectées");
		expect(sample).toContain(
			'Si votre organisation est soumise à l’obligation d’accessibilité, publier une déclaration d’accessibilité. <a href="https://accessibilite.numerique.gouv.fr/obligations/">',
		);
		// Seules mentions juridiques : la phrase conditionnelle et son lien (« obligatoires » de l'intro 3 mis à part).
		expect(sample.match(/obligat(?!oires signalés)\S*/g)).toEqual(["obligation", 'obligations/">Les', "obligations,"]);
		const clean = renderHtmlReport(report([page({})]));
		expect(clean).not.toContain("Corriger les non-conformités");
	});

	it("sans aucune page auditée : un seul message, sans sous-rubriques", () => {
		const none = renderHtmlReport(
			report([page({ finalUrl: null, title: null, error: "audit interrompu après 4000 ms" })]),
		);
		expect(none).toContain("<p>Aucune page n’a pu être auditée : aucun résultat.</p>");
		expect(none).not.toMatch(/Rien à signaler|Non-conformités détectées|Rattachement incertain/);
		expect(none).toContain("La page n’a pas pu être chargée : délai dépassé.");
	});

	it("isole les données de la page et retire les contrôles bidi : le verdict de Rampe reste intact", () => {
		const bidi = renderHtmlReport(
			report([
				page({
					title: "Accueil\u202e\u2066",
					finalUrl: "https://exemple.fr/\u202e",
					warnings: ["\u202bavertissement"],
				}),
			]),
		);
		expect(bidi).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
		expect(bidi).toContain(", titre « <bdi>Accueil</bdi> » : aucune non-conformité détectée automatiquement</li>");
		expect(bidi).toContain("<bdi>avertissement</bdi>");
	});

	it("borne titre et sélecteur à 300 caractères, avec une marque de troncature", () => {
		const long = renderHtmlReport(
			report([
				page({
					title: "t".repeat(400),
					results: [result({ nodes: [{ target: ["s".repeat(400)], html: "<i>", failureSummary: null }] })],
				}),
			]),
		);
		expect(long).toContain(`<bdi>${"t".repeat(300)}… (tronqué)</bdi>`);
		expect(long).toContain(`<code>${"s".repeat(300)}… (tronqué)</code>`);
	});

	it("rappelle ce que l'automatique ne couvre pas, sans aucun score ni pourcentage", () => {
		expect(sample).toContain("Ce rapport n’est pas un audit de conformité.");
		expect(sample).toContain(
			`Les 106 critères demandent une vérification humaine ; ${uncoveredCriteria()} n’ont aucune vérification automatique directe.`,
		);
		expect(sample).toContain("Explication Rampe — non normative");
		expect(sample).toContain('lang="en"');
		const text = sample.replace(/<style>[\s\S]*<\/style>/, "");
		expect(text).not.toMatch(/%|score/i);
	});
});
