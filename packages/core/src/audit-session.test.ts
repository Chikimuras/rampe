import { describe, expect, it } from "vitest";
import {
	addPage,
	createSession,
	getEvaluation,
	parseSession,
	progress,
	removePage,
	SCHEMA_VERSION,
	setEvaluation,
} from "./audit-session.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const LATER = "2026-10-15T11:00:00.000Z";
const criteria = [
	{ id: "1.1", topic: 1 },
	{ id: "1.2", topic: 1 },
	{ id: "2.1", topic: 2 },
];

const withTwoPages = () => {
	let s = createSession(NOW);
	s = addPage(s, { url: "https://exemple.fr/", title: "Accueil" }, NOW, "a");
	s = addPage(s, { url: "https://exemple.fr/contact", title: "Contact" }, NOW, "b");
	return s;
};

describe("createSession", () => {
	it("crée une session vide, versionnée", () => {
		expect(createSession(NOW)).toEqual({
			schemaVersion: SCHEMA_VERSION,
			site: "",
			createdAt: NOW,
			updatedAt: NOW,
			pages: [],
			evaluations: {},
		});
	});
});

describe("addPage / removePage", () => {
	it("ajoute une page avec un id stable, et fixe le site sur l'origine de la première page", () => {
		const s = withTwoPages();
		expect(s.site).toBe("https://exemple.fr");
		expect(s.pages.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("génère un id unique par défaut", () => {
		let s = createSession(NOW);
		s = addPage(s, { url: "https://exemple.fr/", title: "" });
		s = addPage(s, { url: "https://exemple.fr/a", title: "" });
		const [p1, p2] = s.pages;
		expect(p1?.id).toBeTruthy();
		expect(p1?.id).not.toBe(p2?.id);
	});

	it("ne modifie jamais la session reçue", () => {
		const s = createSession(NOW);
		const frozen = JSON.stringify(s);
		addPage(s, { url: "https://exemple.fr/", title: "x" }, LATER, "a");
		expect(JSON.stringify(s)).toBe(frozen);
	});

	it("retirer une page supprime ses évaluations, sans toucher aux autres ni décaler les ids", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", "a", { status: "NC", note: "alt manquant" }, NOW);
		s = setEvaluation(s, "1.1", "b", { status: "C" }, NOW);
		s = removePage(s, "a", LATER);
		expect(s.pages.map((p) => p.id)).toEqual(["b"]);
		expect(s.evaluations).toEqual({ "1.1": { b: { status: "C", note: "" } } });
		expect(s.updatedAt).toBe(LATER);
	});
});

describe("setEvaluation / getEvaluation", () => {
	it("une évaluation absente vaut « non testé » : jamais confondu avec conforme", () => {
		expect(getEvaluation(withTwoPages(), "1.1", "a")).toEqual({ status: "NT", note: "" });
	});

	it("fixe le statut et la note séparément, et date la modification", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", "a", { status: "NA" }, NOW);
		s = setEvaluation(s, "1.1", "a", { note: "pas d'image" }, LATER);
		expect(getEvaluation(s, "1.1", "a")).toEqual({ status: "NA", note: "pas d'image" });
		expect(s.updatedAt).toBe(LATER);
	});

	it("refuse une page inconnue", () => {
		expect(() => setEvaluation(withTwoPages(), "1.1", "z", { status: "C" })).toThrow(/page inconnue/);
	});
});

describe("progress", () => {
	it("compte les évaluations non testées restantes par critère, thématique et au total", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", "a", { status: "C" }, NOW);
		s = setEvaluation(s, "1.1", "b", { status: "NC" }, NOW);
		s = setEvaluation(s, "2.1", "a", { status: "NA" }, NOW);
		s = setEvaluation(s, "2.1", "b", { note: "à revoir" }, NOW); // note seule : reste non testé
		const p = progress(s, criteria);
		expect(p.total).toEqual({ remaining: 3, total: 6 });
		expect(p.byTopic).toEqual({ 1: { remaining: 2, total: 4 }, 2: { remaining: 1, total: 2 } });
		expect(p.byCriterion["1.1"]).toEqual({ remaining: 0, total: 2 });
		expect(p.byCriterion["1.2"]).toEqual({ remaining: 2, total: 2 });
	});

	it("sans page, rien à évaluer", () => {
		expect(progress(createSession(NOW), criteria).total).toEqual({ remaining: 0, total: 0 });
	});
});

describe("parseSession (relecture du stockage local)", () => {
	it("relit une session valide", () => {
		const s = setEvaluation(withTwoPages(), "1.1", "a", { status: "C", note: "ok" }, NOW);
		expect(parseSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});

	it.each([
		["null", null],
		["un tableau", []],
		["une autre version", { ...createSession(NOW), schemaVersion: 99 }],
		["des pages mal formées", { ...createSession(NOW), pages: [{ id: 1, url: "x", title: "" }] }],
		["un statut inconnu", { ...withTwoPages(), evaluations: { "1.1": { a: { status: "OK", note: "" } } } }],
		[
			"une évaluation sur une page absente",
			{ ...withTwoPages(), evaluations: { "1.1": { z: { status: "C", note: "" } } } },
		],
		[
			"des ids de page en double",
			{
				...createSession(NOW),
				pages: [
					{ id: "a", url: "u", title: "" },
					{ id: "a", url: "v", title: "" },
				],
			},
		],
	])("rejette %s", (_, value) => {
		expect(parseSession(value)).toBeNull();
	});
});
