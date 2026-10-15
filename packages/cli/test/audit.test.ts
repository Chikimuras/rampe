import { describe, expect, it } from "vitest";
import {
	type AxeRawResult,
	buildReport,
	classifyResults,
	formatReport,
	formatSynthesis,
	parseAuditUrl,
	redact,
	stripControl,
} from "../src/audit.ts";

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
			raw("p-as-heading", ["experimental", "RGAA-9.1.3"]),
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

	it("violation rattachée au RGAA mais bonne pratique ou expérimentale d'axe : incertain, jamais non-conformité", () => {
		expect(byId.region).toMatchObject({
			kind: "incertain",
			level: "rgaa",
			criteria: ["9.2"],
			flags: { bestPractice: true },
		});
		expect(byId["p-as-heading"]).toMatchObject({ kind: "incertain", level: "rgaa", flags: { experimental: true } });
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
				warnings: [],
				results: classifyResults([raw("image-alt", ["RGAA-1.1.1"])], []),
				error: null,
			},
		],
	});

	it("a la forme versionnée attendue", () => {
		expect(report).toMatchObject({
			schemaVersion: 2,
			tool: { name: "@rampe/cli", version: expect.any(String) },
			engine: { axe: "4.14.0", browser: "156.0" },
			startedAt: "2026-10-15T10:00:00.000Z",
			pages: [{ url: "https://exemple.fr", finalUrl: "https://exemple.fr/", title: "Accueil", warnings: [] }],
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

describe("redact", () => {
	it("masque identifiant et mot de passe de toute URL du texte", () => {
		expect(redact("https://alice:s3cr%40t@preprod.exemple.fr/a")).toBe("https://***:***@preprod.exemple.fr/a");
		expect(redact("page.goto: net::ERR at http://bob@x.fr/ (et https://y.fr/)")).toBe(
			"page.goto: net::ERR at http://***:***@x.fr/ (et https://y.fr/)",
		);
		expect(redact("https://exemple.fr/a@b")).toBe("https://exemple.fr/a@b");
	});
});

describe("stripControl", () => {
	it("retire les caractères de contrôle C0 et C1", () => {
		expect(stripControl("a\u001b[31mb\u0007c\u009bd\ne\u007f")).toBe("a[31mbcde");
	});
});

describe("formatReport", () => {
	const page = {
		url: "https://exemple.fr",
		finalUrl: "https://alice:secret@exemple.fr/\u001b[2J",
		title: "Accueil\u001b]0;piège\u0007",
		warnings: [],
		error: null,
		results: classifyResults(
			[
				raw("image-alt", ["RGAA-1.1.1"], [node("img.logo\u001b[31m"), node("img.photo")]),
				raw("region", ["best-practice", "RGAA-9.2.1"]),
				raw("landmark-one-main", ["best-practice"]),
			],
			[raw("color-contrast", ["RGAA-3.2.1"])],
		),
	};
	const text = formatReport(page, 79);

	it("regroupe par critère avec le titre officiel, sans lien markdown", () => {
		// Le titre officiel garde son espace insécable avant « ? ».
		expect(text).toMatch(/Critère 1\.1 — Chaque image porteuse d’information a-t-elle une alternative textuelle\s\?/);
		expect(text).toMatch(/image-alt .*2 éléments.*img\.logo/);
	});

	it("range une bonne pratique d'axe rattachée au RGAA sous son critère, à confirmer", () => {
		expect(text).toMatch(
			/rattachement RGAA incertain :\n {2}Critère 9\.2 — .*\n {4}- region \(test 9\.2\.1 ; règle de bonne pratique d’axe : à confirmer par un humain\)/,
		);
	});

	it("ne laisse passer ni caractère de contrôle ni identifiants", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: on vérifie leur absence.
		expect(text.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(text).toContain("https://***:***@exemple.fr/");
		expect(text).not.toContain("secret");
	});

	it("présente bonnes pratiques, points à vérifier et le rappel d'audit humain, sans score", () => {
		expect(text).toContain("landmark-one-main");
		expect(text).toMatch(/À vérifier[\s\S]*color-contrast \(critère 3\.2\)/);
		expect(text).toContain(
			"Les 106 critères demandent une vérification humaine. 79 d’entre eux n’ont même aucune vérification automatique directe.",
		);
		expect(text).not.toMatch(/\d\s?%|score/i);
	});
});

describe("formatSynthesis", () => {
	const page = (url: string, results = classifyResults([], []), error: string | null = null) => ({
		url,
		finalUrl: error ? null : url,
		title: error ? null : "T",
		warnings: [],
		results,
		error,
	});
	const text = formatSynthesis(
		[
			page("https://exemple.fr/", classifyResults([raw("image-alt", ["RGAA-1.1.1"])], [])),
			page(
				"https://exemple.fr/contact",
				classifyResults([raw("image-alt", ["RGAA-1.1.1"]), raw("region", ["best-practice", "RGAA-9.2.1"])], []),
			),
			page("https://alice:secret@exemple.fr/lent", [], "audit interrompu\u001b[2J"),
		],
		79,
	);

	it("liste les critères en non-conformité sur au moins une page, avec les pages concernées", () => {
		expect(text).toMatch(
			/Critère 1\.1 — .* : 2 pages\n {4}- https:\/\/exemple\.fr\/\n {4}- https:\/\/exemple\.fr\/contact/,
		);
		expect(text).not.toContain("Critère 9.2");
	});

	it("compte séparément pages auditées et pages en erreur", () => {
		expect(text).toMatch(/^Synthèse de l’échantillon : 2 pages auditées, 1 en erreur\n/);
		const allFailed = formatSynthesis([page("https://exemple.fr/", [], "HTTP 404 pour https://exemple.fr/")], 79);
		expect(allFailed).toMatch(
			/^Synthèse de l’échantillon : 0 page auditée, 1 en erreur\n\nAucune page n’a pu être auditée\./,
		);
		expect(allFailed).not.toContain("Aucune non-conformité");
		expect(formatSynthesis([page("https://exemple.fr/")], 79)).toContain(
			"1 page auditée, 0 en erreur\n\nAucune non-conformité détectée automatiquement sur les pages auditées.",
		);
	});

	it("signale les pages en erreur, masque les identifiants, rappelle la vérification humaine", () => {
		expect(text).toContain("1 page en erreur, non auditée :\n  - https://***:***@exemple.fr/lent");
		expect(text).not.toContain("secret");
		expect(text).toContain("Les 106 critères demandent une vérification humaine.");
	});
});
