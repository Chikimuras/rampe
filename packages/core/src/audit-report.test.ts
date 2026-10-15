import { describe, expect, it } from "vitest";
import {
	type AuditReport,
	type AuditResult,
	importAutomaticResults,
	parseAuditReport,
	REPORT_TOOL_NAME,
} from "./audit-report.ts";
import { addPage, createSession, getEvaluation, getFindings, setEvaluation } from "./audit-session.ts";
import { rgaa } from "./rgaa.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const LATER = "2026-10-15T11:00:00.000Z";
const A = "00000000-0000-4000-8000-00000000000a";
const known = new Set(rgaa.criteria.map((c) => c.id));
const ids = () => {
	let n = 0;
	return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

const result = (ruleId: string, kind: AuditResult["kind"], criteria: string[], nodes = 1): AuditResult => ({
	ruleId,
	help: `Help for ${ruleId}`,
	kind,
	level: "rgaa",
	tests: [],
	criteria,
	wcag: [],
	flags: { bestPractice: false, experimental: false },
	impact: "serious",
	nodes: Array.from({ length: nodes }, () => ({ target: ["img"], html: "<img>", failureSummary: null })),
});

// Pages volontairement peu typées : les tests y glissent des valeurs hostiles.
const report = (pages: Record<string, unknown>[]): AuditReport => ({
	schemaVersion: 2,
	tool: { name: REPORT_TOOL_NAME, version: "0.0.0" },
	engine: { axe: "4.14.0", browser: "156" },
	startedAt: NOW,
	pages: pages.map((p) => ({
		url: "https://exemple.fr/",
		finalUrl: "https://exemple.fr/",
		title: "Accueil",
		warnings: [],
		results: [],
		error: null,
		...p,
	})) as AuditReport["pages"],
});

const sample = report([
	{
		url: "https://exemple.fr/",
		results: [
			result("image-alt", "non-conformite", ["1.1"], 3),
			result("input-image-alt", "non-conformite", ["1.1"], 1),
			result("color-contrast", "non-conformite", ["3.2"], 2),
			result("region", "incertain", ["9.2"], 4),
			result("aria-hidden-focus", "a-verifier", ["7.1", "10.8"]),
		],
	},
	{
		url: "https://***:***@exemple.fr/contact#haut",
		title: "Contact",
		results: [result("label", "non-conformite", ["11.1"])],
	},
	{ url: "https://exemple.fr/absente", title: null, finalUrl: null, error: "HTTP 404" },
]);

const parse = (value: unknown) => parseAuditReport(JSON.parse(JSON.stringify(value)), known);
const run = (session = createSession(NOW), value: unknown = sample) =>
	importAutomaticResults(session, parse(value), LATER, ids());

describe("parseAuditReport : validation stricte (ADR-0014 §4)", () => {
	it("accepte un rapport valide et n'en garde que les champs utiles, adresses normalisées", () => {
		const r = parse(sample);
		expect(r.site).toBe("https://exemple.fr");
		expect(r.pages.map((p) => p.url)).toEqual([
			"https://exemple.fr/",
			"https://exemple.fr/contact",
			"https://exemple.fr/absente",
		]);
		expect(r.pages[0]?.results[0]).toEqual({
			ruleId: "image-alt",
			help: "Help for image-alt",
			kind: "non-conformite",
			impact: "serious",
			nodes: 3,
			criteria: ["1.1"],
		});
		expect(r.pages[2]).toMatchObject({ title: "", error: "HTTP 404" });
	});

	it("ignore les propriétés inconnues ; accepte un rapport sans `help` (fichier plus ancien)", () => {
		const { help: _, ...old } = result("image-alt", "non-conformite", ["1.1"]);
		const r = parse({ ...report([{ results: [{ ...old, extra: { x: 1 } }] }]), inconnu: true });
		expect(r.pages[0]?.results[0]).not.toHaveProperty("help");
	});

	it("retire les caractères de contrôle et bidi des textes", () => {
		const r = parse(report([{ title: "Acc‮ueil\u0007", results: [{ ...result("x", "incertain", []), help: "a⁦b\n" }] }]));
		expect(r.pages[0]?.title).toBe("Accueil");
		expect(r.pages[0]?.results[0]?.help).toBe("ab");
	});

	const tenMegabytes = "x".repeat(10 * 1024 * 1024);
	it.each([
		["une racine qui n'est pas un objet", [], /fichier : objet attendu/],
		["schemaVersion 1", { ...sample, schemaVersion: 1 }, /schemaVersion : version 1 non prise en charge/],
		["schemaVersion 3", { ...sample, schemaVersion: 3 }, /schemaVersion : version 3/],
		["schemaVersion absent", { ...sample, schemaVersion: undefined }, /version absente/],
		["un autre outil", { ...sample, tool: { name: "autre", version: "1" } }, /tool\.name : .*CLI Rampe/],
		[
			"un critère inexistant 99.1",
			report([{ results: [result("x", "incertain", ["99.1"])] }]),
			/criteria\[0\] : critère "99\.1" inexistant/,
		],
		[
			"un critère qui n'est pas un texte",
			report([{ results: [{ ...result("x", "incertain", []), criteria: [1.1] }] }]),
			/critère 1\.1 inexistant/,
		],
		["une URL javascript:", report([{ url: "javascript:alert(1)" }]), /pages\[0\]\.url : Seules les adresses http/],
		["une URL file:", report([{ url: "file:///etc/passwd" }]), /pages\[0\]\.url/],
		[
			"une classe inconnue",
			report([{ results: [result("x", "certain" as never, ["1.1"])] }]),
			/kind : classe inconnue "certain"/,
		],
		["un titre de 10 Mo", report([{ title: tenMegabytes }]), /pages\[0\]\.title : texte de plus de 2000 caractères/],
		[
			"un help de 10 Mo",
			report([{ results: [{ ...result("x", "incertain", []), help: tenMegabytes }] }]),
			/help : texte de plus/,
		],
		[
			"un identifiant de règle mal formé",
			report([{ results: [result("<img onerror>", "incertain", [])] }]),
			/ruleId : identifiant/,
		],
		[
			"un impact inconnu",
			report([{ results: [{ ...result("x", "incertain", []), impact: "fatal" }] }]),
			/impact inconnu/,
		],
		[
			"des nœuds qui ne sont pas une liste",
			report([{ results: [{ ...result("x", "incertain", []), nodes: 3 }] }]),
			/nodes : liste attendue/,
		],
		[
			"deux sites",
			report([{}, { url: "https://autre.fr/" }]),
			/pages\[1\]\.url : autre site que https:\/\/exemple\.fr/,
		],
		["aucune page", report([]), /aucune page/],
		["un titre qui n'est pas un texte", report([{ title: 42 as never }]), /title : texte attendu/],
	])("rejette %s, avec le premier défaut dans le message", (_, value, message) => {
		expect(() => parse(value)).toThrow(message);
		expect(() => parse(value)).toThrow(/^Fichier refusé, rien n’a été importé\./);
	});

	it.each([
		["__proto__", `{"schemaVersion":2,"tool":{"name":"@rampe/cli"},"pages":[{"__proto__":{"isAdmin":true}}]}`],
		["constructor", `{"constructor":{"prototype":{}},"schemaVersion":2}`],
		["prototype", `{"schemaVersion":2,"tool":{"name":"@rampe/cli","prototype":1},"pages":[]}`],
	])("rejette une clé %s, où qu'elle soit", (key, json) => {
		expect(() => parseAuditReport(JSON.parse(json), known)).toThrow(`clé interdite « ${key} »`);
	});

	it("rejette une imbrication anormale sans épuiser la pile", () => {
		expect(() => parseAuditReport(JSON.parse(`${"[".repeat(5000)}${"]".repeat(5000)}`), known)).toThrow(
			/structure trop profonde/,
		);
	});

	it("le message d'erreur reste borné, même face à une valeur énorme", () => {
		const huge = report([{ results: [result("x", "a-verifier", [tenMegabytes.slice(0, 1_000_000)])] }]);
		expect(() => parse(huge)).toThrow();
		try {
			parse(huge);
		} catch (e) {
			expect((e as Error).message.length).toBeLessThanOrEqual(500);
		}
	});
});

describe("importAutomaticResults (ADR-0014 §1-3)", () => {
	it("ajoute les pages absentes, fixe NC (source auto, note générée) et range les indices", () => {
		const { session, summary } = run();
		expect(session.site).toBe("https://exemple.fr");
		expect(session.pages.map((p) => [p.url, p.title])).toEqual([
			["https://exemple.fr/", "Accueil"],
			["https://exemple.fr/contact", "Contact"],
		]);
		const [home, contact] = session.pages.map((p) => p.id) as [string, string];
		expect(getEvaluation(session, "1.1", home)).toEqual({
			status: "NC",
			note: "Détecté automatiquement : image-alt (3 éléments), input-image-alt (1 élément)",
			source: "auto",
		});
		expect(getEvaluation(session, "3.2", home)).toMatchObject({ status: "NC", source: "auto" });
		expect(getEvaluation(session, "11.1", contact)).toMatchObject({ status: "NC", source: "auto" });
		// Les autres classes ne fixent aucun statut (ADR-0014 §2).
		for (const c of ["9.2", "7.1", "10.8"]) expect(getEvaluation(session, c, home).status).toBe("NT");
		expect(getFindings(session, "9.2", home)).toEqual([
			{ ruleId: "region", kind: "incertain", nodes: 4, impact: "serious", help: "Help for region" },
		]);
		expect(getFindings(session, "10.8", home).map((f) => f.kind)).toEqual(["a-verifier"]);
		expect(getFindings(session, "1.1", home).map((f) => f.ruleId)).toEqual(["image-alt", "input-image-alt"]);
		expect(summary).toEqual({
			pagesAdded: 2,
			statusesSet: 4 - 1, // 1.1 et 3.2 sur l'accueil, 11.1 sur le contact
			findingsAdded: 7,
			pagesSkipped: [{ url: "https://exemple.fr/absente", reason: "HTTP 404" }],
		});
		expect(session.updatedAt).toBe(LATER);
	});

	it("ne modifie jamais une évaluation humaine, même « non testé » avec une note", () => {
		let s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "Ma page" }, NOW, A);
		s = setEvaluation(s, "1.1", A, { status: "C", note: "alternatives vérifiées" }, NOW);
		s = setEvaluation(s, "3.2", A, { note: "à revoir avec le graphiste" }, NOW);
		const { session, summary } = run(s);
		expect(getEvaluation(session, "1.1", A)).toEqual({ status: "C", note: "alternatives vérifiées", source: "humain" });
		expect(getEvaluation(session, "3.2", A)).toEqual({
			status: "NT",
			note: "à revoir avec le graphiste",
			source: "humain",
		});
		// La non-conformité reste visible comme indice, à côté de l'évaluation humaine.
		expect(getFindings(session, "1.1", A).map((f) => f.ruleId)).toEqual(["image-alt", "input-image-alt"]);
		expect(session.pages[0]?.title).toBe("Ma page");
		expect(summary.statusesSet).toBe(1); // 11.1 sur la page contact, ajoutée
	});

	it("rapproche les pages par adresse normalisée (fragment, identifiants)", () => {
		const s = addPage(createSession(NOW), { url: "https://exemple.fr/contact#formulaire", title: "C" }, NOW, A);
		const { session, summary } = run(s);
		expect(summary.pagesAdded).toBe(1);
		expect(getEvaluation(session, "11.1", A)).toMatchObject({ status: "NC", source: "auto" });
	});

	it("réimporter le même fichier ne duplique ni pages ni indices, et ne touche à rien", () => {
		const once = run();
		const twice = importAutomaticResults(once.session, parse(sample), "2026-10-16T00:00:00.000Z", ids());
		expect({ ...twice.session, updatedAt: LATER }).toEqual(once.session);
		expect(twice.summary).toEqual({
			pagesAdded: 0,
			statusesSet: 0,
			findingsAdded: 0,
			pagesSkipped: once.summary.pagesSkipped,
		});
	});

	it("un statut automatique confirmé ou modifié par l'humain n'est plus touché par un import suivant", () => {
		const { session } = run();
		const home = session.pages[0]?.id ?? "";
		const confirmed = setEvaluation(session, "1.1", home, { status: "C" }, LATER);
		const again = importAutomaticResults(confirmed, parse(sample), LATER, ids()).session;
		expect(getEvaluation(again, "1.1", home)).toMatchObject({ status: "C", source: "humain" });
	});

	it("refuse un rapport d'un autre site, sans modifier la session", () => {
		const s = addPage(createSession(NOW), { url: "https://autre.fr/", title: "" }, NOW, A);
		const frozen = JSON.stringify(s);
		expect(() => run(s)).toThrow(
			/porte sur https:\/\/exemple\.fr, mais l’audit en cours porte sur https:\/\/autre\.fr/,
		);
		expect(JSON.stringify(s)).toBe(frozen);
	});

	it("ne modifie jamais la session reçue", () => {
		const s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "" }, NOW, A);
		const frozen = JSON.stringify(s);
		run(s);
		expect(JSON.stringify(s)).toBe(frozen);
	});

	it("un résultat sans critère (bonne pratique hors RGAA) n'est rangé nulle part", () => {
		const { session, summary } = run(
			createSession(NOW),
			report([{ results: [result("landmark-one-main", "bonne-pratique", [])] }]),
		);
		expect(summary.findingsAdded).toBe(0);
		expect(session.findings).toEqual({});
		expect(summary.pagesAdded).toBe(1);
	});
});
