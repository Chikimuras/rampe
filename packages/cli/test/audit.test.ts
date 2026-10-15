import { describe, expect, it } from "vitest";
import { type AxeRawResult, buildReport, classifyResults, formatReport, parseAuditUrl } from "../src/audit.ts";

const node = (target: string, html = "<x>") => ({ target: [target], html, failureSummary: "Corriger ceci" });
const raw = (id: string, tags: string[], nodes = [node(`#${id}`)]): AxeRawResult => ({
	id,
	tags,
	impact: "serious",
	nodes,
});

describe("parseAuditUrl", () => {
	it("accepte http et https", () => {
		expect(parseAuditUrl("https://exemple.fr/a?b=1").href).toBe("https://exemple.fr/a?b=1");
		expect(parseAuditUrl("http://localhost:8080").protocol).toBe("http:");
	});

	it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://exemple.fr", "exemple.fr", ""])(
		"refuse %s",
		(input) => {
			expect(() => parseAuditUrl(input)).toThrow(/http/);
		},
	);
});

describe("classifyResults", () => {
	const results = classifyResults(
		[
			raw("image-alt", ["wcag2a", "wcag111", "RGAA-1.1.1"]),
			raw("summary-name", ["wcag2a", "wcag412"]),
			raw("landmark-one-main", ["best-practice"]),
			raw("region", ["best-practice", "RGAA-9.2.1"]),
			raw("duplicate-id", ["deprecated", "wcag2a", "wcag411"]),
		],
		[raw("color-contrast", ["wcag2aa", "wcag143", "RGAA-3.2.1"]), raw("audio-caption", ["deprecated", "wcag121"])],
	);
	const byId = Object.fromEntries(results.map((r) => [r.ruleId, r]));

	it("violation rattachée au RGAA : non-conformité détectée, tests cités", () => {
		expect(byId["image-alt"]).toMatchObject({
			kind: "non-conformite",
			level: "rgaa",
			tests: ["1.1.1"],
			criteria: ["1.1"],
			impact: "serious",
		});
	});

	it("violation rattachée via WCAG : rattachement incertain", () => {
		expect(byId["summary-name"]).toMatchObject({ kind: "incertain", level: "wcag", tests: [], wcag: ["4.1.2"] });
		expect(byId["summary-name"]?.criteria.length).toBeGreaterThan(1);
	});

	it("violation hors RGAA : bonne pratique", () => {
		expect(byId["landmark-one-main"]).toMatchObject({
			kind: "bonne-pratique",
			level: "hors-rgaa",
			criteria: [],
			flags: { bestPractice: true, experimental: false },
		});
	});

	it("le drapeau bonne pratique d'axe reste visible sur une non-conformité", () => {
		expect(byId.region).toMatchObject({ kind: "non-conformite", flags: { bestPractice: true } });
	});

	it("incomplete : à vérifier, quel que soit le niveau", () => {
		expect(byId["color-contrast"]).toMatchObject({ kind: "a-verifier", level: "rgaa", criteria: ["3.2"] });
	});

	it("exclut les règles dépréciées", () => {
		expect(byId["duplicate-id"]).toBeUndefined();
		expect(byId["audio-caption"]).toBeUndefined();
	});

	it("tronque l'extrait HTML à 500 caractères", () => {
		const [r] = classifyResults([raw("image-alt", ["RGAA-1.1.1"], [node("img", "a".repeat(2000))])], []);
		expect(r?.nodes[0]?.html).toHaveLength(500);
	});
});

describe("buildReport", () => {
	const report = buildReport({
		startedAt: new Date("2026-10-15T10:00:00Z"),
		axeVersion: "4.14.0",
		browserVersion: "156.0",
		pages: [
			{
				url: "https://exemple.fr",
				finalUrl: "https://exemple.fr/",
				title: "Accueil",
				results: classifyResults([raw("image-alt", ["RGAA-1.1.1"])], []),
			},
		],
	});

	it("a la forme versionnée attendue", () => {
		expect(report).toMatchObject({
			schemaVersion: 1,
			tool: { name: "@rampe/cli", version: expect.any(String) },
			engine: { axe: "4.14.0", browser: "156.0" },
			startedAt: "2026-10-15T10:00:00.000Z",
			pages: [{ url: "https://exemple.fr", finalUrl: "https://exemple.fr/", title: "Accueil" }],
		});
		expect(Object.keys(report.pages[0]?.results[0] ?? {})).toEqual([
			"ruleId",
			"kind",
			"level",
			"tests",
			"criteria",
			"wcag",
			"flags",
			"impact",
			"nodes",
		]);
		expect(JSON.parse(JSON.stringify(report))).toEqual(report);
	});
});

describe("formatReport", () => {
	const page = {
		url: "https://exemple.fr",
		finalUrl: "https://exemple.fr/",
		title: "Accueil",
		results: classifyResults(
			[
				raw("image-alt", ["RGAA-1.1.1"], [node("img.logo"), node("img.photo")]),
				raw("landmark-one-main", ["best-practice"]),
			],
			[raw("color-contrast", ["RGAA-3.2.1"])],
		),
	};
	const text = formatReport(page, 77);

	it("regroupe par critère avec le titre officiel, sans lien markdown", () => {
		// Le titre officiel garde son espace insécable avant « ? ».
		expect(text).toMatch(/Critère 1\.1 — Chaque image porteuse d’information a-t-elle une alternative textuelle\s\?/);
		expect(text).toMatch(/image-alt .*2 éléments.*img\.logo/);
	});

	it("présente bonnes pratiques, points à vérifier et le rappel d'audit humain, sans score", () => {
		expect(text).toContain("landmark-one-main");
		expect(text).toMatch(/À vérifier[\s\S]*color-contrast \(critère 3\.2\)/);
		expect(text).toContain(
			"77 critères sur 106 n’ont aucune vérification automatique directe : audit humain indispensable",
		);
		expect(text).not.toMatch(/\d\s?%|score/i);
	});
});
