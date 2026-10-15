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
	"html head meta title style body a header main footer section article h1 h2 h3 h4 p dl dt dd ul ol li details summary code pre time strong span div br".split(
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
					result({ ruleId: "region", kind: "incertain", tests: ["9.2.1"], criteria: ["9.2"] }),
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
		expect(sample).toContain("HTTP 500 pour …/panne");
		expect(sample).toContain("<dd>2</dd>");
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
