import { parseAuditReport, rgaa } from "@rampe/core";
import { describe, expect, it } from "vitest";
import {
	browserName,
	buildExtensionReport,
	checkTabUrl,
	groupByCriterion,
	NO_ACCESS,
	type PageRun,
	reportFileName,
} from "../src/report.ts";

const known = new Set(rgaa.criteria.map((c) => c.id));
const node = { target: ["img"], html: "<img src=x>", failureSummary: "Corriger" };
const run = (over: Partial<PageRun> = {}): PageRun => ({
	url: "https://user:secret@exemple.fr/page#haut",
	title: "Accueil",
	axeVersion: "4.14.0",
	violations: [
		{
			id: "image-alt",
			help: "Images must have alternative text",
			tags: ["RGAA-1.1.1"],
			impact: "critical",
			nodes: [node],
		},
		{ id: "region", tags: ["best-practice", "RGAA-9.2.1"], impact: "moderate", nodes: [node] },
		{ id: "target-size", tags: ["wcag22aa", "wcag258"], impact: "serious", nodes: [node] },
		{ id: "duplicate-id", tags: ["deprecated", "wcag411"], impact: "minor", nodes: [node] },
	],
	incomplete: [{ id: "color-contrast", tags: ["RGAA-3.2.1"], impact: "serious", nodes: [node] }],
	...over,
});
const build = (r = run()) =>
	buildExtensionReport({
		version: "0.1.0",
		startedAt: new Date("2026-10-16T08:00:00Z"),
		browser: "Chrome 156",
		run: r,
	});

describe("checkTabUrl : pages refusées avec un message clair", () => {
	it("accepte http et https", () => {
		expect(checkTabUrl("https://exemple.fr/a").href).toBe("https://exemple.fr/a");
		expect(checkTabUrl("http://localhost:8080/").protocol).toBe("http:");
	});

	it.each([
		[undefined, NO_ACCESS],
		["", NO_ACCESS],
		["pas une adresse", NO_ACCESS],
		["chrome://extensions/", /pages web \(adresses http/],
		["about:debugging", /pages web/],
		["chrome-extension://abc/popup.html", /pages internes du navigateur et des extensions/],
		["moz-extension://abc/popup.html", /pages web/],
		["view-source:https://exemple.fr/", /pages web/],
		["data:text/html,<p>x", /pages web/],
		["javascript:alert(1)", /pages web/],
		["file:///Users/moi/page.html", /fichiers ouverts depuis l’ordinateur/],
		["https://chromewebstore.google.com/detail/x", /magasins d’extensions/],
		["https://chrome.google.com/webstore/detail/x", /magasins d’extensions/],
		["https://addons.mozilla.org/fr/firefox/", /magasins d’extensions/],
	])("refuse %s", (url, message) => {
		expect(() => checkTabUrl(url)).toThrow(message);
	});
});

describe("buildExtensionReport : rapport v2 de la même structure que la CLI", () => {
	it("forme versionnée, outil @rampe/extension, identifiants masqués", () => {
		const report = build();
		expect(Object.keys(report)).toEqual(["schemaVersion", "tool", "engine", "startedAt", "pages"]);
		expect(report).toMatchObject({
			schemaVersion: 2,
			tool: { name: "@rampe/extension", version: "0.1.0" },
			engine: { axe: "4.14.0", browser: "Chrome 156" },
			startedAt: "2026-10-16T08:00:00.000Z",
		});
		expect(report.pages).toHaveLength(1);
		expect(Object.keys(report.pages[0] ?? {})).toEqual(["url", "finalUrl", "title", "warnings", "results", "error"]);
		expect(report.pages[0]).toMatchObject({
			url: "https://***:***@exemple.fr/page#haut",
			finalUrl: "https://***:***@exemple.fr/page#haut",
			title: "Accueil",
			warnings: [],
			error: null,
		});
		expect(JSON.stringify(report)).not.toContain("secret");
	});

	it("classement de la CLI : NC, incertain, bonne pratique, à vérifier ; règle dépréciée exclue", () => {
		const results = build().pages[0]?.results ?? [];
		expect(results.map((r) => [r.ruleId, r.kind])).toEqual([
			["image-alt", "non-conformite"],
			["region", "incertain"],
			["target-size", "bonne-pratique"],
			["color-contrast", "a-verifier"],
		]);
	});

	it("accepté tel quel par l'import de l'audit guidé (parseAuditReport)", () => {
		const parsed = parseAuditReport(JSON.parse(JSON.stringify(build())), known);
		expect(parsed.site).toBe("https://exemple.fr");
		expect(parsed.pages[0]?.url).toBe("https://exemple.fr/page");
		expect(parsed.pages[0]?.results.map((r) => r.criteria)).toEqual([["1.1"], ["9.2"], [], ["3.2"]]);
	});

	it("titre borné ; une page qui a quitté le web pendant l'analyse est refusée", () => {
		expect(build(run({ title: "x".repeat(1000) })).pages[0]?.title).toBe(`${"x".repeat(300)}… (tronqué)`);
		expect(() => build(run({ url: "about:blank" }))).toThrow(/pages web/);
	});

	it("nom de fichier : hôte et date", () => {
		expect(reportFileName(build())).toBe("rampe-exemple.fr-2026-10-16.json");
	});
});

describe("groupByCriterion et browserName", () => {
	it("range par critère en ordre naturel, puis les résultats sans critère", () => {
		const results = build(
			run({
				violations: [
					{ id: "a", tags: ["RGAA-11.1.1"], nodes: [node] },
					{ id: "b", tags: ["RGAA-3.2.1", "RGAA-11.1.1"], nodes: [node] },
				],
				incomplete: [{ id: "c", tags: [], nodes: [node] }],
			}),
		).pages[0]?.results;
		expect(groupByCriterion(results ?? [], "non-conformite").map(([id, rs]) => [id, rs.map((r) => r.ruleId)])).toEqual([
			["3.2", ["b"]],
			["11.1", ["a", "b"]],
		]);
		expect(groupByCriterion(results ?? [], "a-verifier").map(([id]) => id)).toEqual([null]);
	});

	it("lit le navigateur dans l'agent utilisateur", () => {
		expect(browserName("Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/156.0.8078.4 Safari/537.36")).toBe(
			"Chrome 156.0.8078.4",
		);
		expect(browserName("Mozilla/5.0 (X11; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox 140.0");
		expect(browserName("Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0.1")).toBe("Edge 140.0.1");
		expect(browserName("?")).toBe("inconnu");
	});
});
