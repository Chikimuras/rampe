import { describe, expect, it } from "vitest";
import mainV2 from "../test/fixtures/session-main-v2-limites.json" with { type: "json" };
import v1Limits from "../test/fixtures/session-v1-limites.json" with { type: "json" };
import { importAutomaticResults, MAX_REPORT_BYTES, parseAuditReport } from "./audit-report.ts";
import {
	type AuditSession,
	addPage,
	createSession,
	type DeclarationField,
	evaluatedByNotice,
	FUTURE_SESSION,
	getEvaluation,
	getFindings,
	INVALID_SESSION,
	isFutureSession,
	MAX_EVALUATOR_NAME,
	MAX_SESSION_BYTES,
	parseSessionStrict,
	parseStoredSession,
	progress,
	REPORT_GIVEN_AS_SESSION,
	removePage,
	SCHEMA_VERSION,
	SESSION_TOOL_NAME,
	serializeSession,
	sessionFileName,
	setDeclarationField,
	setEvaluatedBy,
	setEvaluation,
	setPageProcess,
	takeOverAudit,
} from "./audit-session.ts";
import { rgaa } from "./rgaa.ts";
import { truncate } from "./sample-file.ts";
import { ReportError } from "./strict.ts";

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

describe("setPageProcess", () => {
	it("nomme le processus d'une page, retire les contrôles bidi, et l'efface si vide", () => {
		let s = setPageProcess(withTwoPages(), A, "Commande \u202e", LATER);
		expect(s.pages[0]?.process).toBe("Commande ");
		expect(s.pages[1]?.process).toBeUndefined();
		expect(s.updatedAt).toBe(LATER);
		s = setPageProcess(s, A, "");
		expect(s.pages[0]).not.toHaveProperty("process");
		expect(() => setPageProcess(s, "inconnue", "x")).toThrow("Page inconnue");
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
		expect(p.total).toEqual({ remaining: 3, toConfirm: 0, total: 6 });
		expect(p.byTopic).toEqual({
			1: { remaining: 2, toConfirm: 0, total: 4 },
			2: { remaining: 1, toConfirm: 0, total: 2 },
		});
		expect(p.byCriterion["1.1"]).toEqual({ remaining: 0, toConfirm: 0, total: 2 });
		expect(p.byCriterion["1.2"]).toEqual({ remaining: 2, toConfirm: 0, total: 2 });
	});

	it("sans page, rien à évaluer", () => {
		expect(progress(createSession(NOW), criteria).total).toEqual({ remaining: 0, toConfirm: 0, total: 0 });
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
		expect(p.total).toEqual({ remaining: 2, toConfirm: 0, total: 3 });
		expect(p.byCriterion["1.1"]).toEqual({ remaining: 0, toConfirm: 0, total: 1 });
		expect(progress(removePage(s, A), criteria).total).toEqual({ remaining: 0, toConfirm: 0, total: 0 });
	});

	it("retire aussi les marques de direction U+200E, U+200F et U+061C", () => {
		const s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "a\u200eb\u200fc\u061cd" }, NOW, A);
		expect(s.pages[0]?.title).toBe("abcd");
	});

	it("retire les contrôles bidi du nom de page et de la note", () => {
		let s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "Acc\u202eueil" }, NOW, A);
		s = setEvaluation(s, "1.1", A, { note: "a\u2066b\u2069c" }, NOW);
		expect(s.pages[0]?.title).toBe("Accueil");
		expect(getEvaluation(s, "1.1", A).note).toBe("abc");
	});
});

const known = new Set(rgaa.criteria.map((c) => c.id));
const parse = (value: unknown) => parseSessionStrict(value, known);
/** Erreur levée par `parse`, pour en vérifier le message et le détail. */
function refusal(value: unknown): ReportError {
	try {
		parse(value);
	} catch (e) {
		if (e instanceof ReportError) return e;
		throw e;
	}
	throw new Error("session acceptée");
}
/** Une session v2 complète : processus, évaluation automatique, note sur plusieurs lignes, indices. */
const full = (): AuditSession => {
	let s = setPageProcess(withTwoPages(), B, "Commande", NOW);
	s = setEvaluation(s, "1.1", A, { status: "C", note: "Logo :\n\talternative « Rampe »" }, NOW);
	s = setEvaluation(s, "3.2", B, { status: "NC", note: "Détecté automatiquement : x", source: "auto" }, NOW);
	return {
		...s,
		exportedAt: LATER,
		findings: {
			"1.1": {
				[A]: [
					{ ruleId: "image-alt", kind: "non-conformite", nodes: 3, impact: "critical", help: "Images must have alt" },
					{ ruleId: "region", kind: "bonne-pratique", nodes: 1 },
				],
			},
		},
	};
};
/** Fichier exporté puis relu comme le ferait le navigateur. */
const exported = (s: AuditSession = full()) => JSON.parse(serializeSession(s));

describe("export et import d'un audit (ADR-0016)", () => {
	it("aller-retour export → import : session identique", () => {
		const s = full();
		const file = exported(s);
		expect(file.schemaVersion).toBe(SCHEMA_VERSION);
		expect(file.tool).toEqual({ name: SESSION_TOOL_NAME });
		expect(parse(file)).toEqual(s);
		// Session vide, et relecture du stockage local écrit par une version précédente (sans `tool`).
		expect(parse(exported(createSession(NOW)))).toEqual(createSession(NOW));
		const { tool: _tool, ...stored } = file;
		expect(parse(stored)).toEqual(s);
	});

	it("idempotent sur les textes déjà tronqués par l'import de la CLI", () => {
		const title = `${"x".repeat(300)}… (tronqué)`;
		const s = { ...full(), pages: full().pages.map((p) => ({ ...p, title })) };
		expect(parse(exported(s))).toEqual(s);
	});

	it("nom de fichier : audit-<hôte>-<AAAA-MM-JJ>.json, date locale", () => {
		const date = new Date(2026, 9, 5, 23, 59);
		expect(sessionFileName(full(), date)).toBe("audit-exemple.fr-2026-10-05.json");
		expect(sessionFileName({ ...full(), site: "http://127.0.0.1:4321" }, date)).toBe("audit-127.0.0.1-2026-10-05.json");
		expect(sessionFileName({ ...full(), site: "http://[::1]:80" }, date)).toBe("audit-1-2026-10-05.json");
		expect(sessionFileName(createSession(NOW), date)).toBe("audit-sans-site-2026-10-05.json");
	});

	// Chaque cas : fichier exporté puis abîmé ; le message est clair, le détail nomme le premier défaut.
	const page = (patch: Record<string, unknown>) => {
		const f = exported();
		f.pages[0] = { ...f.pages[0], ...patch };
		return f;
	};
	const evaluation = (patch: Record<string, unknown>) => {
		const f = exported();
		f.evaluations["1.1"][A] = { ...f.evaluations["1.1"][A], ...patch };
		return f;
	};
	const finding = (patch: Record<string, unknown>) => {
		const f = exported();
		f.findings["1.1"][A][0] = { ...f.findings["1.1"][A][0], ...patch };
		return f;
	};
	const deep = (key: string) =>
		JSON.parse(serializeSession(full()).replace('"ruleId":"region"', `"${key}":{"polluted":true},"ruleId":"region"`));
	it.each<[string, unknown, RegExp]>([
		[
			"__proto__ à la racine",
			JSON.parse(`{"__proto__":{"x":1},${serializeSession(full()).slice(1)}`),
			/^fichier : clé interdite « __proto__ »/,
		],
		["__proto__ dans un indice", deep("__proto__"), /^fichier\.findings\.1\.1\..+\.1 : clé interdite « __proto__ »/],
		["constructor en profondeur", deep("constructor"), /clé interdite « constructor »/],
		["prototype en profondeur", deep("prototype"), /clé interdite « prototype »/],
		[
			"un critère inexistant",
			(() => {
				const f = exported();
				f.evaluations["99.1"] = f.evaluations["1.1"];
				return f;
			})(),
			/^evaluations : critère "99\.1" inexistant dans le référentiel/,
		],
		[
			"un indice sous un critère inexistant",
			(() => {
				const f = exported();
				f.findings["14.1"] = f.findings["1.1"];
				return f;
			})(),
			/^findings : critère "14\.1" inexistant/,
		],
		["un id de page non UUID", page({ id: "toString" }), /^pages\[0\]\.id : identifiant de page qui n’est pas un UUID/],
		["un id de page en double", page({ id: B }), /^pages\[1\]\.id : identifiant de page en double/],
		["une URL javascript:", page({ url: "javascript:alert(1)" }), /^pages\[0\]\.url : Seules les adresses http/],
		["une URL d'un autre site", page({ url: "https://autre.fr/" }), /^pages\[0\]\.url : autre site/],
		["une URL avec identifiants", page({ url: "https://moi:secret@exemple.fr/" }), /identifiants dans l’adresse/],
		["une URL démesurée", page({ url: `https://exemple.fr/${"a".repeat(3000)}` }), /plus de 2048 caractères/],
		["un processus démesuré", page({ process: "p".repeat(201) }), /^pages\[0\]\.process : processus de plus de 200/],
		["un titre qui n'est pas un texte", page({ title: 42 }), /^pages\[0\]\.title : texte attendu/],
		[
			"un site qui n'est pas une origine",
			{ ...exported(), site: "javascript:alert(1)" },
			/^site : origine http\(s\) attendue/,
		],
		["un statut inconnu", evaluation({ status: "OK" }), /\.status : statut inconnu "OK"/],
		["une source inconnue", evaluation({ source: "robot" }), /\.source : source inconnue "robot"/],
		["une évaluation sans note", evaluation({ note: undefined }), /\.note : texte attendu/],
		[
			"une évaluation sur une page absente",
			(() => {
				const f = exported();
				f.evaluations["2.1"] = { [B.replace("b", "c")]: { status: "C", note: "", source: "humain" } };
				return f;
			})(),
			/^evaluations\.2\.1 : page ".+" absente de l’audit/,
		],
		["un indice de classe inconnue", finding({ kind: "inconnu" }), /\.kind : classe inconnue "inconnu"/],
		["un indice sans nombre d'éléments", finding({ nodes: -1 }), /\.nodes : nombre entier positif attendu/],
		["un indice à l'impact inconnu", finding({ impact: "énorme" }), /\.impact : impact inconnu/],
		["un indice à la règle mal formée", finding({ ruleId: "<img>" }), /\.ruleId : identifiant de règle mal formé/],
		[
			"des indices qui ne sont pas une liste",
			(() => {
				const f = exported();
				f.findings["1.1"][A] = { ruleId: "x" };
				return f;
			})(),
			/liste attendue/,
		],
		["des indices absents (v2)", { ...exported(), findings: undefined }, /^findings : objet attendu/],
		["une date invalide", { ...exported(), createdAt: "hier" }, /^createdAt : date invalide/],
		["un schemaVersion absent", { ...exported(), schemaVersion: undefined }, /^schemaVersion : version absente/],
		["un schemaVersion texte", { ...exported(), schemaVersion: "2" }, /^schemaVersion : version "2"/],
		[
			"un outil étranger",
			{ ...exported(), tool: { name: "autre-outil" } },
			/^tool\.name : ce fichier n’a pas été produit par l’audit guidé/,
		],
		["un outil sans nom", { ...exported(), tool: {} }, /^tool\.name/],
		[
			"une structure trop profonde",
			{ ...exported(), x: JSON.parse(`${"[".repeat(80)}${"]".repeat(80)}`) },
			/structure trop profonde/,
		],
		["null", null, /^fichier : objet attendu/],
		["un tableau", [], /^fichier : objet attendu/],
	])("refuse %s, tout ou rien", (_, value, detail) => {
		const e = refusal(value);
		expect(e.message).toBe(INVALID_SESSION);
		expect(e.detail).toMatch(detail);
		expect(e.detail?.length).toBeLessThanOrEqual(500);
		expect("polluted" in {}).toBe(false);
	});

	it("au-delà de 50 000 indices : refusé", () => {
		const f = exported();
		const list = Array.from({ length: 25_001 }, () => ({ ruleId: "x", kind: "incertain", nodes: 1 }));
		f.findings = { "1.1": { [A]: list, [B]: list } };
		expect(refusal(f).detail).toMatch(/plus de 50.000 indices/);
	});

	it("textes seulement affichés : contrôles et bidi retirés, tronqués plutôt que rejetés", () => {
		const f = exported();
		f.pages[0].title = `‮Accueil\u0007 ${"t".repeat(2000)}`;
		f.evaluations["1.1"][A].note = `ligne 1\n\tligne 2‮\u0000${"n".repeat(20_000)}`;
		f.findings["1.1"][A][0].help = "h".repeat(5000);
		const s = parse(f);
		expect(s.pages[0]?.title).toMatch(/^Accueil t+… \(tronqué\)$/);
		expect(s.pages[0]?.title.length).toBe(1000 + "… (tronqué)".length);
		const note = getEvaluation(s, "1.1", A).note;
		expect(note.startsWith("ligne 1\n\tligne 2n")).toBe(true);
		expect(note.length).toBe(10_000 + "… (tronqué)".length);
		expect(getFindings(s, "1.1", A)[0]?.help).toMatch(/^h{1000}… \(tronqué\)$/);
	});

	it("propriétés inconnues ignorées, objets reconstruits", () => {
		const f = { ...exported(), extra: "x" };
		f.pages[0].extra = 1;
		f.evaluations["1.1"][A].extra = 1;
		expect(parse(f)).toEqual(full());
	});

	it("version future : refus spécifique, distinct d'un fichier abîmé", () => {
		const e = refusal({ ...exported(), schemaVersion: SCHEMA_VERSION + 1 });
		expect(e.message).toBe(FUTURE_SESSION);
		expect(e.message).toMatch(/créé par une version plus récente de Rampe/);
		expect(isFutureSession({ ...exported(), schemaVersion: 99 })).toBe(true);
		for (const corrupt of [null, [], { schemaVersion: "3" }, { schemaVersion: 0 }, { ...createSession(NOW), pages: 1 }])
			expect(isFutureSession(corrupt)).toBe(false);
	});

	it("rapport de la CLI donné au champ de l'audit : message qui oriente vers le bon champ", () => {
		for (const name of ["@rampe/cli", "@rampe/extension"]) {
			const e = refusal({ schemaVersion: 2, tool: { name, version: "0.0.0" }, pages: [] });
			expect(e.message).toBe(REPORT_GIVEN_AS_SESSION);
			expect(e.message).toMatch(/« Importer un rapport automatique \(CLI ou extension, JSON\) »/);
		}
	});

	it("migre une session v1 (stockage d'une ancienne version) sans perte : évaluations humaines, aucun indice", () => {
		const v1 = {
			schemaVersion: 1,
			site: "https://exemple.fr",
			createdAt: NOW,
			updatedAt: LATER,
			pages: [{ id: A, url: "https://exemple.fr/", title: "Accueil", process: "Commande" }],
			evaluations: { "1.1": { [A]: { status: "NC", note: "logo" } }, "2.1": { [A]: { status: "NT", note: "à voir" } } },
		};
		expect(parse(JSON.parse(JSON.stringify(v1)))).toEqual({
			...v1,
			schemaVersion: SCHEMA_VERSION,
			evaluations: {
				"1.1": { [A]: { status: "NC", note: "logo", source: "humain" } },
				"2.1": { [A]: { status: "NT", note: "à voir", source: "humain" } },
			},
			findings: {},
		});
	});

	it("rejette une session v1 abîmée (clé __proto__, critère mal formé)", () => {
		const base = `"schemaVersion":1,"site":"","createdAt":"${NOW}","updatedAt":"${NOW}","pages":[]`;
		expect(refusal(JSON.parse(`{${base},"evaluations":{"__proto__":{}}}`)).detail).toMatch(/__proto__/);
		expect(refusal(JSON.parse(`{${base},"evaluations":{"toString":{}}}`)).detail).toMatch(/"toString" inexistant/);
	});
});

// Sessions écrites par le code de origin/main (58a7058) et de la v1 (3591df6), aux valeurs limites d'avant les
// bornes : adresse de 3 018 caractères, titre de 1 997 (tabulation et espace en bord), note de 12 017 (sauts de ligne),
// processus de 501 (espace final), indices d'un import CLI. Générées par test/fixtures/generer-sessions-limites.mjs.
/** Copie profonde, non typée : les tests y glissent des valeurs abîmées. */
const fixture = (name: "main-v2" | "v1") => JSON.parse(JSON.stringify(name === "v1" ? v1Limits : mainV2));
/** Ids de page des fixtures. */
const FA = "11111111-1111-4111-8111-111111111111";
const stored = (value: unknown, dropped?: DeclarationField[]) => parseStoredSession(value, known, dropped);

describe("relecture du stockage local : structure et types, sans borne ni modification (ADR-0016)", () => {
	it("relit sans perte une session v2 écrite par main aux valeurs limites", () => {
		const raw = fixture("main-v2");
		expect(raw.pages[0].url.length).toBeGreaterThan(3000);
		expect(raw.pages[0].process.length).toBeGreaterThan(500);
		// Migrée en v3 (ADR-0017) : seul le numéro de version change.
		expect(stored(raw)).toEqual({ ...raw, schemaVersion: SCHEMA_VERSION });
		// Le même fichier importé est borné : le relire au stockage ne passe donc pas par parseSessionStrict.
		expect(refusal(raw).detail).toMatch(/^pages\[0\]\.url : adresse de plus de 2048/);
	});

	it("relit sans perte une session v1 aux valeurs limites (migrée, textes inchangés)", () => {
		const raw = fixture("v1");
		const s = stored(raw);
		expect(s.pages).toEqual(raw.pages);
		expect(s.evaluations["1.1"]?.[FA]).toEqual({ ...raw.evaluations["1.1"][FA], source: "humain" });
		expect(getEvaluation(s, "1.1", FA).note.length).toBeGreaterThan(12_000);
		expect(s.findings).toEqual({});
	});

	it("relit 1 001 pages et 60 000 indices (deux imports CLI de 30 000)", () => {
		let s = createSession(NOW);
		const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
		s = {
			...s,
			site: "https://exemple.fr",
			pages: ids.map((id, i) => ({ id, url: `https://exemple.fr/${i}`, title: "" })),
			findings: {
				"1.1": Object.fromEntries(
					ids
						.slice(0, 2)
						.map((id) => [
							id,
							Array.from({ length: 30_000 }, () => ({ ruleId: "x", kind: "incertain" as const, nodes: 1 })),
						]),
				),
			},
		};
		expect(stored(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});

	it("garde les contrôles de structure et de type", () => {
		const raw = fixture("main-v2");
		for (const [broken, detail] of [
			[{ ...raw, pages: [{ ...raw.pages[0], id: "toString" }] }, /UUID/],
			[{ ...raw, pages: [{ ...raw.pages[0], url: "javascript:alert(1)" }] }, /http/],
			[{ ...raw, evaluations: { "99.1": {} } }, /99\.1/],
			[{ ...raw, evaluations: { "1.1": { [FA]: { status: "OK", note: "", source: "humain" } } } }, /statut inconnu/],
			[JSON.parse(JSON.stringify(raw).replace('"pages":', '"__proto__":{},"pages":')), /__proto__/],
		] as const) {
			expect(() => stored(broken), String(detail)).toThrow(ReportError);
			try {
				stored(broken);
			} catch (e) {
				expect((e as ReportError).detail).toMatch(detail);
			}
		}
	});

	it("C2 : une version future est protégée avant tout autre contrôle, même avec un autre tool.name ou une clé interdite", () => {
		const future = JSON.parse(
			`{"__proto__":{},"schemaVersion":${SCHEMA_VERSION + 1},"tool":{"name":"autre"},"pages":"?"}`,
		);
		expect(isFutureSession(future)).toBe(true);
		for (const parseAny of [stored, parse]) {
			expect(() => parseAny(future)).toThrow(FUTURE_SESSION);
			expect(() =>
				parseAny({ ...exported(), schemaVersion: SCHEMA_VERSION + 1, tool: { name: "@rampe/cli" } }),
			).toThrow(FUTURE_SESSION);
		}
	});
});

describe("bornes à l'écriture : tout ce que l'interface produit se réimporte (ADR-0016)", () => {
	const roundTrip = (s: AuditSession) => {
		expect(parse(JSON.parse(serializeSession(s)))).toEqual(s);
		expect(stored(JSON.parse(serializeSession(s)))).toEqual(s);
	};

	it("aux bornes exactes : 1 000 pages, adresse de 2 048, titre de 1 000, note de 10 000, processus de 200", () => {
		let s = createSession(NOW);
		const url = `https://exemple.fr/${"u".repeat(2048 - "https://exemple.fr/".length)}`;
		expect(url.length).toBe(2048);
		s = addPage(s, { url, title: "t".repeat(1000) }, NOW, A);
		for (let i = 1; i < 1000; i++)
			s = addPage(
				s,
				{ url: `https://exemple.fr/${i}`, title: "" },
				NOW,
				`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
			);
		s = setPageProcess(s, A, "p".repeat(200), NOW);
		s = setEvaluation(s, "1.1", A, { status: "NC", note: "n".repeat(10_000) }, NOW);
		roundTrip(s);
		// Au-delà : refusé à l'écriture.
		expect(() => addPage(s, { url: "https://exemple.fr/x", title: "" }, NOW, B)).toThrow(/Plus de 1000 pages/);
		const one = createSession(NOW);
		expect(() => addPage(one, { url: `${url}u`, title: "" }, NOW, A)).toThrow(/Adresse de plus de 2048/);
		expect(() => addPage(one, { url, title: "t".repeat(1001) }, NOW, A)).toThrow(/Nom de page de plus de 1000/);
		expect(() => setPageProcess(s, A, "p".repeat(201), NOW)).toThrow(/Processus de plus de 200/);
		expect(() => setEvaluation(s, "1.1", A, { note: "n".repeat(10_001) }, NOW)).toThrow(/Note de plus de 10000/);
	});

	it("un texte trop long hérité d'une version précédente peut être raccourci, pas allongé", () => {
		const s = stored(fixture("main-v2"));
		const note = getEvaluation(s, "1.1", FA).note;
		expect(() => setEvaluation(s, "1.1", FA, { status: "C" }, LATER)).not.toThrow();
		expect(() => setEvaluation(s, "1.1", FA, { note: note.slice(1) }, LATER)).not.toThrow();
		expect(() => setEvaluation(s, "1.1", FA, { note: `${note}x` }, LATER)).toThrow(/Note de plus de/);
		const process = s.pages[0]?.process ?? "";
		expect(() => setPageProcess(s, FA, process.slice(1), LATER)).not.toThrow();
		expect(() => setPageProcess(s, FA, `${process}x`, LATER)).toThrow(/Processus de plus de/);
	});

	it("aléatoire : sessions produites par les opérations du modèle, textes réalistes (tabulation, bidi en bord, emoji)", () => {
		let seed = 42;
		const rand = (n: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed % n;
		};
		const alphabet = ["a", "É", " ", "\t", "\n", "‮", "⁦", "‏", "😀", "«", "\u0007", "\r", "-"];
		const text = (max: number) => Array.from({ length: rand(max) }, () => alphabet[rand(alphabet.length)]).join("");
		for (let run = 0; run < 200; run++) {
			let s = createSession(NOW);
			const ids: string[] = [];
			for (let i = 0; i < 1 + rand(4); i++) {
				const id = `00000000-0000-4000-8000-${String(run * 10 + i).padStart(12, "0")}`;
				s = addPage(s, { url: `https://exemple.fr/${i}#${text(5)}`, title: text(30) }, NOW, id);
				ids.push(id);
			}
			for (let k = 0; k < 6; k++) {
				const id = ids[rand(ids.length)] as string;
				if (rand(2)) s = setPageProcess(s, id, text(20), LATER);
				else
					s = setEvaluation(
						s,
						["1.1", "3.2", "8.3"][rand(3)] as string,
						id,
						{
							status: (["C", "NC", "NA", "NT"] as const)[rand(4)],
							note: text(40),
						},
						LATER,
					);
			}
			roundTrip(s);
		}
	});

	it("M1 : un nom avec tabulation et bidi en bord est nettoyé dès l'écriture, comme à l'import", () => {
		const s = addPage(createSession(NOW), { url: "https://exemple.fr/", title: "\t‮ Accueil ⁦" }, NOW, A);
		expect(s.pages[0]?.title).toBe("Accueil");
		roundTrip(s);
	});

	it("M2 : à l'import d'un fichier, dates au format toISOString() seulement ; la relecture reste tolérante", () => {
		const f = { ...exported(), createdAt: "2026-10-15" };
		expect(refusal(f).detail).toMatch(/^createdAt : date invalide/);
		expect(stored(f).createdAt).toBe("2026-10-15");
	});
});

describe("contre-relecture de la PR #18", () => {
	it('4 : la relecture du stockage garde `process: ""` tel quel ; l\'import de fichier le retire', () => {
		const raw = fixture("main-v2");
		raw.pages[1].process = "";
		expect(stored(raw)).toEqual({ ...raw, schemaVersion: SCHEMA_VERSION });
		const file = { ...exported(), pages: [{ ...exported().pages[0], process: "" }], evaluations: {}, findings: {} };
		expect(parse(file).pages[0]).not.toHaveProperty("process");
	});

	it("5 : troncature idempotente, coupée sur un point de code ; double import identique", () => {
		const f = exported();
		f.evaluations["1.1"][A].note = `${"n".repeat(9_999)}😀${"x".repeat(50)}`;
		f.pages[0].title = `${"t".repeat(999)}😀 fin`;
		const once = parse(f);
		const note = getEvaluation(once, "1.1", A).note;
		expect(note).toBe(`${"n".repeat(9_999)}… (tronqué)`); // l'emoji n'est pas coupé en deux
		expect(once.pages[0]?.title).toBe(`${"t".repeat(999)}… (tronqué)`);
		expect(parse(JSON.parse(serializeSession(once)))).toEqual(once);
		expect(truncate(note, 10_000)).toBe(note);
	});

	it("6 : invariant aux bornes, 50 imports CLI aux descriptions CJK : le fichier tient dans 64 Mo et se réimporte", () => {
		let n = 0;
		const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
		const criteriaIds = [...known].slice(0, 10);
		const help = "無障礙".repeat(140); // 420 caractères CJK : tronqué à 300 par l'import
		let s = createSession(NOW);
		for (let k = 0; k < 50; k++) {
			const pages = Array.from({ length: 20 }, (_, i) => ({
				url: `https://exemple.fr/${k}-${i}`,
				finalUrl: null,
				title: "頁".repeat(400),
				warnings: [],
				error: null,
				results: ["image-alt", "label", "region", "link-name", "list"].map((ruleId) => ({
					ruleId,
					help,
					kind: "incertain",
					level: "rgaa",
					tests: [],
					criteria: criteriaIds,
					wcag: [],
					flags: { bestPractice: false, experimental: false },
					impact: "serious",
					nodes: [],
				})),
			}));
			const r = parseAuditReport({ schemaVersion: 2, tool: { name: "@rampe/cli", version: "0" }, pages }, known);
			s = importAutomaticResults(s, r, NOW, newId).session;
		}
		expect(s.pages).toHaveLength(1000);
		const text = serializeSession(s);
		const bytes = new TextEncoder().encode(text).length;
		expect(bytes).toBeGreaterThan(MAX_REPORT_BYTES);
		expect(bytes).toBeLessThanOrEqual(MAX_SESSION_BYTES);
		expect(parse(JSON.parse(text))).toEqual(s);
	});
});

describe("source et indices (ADR-0014)", () => {
	const auto = () =>
		setEvaluation(withTwoPages(), "1.1", A, { status: "NC", note: "Détecté automatiquement : x", source: "auto" }, NOW);

	it("« Confirmer » (patch vide) passe la source à humain sans changer statut ni note", () => {
		expect(getEvaluation(setEvaluation(auto(), "1.1", A, {}, LATER), "1.1", A)).toEqual({
			status: "NC",
			note: "Détecté automatiquement : x",
			source: "humain",
		});
	});

	it("changer le statut d'une évaluation automatique vide sa note générée ; une note éditée est gardée", () => {
		expect(getEvaluation(setEvaluation(auto(), "1.1", A, { status: "C" }, LATER), "1.1", A)).toEqual({
			status: "C",
			note: "",
			source: "humain",
		});
		let s = setEvaluation(auto(), "1.1", A, { note: "Détecté automatiquement : x, vérifié" }, LATER);
		s = setEvaluation(s, "1.1", A, { status: "C" }, LATER);
		expect(getEvaluation(s, "1.1", A).note).toBe("Détecté automatiquement : x, vérifié");
	});

	it("progress compte à part les évaluations automatiques à confirmer", () => {
		const p = progress(auto(), criteria);
		expect(p.byCriterion["1.1"]).toEqual({ remaining: 1, toConfirm: 1, total: 2 });
		expect(p.total.toConfirm).toBe(1);
		expect(progress(setEvaluation(auto(), "1.1", A, {}, LATER), criteria).total.toConfirm).toBe(0);
	});

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
		expect(parse(JSON.parse(serializeSession(s)))).toEqual(s);
	});
});

describe("déclaration d’accessibilité dans la session (ADR-0017 §4)", () => {
	const roundTrip = (s: AuditSession) => {
		expect(parse(JSON.parse(serializeSession(s)))).toEqual(s);
		expect(stored(JSON.parse(serializeSession(s)))).toEqual(s);
	};
	const declared = () => {
		let s = full();
		s = setDeclarationField(s, "organization", "Boulangerie Dupont ", LATER);
		s = setDeclarationField(s, "auditBy", "prestataire", LATER);
		s = setDeclarationField(s, "derogations", "Archives PDF\n\tavant 2010", LATER);
		s = setDeclarationField(s, "establishedOn", "2026-10-01", LATER);
		return setDeclarationField(s, "contactFormUrl", "contact@exemple.fr", LATER);
	};

	it("saisie rangée dans la session, datée ; une valeur vide retire le champ, puis la déclaration", () => {
		const s = declared();
		expect(s.declaration).toEqual({
			organization: "Boulangerie Dupont ",
			auditBy: "prestataire",
			derogations: "Archives PDF\n\tavant 2010",
			establishedOn: "2026-10-01",
			contactFormUrl: "contact@exemple.fr",
		});
		expect(s.updatedAt).toBe(LATER);
		let empty = s;
		for (const key of Object.keys(s.declaration ?? {}) as DeclarationField[])
			empty = setDeclarationField(empty, key, "", LATER);
		expect(empty).not.toHaveProperty("declaration");
		expect(createSession(NOW)).not.toHaveProperty("declaration");
	});

	it("nettoyée à l'écriture : contrôles et bidi retirés ; sauts de ligne gardés seulement dans les listes", () => {
		let s = setDeclarationField(full(), "serviceName", "‮site\u0007\nweb⁦", LATER);
		s = setDeclarationField(s, "technologies", "HTML\r\n‮CSS\u0000", LATER);
		expect(s.declaration).toEqual({ serviceName: "siteweb", technologies: "HTML\nCSS" });
	});

	it("bornée à l'écriture, comme le reste (ADR-0016) ; date et réalisation de l'audit vérifiées", () => {
		const s = full();
		expect(() => setDeclarationField(s, "organization", "o".repeat(1000), LATER)).not.toThrow();
		expect(() => setDeclarationField(s, "organization", "o".repeat(1001), LATER)).toThrow(/plus de 1000/);
		expect(() => setDeclarationField(s, "tools", "t".repeat(10_001), LATER)).toThrow(/plus de 10000/);
		expect(() => setDeclarationField(s, "reportUrl", `https://x.fr/${"u".repeat(2048)}`, LATER)).toThrow(
			/plus de 2048/,
		);
		for (const bad of ["2026-02-30", "15/10/2026", "2026-13-01", "demain"])
			expect(() => setDeclarationField(s, "updatedOn", bad, LATER), bad).toThrow(/Date invalide/);
		expect(() => setDeclarationField(s, "auditBy", "moi", LATER)).toThrow(/inconnue/);
		expect(() => setDeclarationField(s, "toString" as DeclarationField, "x", LATER)).toThrow(
			/Champ de déclaration inconnu/,
		);
		// Une adresse en cours de frappe est gardée telle quelle : elle n'est vérifiée qu'au rendu.
		expect(setDeclarationField(s, "contactPageUrl", "exemple.fr/cont", LATER).declaration).toEqual({
			contactPageUrl: "exemple.fr/cont",
		});
	});

	it("exportée et réimportée à l'identique (fichier et stockage local) ; aux bornes exactes aussi", () => {
		roundTrip(declared());
		let s = full();
		s = setDeclarationField(s, "organization", "o".repeat(1000), LATER);
		s = setDeclarationField(s, "tools", "t".repeat(10_000), LATER);
		s = setDeclarationField(s, "reportUrl", `https://x.fr/${"u".repeat(2048 - "https://x.fr/".length)}`, LATER);
		roundTrip(s);
	});

	it("import strict : types, dates, réalisation, adresse bornée ; textes tronqués ; clés inconnues ignorées", () => {
		const f = () => exported(declared());
		for (const [value, detail] of [
			[{ ...f(), declaration: "x" }, /^declaration : objet attendu/],
			[{ ...f(), declaration: { organization: 1 } }, /^declaration\.organization : texte attendu/],
			[{ ...f(), declaration: { updatedOn: "2026-02-30" } }, /^declaration\.updatedOn : date invalide/],
			[{ ...f(), declaration: { auditBy: "moi" } }, /^declaration\.auditBy : valeur inconnue "moi"/],
			[{ ...f(), declaration: { reportUrl: "u".repeat(2049) } }, /^declaration\.reportUrl : adresse de plus de 2048/],
			[JSON.parse(`{"declaration":{"__proto__":{"x":1}}}`), /__proto__/],
		] as const)
			expect(refusal({ ...f(), ...value }).detail, String(detail)).toMatch(detail);
		const g = f();
		g.declaration.organization = `‮Mairie\u0007 ${"m".repeat(2000)}`;
		g.declaration.tools = `ligne 1\n\tligne 2${"t".repeat(20_000)}`;
		g.declaration.inconnu = "x";
		g.declaration.serviceName = "";
		const s = parse(g);
		expect(s.declaration?.organization).toMatch(/^Mairie m+… \(tronqué\)$/);
		expect(s.declaration?.tools?.startsWith("ligne 1\n\tligne 2t")).toBe(true);
		expect(s.declaration?.tools?.length).toBe(10_000 + "… (tronqué)".length);
		expect(s.declaration).not.toHaveProperty("inconnu");
		expect(s.declaration).not.toHaveProperty("serviceName");
		expect(parse({ ...f(), declaration: {} })).not.toHaveProperty("declaration");
	});

	it("relecture du stockage : tolérante, sans borne ni modification", () => {
		const raw = exported(declared());
		raw.declaration.organization = `\t${"o".repeat(5000)}‮`;
		raw.declaration.serviceName = "";
		expect(stored(raw).declaration).toEqual(raw.declaration);
		// Les types et formes restent contrôlés.
		expect(() => stored({ ...raw, declaration: { auditBy: "moi" } })).toThrow(ReportError);
		expect(() => stored({ ...raw, declaration: [] })).toThrow(ReportError);
	});

	it("dates : années 1900 à 9999 seulement, partout ; une saisie en cours (« 0010-10-14 ») est refusée", () => {
		const s = full();
		for (const bad of ["0010-10-14", "0014-10-14", "1899-12-31", "27576-10-14", "+27576-10-14"])
			expect(() => setDeclarationField(s, "updatedOn", bad, LATER), bad).toThrow(/Date invalide/);
		for (const good of ["1900-01-01", "2026-10-14", "9999-12-31"])
			expect(setDeclarationField(s, "updatedOn", good, LATER).declaration?.updatedOn).toBe(good);
		expect(refusal({ ...exported(s), declaration: { updatedOn: "0010-10-14" } }).detail).toMatch(
			/^declaration\.updatedOn : date invalide/,
		);
	});

	it("relecture tolérante : une date abîmée retire ce seul champ, signalé ; la session reste lisible", () => {
		const raw = exported(declared());
		raw.declaration.establishedOn = "0010-10-14";
		const dropped: DeclarationField[] = [];
		const s = stored(raw, dropped);
		expect(dropped).toEqual(["establishedOn"]);
		expect(s.declaration).not.toHaveProperty("establishedOn");
		expect(s.declaration?.organization).toBe("Boulangerie Dupont ");
		expect(s.pages).toEqual(full().pages);
		// L'import de fichier, lui, reste strict.
		expect(refusal(raw).detail).toMatch(/^declaration\.establishedOn : date invalide/);
	});

	it("migration sans perte : une session v1 ou v2 n'a pas de déclaration, et rien d'autre ne change", () => {
		const v2 = { ...exported(), schemaVersion: 2 };
		expect(parse(v2)).toEqual(full());
		expect(stored(v2)).toEqual(full());
		// Une v2 ne pouvait pas porter de déclaration : un champ de ce nom n'y est pas lu.
		expect(parse({ ...v2, declaration: { organization: "x" } })).not.toHaveProperty("declaration");
		// v4 : schéma pluriannuel (ADR-0018), testé dans schema.test.ts ; v5 : attribution (ADR-0022), plus bas.
		expect(SCHEMA_VERSION).toBe(5);
	});
});

describe("attribution de l'évaluateur, evaluatedBy (ADR-0022, schemaVersion 5)", () => {
	const ia = () => setEvaluatedBy(full(), "Claude", NOW);

	it("posée par setEvaluatedBy, conservée par l'export, réimportée à l'identique (produit ⇒ réimportable)", () => {
		const s = ia();
		expect(s.evaluatedBy).toEqual({ kind: "ia", name: "Claude", certified: false });
		expect(exported(s).evaluatedBy).toEqual(s.evaluatedBy);
		expect(parse(exported(s))).toEqual(s);
		expect(stored(exported(s))).toEqual(s);
		// Aux bornes : le nom le plus long que le modèle accepte se réimporte aussi.
		const long = setEvaluatedBy(full(), "x".repeat(MAX_EVALUATOR_NAME), NOW);
		expect(parse(exported(long))).toEqual(long);
		expect(() => setEvaluatedBy(full(), "x".repeat(MAX_EVALUATOR_NAME + 1), NOW)).toThrow();
		expect(() => setEvaluatedBy(full(), " \u202e ", NOW)).toThrow();
	});

	it("modifier une évaluation ne la retire pas ; seule takeOverAudit la retire", () => {
		const edited = setEvaluation(ia(), "1.1", A, { status: "NC", note: "revu" }, LATER);
		expect(edited.evaluatedBy?.name).toBe("Claude");
		const mine = takeOverAudit(edited, LATER);
		expect(mine).not.toHaveProperty("evaluatedBy");
		expect(mine.evaluations).toEqual(edited.evaluations);
		expect(evaluatedByNotice({ kind: "ia", name: "Claude", certified: false })).toBe(
			"Cet audit a été réalisé par une IA (Claude). Il n’est pas certifié et ne remplace pas un audit humain.",
		);
	});

	it("migration : une session v1 à v4 est relue sans attribution, et un champ evaluatedBy n'y est pas lu", () => {
		for (const v of [1, 2, 3, 4]) {
			const old = { ...exported(full()), schemaVersion: v, evaluatedBy: { kind: "ia", name: "X", certified: false } };
			expect(parse(old)).not.toHaveProperty("evaluatedBy");
			expect(stored(old)).not.toHaveProperty("evaluatedBy");
		}
		expect(parse({ ...exported(full()), schemaVersion: 4 })).toEqual(full());
	});

	it("version future protégée : refus spécifique, même avec une attribution illisible", () => {
		expect(() => stored({ ...exported(ia()), schemaVersion: SCHEMA_VERSION + 1, evaluatedBy: "?" })).toThrow(
			FUTURE_SESSION,
		);
	});

	it.each<[string, unknown, RegExp]>([
		["pas un objet", "Claude", /^evaluatedBy : objet attendu/],
		["autre nature", { kind: "humain", name: "A", certified: false }, /^evaluatedBy\.kind/],
		["se dit certifiée", { kind: "ia", name: "Claude", certified: true }, /^evaluatedBy\.certified/],
		["certification absente", { kind: "ia", name: "Claude" }, /^evaluatedBy\.certified/],
		["nom absent", { kind: "ia", certified: false }, /^evaluatedBy\.name : texte attendu/],
	])("import strict ET relecture : refuse %s", (_, evaluatedBy, detail) => {
		expect(refusal({ ...exported(ia()), evaluatedBy }).detail).toMatch(detail);
		expect(() => stored({ ...exported(ia()), evaluatedBy })).toThrow(INVALID_SESSION);
	});

	it("bornes à l'import seulement : nom vide ou trop long refusé à l'import, relu tel quel du stockage", () => {
		for (const name of ["  ", "x".repeat(MAX_EVALUATOR_NAME + 1)]) {
			const file = { ...exported(ia()), evaluatedBy: { kind: "ia", name, certified: false } };
			expect(refusal(file).detail).toMatch(/^evaluatedBy\.name : nom vide ou de plus de 100/);
			expect(stored(file).evaluatedBy?.name).toBe(name);
		}
		// Import : nom nettoyé comme les autres textes.
		const bidi = { ...exported(ia()), evaluatedBy: { kind: "ia", name: " Cla\u202eude ", certified: false } };
		expect(parse(bidi).evaluatedBy?.name).toBe("Claude");
	});
});
