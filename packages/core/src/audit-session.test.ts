import { describe, expect, it } from "vitest";
import {
	addPage,
	createSession,
	getEvaluation,
	getFindings,
	parseSession,
	progress,
	removePage,
	SCHEMA_VERSION,
	setEvaluation,
} from "./audit-session.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const LATER = "2026-10-15T11:00:00.000Z";
const criteria = [
	{ id: "1.1", topic: 1 },
	{ id: "1.2", topic: 1 },
	{ id: "2.1", topic: 2 },
];

const withTwoPages = () => {
	let s = createSession(NOW);
	s = addPage(s, { url: "https://exemple.fr/", title: "Accueil" }, NOW, A);
	s = addPage(s, { url: "https://exemple.fr/contact", title: "Contact" }, NOW, B);
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
			findings: {},
		});
	});
});

describe("addPage / removePage", () => {
	it("ajoute une page avec un id stable, et fixe le site sur l'origine de la première page", () => {
		const s = withTwoPages();
		expect(s.site).toBe("https://exemple.fr");
		expect(s.pages.map((p) => p.id)).toEqual([A, B]);
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
		addPage(s, { url: "https://exemple.fr/", title: "x" }, LATER, A);
		expect(JSON.stringify(s)).toBe(frozen);
	});

	it("retirer une page supprime ses évaluations, sans toucher aux autres ni décaler les ids", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", A, { status: "NC", note: "alt manquant" }, NOW);
		s = setEvaluation(s, "1.1", B, { status: "C" }, NOW);
		s = removePage(s, A, LATER);
		expect(s.pages.map((p) => p.id)).toEqual([B]);
		expect(s.evaluations).toEqual({ "1.1": { [B]: { status: "C", note: "", source: "humain" } } });
		expect(s.updatedAt).toBe(LATER);
	});
});

describe("setEvaluation / getEvaluation", () => {
	it("une évaluation absente vaut « non testé » : jamais confondu avec conforme", () => {
		expect(getEvaluation(withTwoPages(), "1.1", A)).toEqual({ status: "NT", note: "", source: "humain" });
	});

	it("fixe le statut et la note séparément, et date la modification", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", A, { status: "NA" }, NOW);
		s = setEvaluation(s, "1.1", A, { note: "pas d'image" }, LATER);
		expect(getEvaluation(s, "1.1", A)).toEqual({ status: "NA", note: "pas d'image", source: "humain" });
		expect(s.updatedAt).toBe(LATER);
	});

	it("refuse une page inconnue", () => {
		expect(() => setEvaluation(withTwoPages(), "1.1", "z", { status: "C" })).toThrow(/page inconnue/);
	});
});

describe("progress", () => {
	it("compte les évaluations non testées restantes par critère, thématique et au total", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", A, { status: "C" }, NOW);
		s = setEvaluation(s, "1.1", B, { status: "NC" }, NOW);
		s = setEvaluation(s, "2.1", A, { status: "NA" }, NOW);
		s = setEvaluation(s, "2.1", B, { note: "à revoir" }, NOW); // note seule : reste non testé
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

describe("revue : robustesse du modèle", () => {
	it("refuse une évaluation sur un critère qui n'a pas la forme d'un critère RGAA", () => {
		for (const id of ["toString", "__proto__", "constructor", "1", "1.1.1", "0.1", "abc"])
			expect(() => setEvaluation(withTwoPages(), id, A, { status: "C" }), id).toThrow(/critère inconnu/);
	});

	it("ne lit jamais une propriété héritée d'Object.prototype", () => {
		const s = withTwoPages();
		expect(getEvaluation(s, "toString", A)).toEqual({ status: "NT", note: "", source: "humain" });
		expect(getEvaluation(s, "1.1", "toString")).toEqual({ status: "NT", note: "", source: "humain" });
		expect(getEvaluation(s, "1.1", "__proto__")).toEqual({ status: "NT", note: "", source: "humain" });
	});

	it("n'accepte que des ids de page au format UUID", () => {
		for (const id of ["toString", "__proto__", "a", ""])
			expect(() => addPage(createSession(NOW), { url: "https://exemple.fr/", title: "" }, NOW, id), id).toThrow(
				/Id de page invalide/,
			);
	});

	it("retirer la dernière page remet le site à vide", () => {
		let s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "" }, NOW, A);
		s = removePage(s, A, LATER);
		expect(s.site).toBe("");
		expect(s.pages).toEqual([]);
		s = addPage(s, { url: "https://autre.fr/", title: "" }, LATER, B);
		expect(s.site).toBe("https://autre.fr");
	});

	it("l'avancement suit le retrait d'une page", () => {
		let s = withTwoPages();
		s = setEvaluation(s, "1.1", A, { status: "C" }, NOW);
		s = removePage(s, B, LATER);
		const p = progress(s, criteria);
		expect(p.total).toEqual({ remaining: 2, total: 3 });
		expect(p.byCriterion["1.1"]).toEqual({ remaining: 0, total: 1 });
		expect(progress(removePage(s, A), criteria).total).toEqual({ remaining: 0, total: 0 });
	});

	it("retire les contrôles bidi du nom de page et de la note", () => {
		let s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "Acc\u202eueil" }, NOW, A);
		s = setEvaluation(s, "1.1", A, { note: "a\u2066b\u2069c" }, NOW);
		expect(s.pages[0]?.title).toBe("Accueil");
		expect(getEvaluation(s, "1.1", A).note).toBe("abc");
	});
});

describe("parseSession (relecture du stockage local)", () => {
	it("relit une session valide", () => {
		const s = setEvaluation(withTwoPages(), "1.1", A, { status: "C", note: "ok" }, NOW);
		expect(parseSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});

	it.each([
		["null", null],
		["un tableau", []],
		["une autre version", { ...createSession(NOW), schemaVersion: 99 }],
		["une version 3", { ...createSession(NOW), schemaVersion: 3 }],
		[
			"une source inconnue",
			{ ...withTwoPages(), evaluations: { "1.1": { [A]: { status: "C", note: "", source: "robot" } } } },
		],
		["des indices absents (v2)", { ...withTwoPages(), findings: undefined }],
		[
			"un indice de classe inconnue",
			{ ...withTwoPages(), findings: { "1.1": { [A]: [{ ruleId: "image-alt", kind: "inconnu", nodes: 1 }] } } },
		],
		[
			"un indice sur une page absente",
			{
				...withTwoPages(),
				findings: { "1.1": { [B.replace("b", "c")]: [{ ruleId: "x", kind: "incertain", nodes: 1 }] } },
			},
		],
		["des pages mal formées", { ...createSession(NOW), pages: [{ id: 1, url: "x", title: "" }] }],
		["un statut inconnu", { ...withTwoPages(), evaluations: { "1.1": { [A]: { status: "OK", note: "" } } } }],
		[
			"une évaluation sur une page absente",
			{ ...withTwoPages(), evaluations: { "1.1": { [B.replace("b", "c")]: { status: "C", note: "" } } } },
		],
		[
			"des ids de page en double",
			{
				...createSession(NOW),
				pages: [
					{ id: A, url: "u", title: "" },
					{ id: A, url: "v", title: "" },
				],
			},
		],
		[
			"un id de page qui n'est pas un UUID",
			{ ...createSession(NOW), pages: [{ id: "toString", url: "u", title: "" }] },
		],
		[
			"une clé __proto__ dans les évaluations",
			JSON.parse(
				`{"schemaVersion":2,"site":"","createdAt":"","updatedAt":"","pages":[],"evaluations":{"__proto__":{}},"findings":{}}`,
			),
		],
		["un critère mal formé", { ...withTwoPages(), evaluations: { toString: { [A]: { status: "C", note: "" } } } }],
	])("rejette %s", (_, value) => {
		expect(parseSession(value)).toBeNull();
	});

	it("migre une session v1 sans perte : évaluations humaines, aucun indice", () => {
		const v1 = {
			schemaVersion: 1,
			site: "https://exemple.fr",
			createdAt: NOW,
			updatedAt: LATER,
			pages: [{ id: A, url: "https://exemple.fr/", title: "Accueil", process: "Commande" }],
			evaluations: { "1.1": { [A]: { status: "NC", note: "logo" } }, "2.1": { [A]: { status: "NT", note: "à voir" } } },
		};
		expect(parseSession(JSON.parse(JSON.stringify(v1)))).toEqual({
			...v1,
			schemaVersion: 2,
			evaluations: {
				"1.1": { [A]: { status: "NC", note: "logo", source: "humain" } },
				"2.1": { [A]: { status: "NT", note: "à voir", source: "humain" } },
			},
			findings: {},
		});
	});

	it("rejette une session v1 abîmée (clé __proto__, critère mal formé)", () => {
		const base = `"schemaVersion":1,"site":"","createdAt":"","updatedAt":"","pages":[]`;
		expect(parseSession(JSON.parse(`{${base},"evaluations":{"__proto__":{}}}`))).toBeNull();
		expect(parseSession(JSON.parse(`{${base},"evaluations":{"toString":{}}}`))).toBeNull();
	});
});

describe("source et indices (ADR-0014)", () => {
	it("toute saisie humaine, même une note seule, passe la source à humain", () => {
		let s = setEvaluation(withTwoPages(), "1.1", A, { status: "NC", note: "auto", source: "auto" }, NOW);
		expect(getEvaluation(s, "1.1", A).source).toBe("auto");
		s = setEvaluation(s, "1.1", A, { note: "vérifié" }, NOW);
		expect(getEvaluation(s, "1.1", A)).toEqual({ status: "NC", note: "vérifié", source: "humain" });
	});

	it("retirer une page retire ses indices", () => {
		const s = {
			...withTwoPages(),
			findings: {
				"1.1": {
					[A]: [{ ruleId: "image-alt", kind: "incertain" as const, nodes: 1 }],
					[B]: [{ ruleId: "image-alt", kind: "incertain" as const, nodes: 2 }],
				},
			},
		};
		expect(removePage(s, A).findings).toEqual({ "1.1": { [B]: s.findings["1.1"][B] } });
		expect(getFindings(s, "1.1", B)).toHaveLength(1);
		expect(getFindings(s, "toString", B)).toEqual([]);
		expect(parseSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});
});
