import { describe, expect, it } from "vitest";
import official from "../test/fixtures/schema-pluriannuel-officiel.json" with { type: "json" };
import {
	type AuditSession,
	addPage,
	createSession,
	FUTURE_SESSION,
	parseSessionStrict,
	parseStoredSession,
	SCHEMA_VERSION,
	type SchemaAction,
	type Status,
	serializeSession,
	setEvaluation,
} from "./audit-session.ts";
import { computeConformity } from "./conformity.ts";
import { rgaa } from "./rgaa.ts";
import {
	actionState,
	addFreeAction,
	planFileName,
	proposeActions,
	renderAnnualPlan,
	renderSchema,
	SCHEMA_MENTION,
	schemaFileName,
	setSchemaPeriod,
	setSchemaSection,
	updateAction,
	VOLETS,
} from "./schema.ts";
import { ReportError } from "./strict.ts";

const NOW = "2026-10-16T10:00:00.000Z";
const LATER = "2026-10-16T11:00:00.000Z";
const [P1, P2, P3] = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string];
const ALL = rgaa.criteria.map((c) => c.id);
const known = new Set(ALL);
const TITLES = Object.fromEntries(rgaa.criteria.map((c) => [c.id, c.title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")]));
/** Ids prévisibles pour les actions créées par la synchronisation. */
const ids = () => {
	let n = 0;
	return () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

/** Échantillon de 3 pages, tout NA sauf `statuses` (même exemple que declaration.test.ts). */
function audit(statuses: Record<string, [Status, Status, Status]> = {}): AuditSession {
	let s = createSession(NOW);
	s = addPage(s, { url: "https://exemple.fr/", title: "Accueil" }, NOW, P1);
	s = addPage(s, { url: "https://exemple.fr/panier", title: "Panier" }, NOW, P2);
	s = addPage(s, { url: "https://exemple.fr/paiement", title: "Paiement" }, NOW, P3);
	for (const c of ALL) {
		const row = statuses[c] ?? ["NA", "NA", "NA"];
		for (const [i, p] of [P1, P2, P3].entries()) s = setEvaluation(s, c, p, { status: row[i] }, NOW);
	}
	return s;
}
/** 1.1 et 8.3 non validés, 3.2 validé. */
const EXAMPLE = {
	"1.1": ["C", "C", "NC"],
	"3.2": ["C", "C", "C"],
	"8.3": ["NC", "NA", "NC"],
} as const satisfies Record<string, [Status, Status, Status]>;
const conformity = (s: AuditSession) => computeConformity(s, ALL);
const sync = (s: AuditSession, newId = ids()) => proposeActions(s, conformity(s), TITLES, LATER, newId);
const parse = (v: unknown) => parseSessionStrict(v, known);
const stored = (v: unknown) => parseStoredSession(v, known);
const exported = (s: AuditSession) => JSON.parse(serializeSession(s));
const roundTrip = (s: AuditSession) => {
	expect(parse(exported(s))).toEqual(s);
	expect(stored(exported(s))).toEqual(s);
};
const refusal = (v: unknown) => {
	try {
		parse(v);
	} catch (e) {
		if (e instanceof ReportError) return e;
		throw e;
	}
	throw new Error("aucun refus");
};
const md = (s: AuditSession) => renderSchema(s, conformity(s), { format: "markdown" });
const html = (s: AuditSession) => renderSchema(s, conformity(s), { format: "html", standalone: true });

// ---------------------------------------------------------------------------------------------------------------
// Fidélité à la liste officielle. Copie brute du fichier DINUM (fixture), avec son commit ; la liste est relue ici,
// indépendamment de schema.ts : un mot changé, un volet ajouté, retiré ou déplacé fait échouer ces tests.
// ---------------------------------------------------------------------------------------------------------------
const TEXT = official.text;
/**
 * Éléments d'une liste de la source, entre deux phrases. Chaque élément se termine par « ; » (précédé d'une espace
 * insécable) ou par un point, retirés ici comme dans schema.ts. Coquille de la source : le 6e volet « politique »
 * n'a pas de tiret (« ␣␣la mise en œuvre… ») ; c'est bien un volet distinct, l'ADR-0018 en compte huit.
 */
function officialItems(after: string, before: string): string[] {
	const start = TEXT.indexOf(after);
	const end = TEXT.indexOf(before, start);
	expect(start, after).toBeGreaterThanOrEqual(0);
	expect(end, before).toBeGreaterThan(start);
	return TEXT.slice(start + after.length, end)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => l.replace(/^- /, "").replace(/( ;|\.)$/, ""));
}
const POLICY = officialItems("À ce titre, il contient des informations sur\u00a0:", "Il présente également");
const WORKS = officialItems("notamment\u00a0:", "Ces travaux de mise en conformité");

describe("volets officiels : la liste de la DINUM, mot pour mot, dans l'ordre, sans ajout", () => {
	it("la fixture est la copie brute du fichier officiel (empreinte git du blob)", async () => {
		expect(official.commit).toBe("ca4019f95073b6cbd2482a16e9f12b52d8de678d");
		expect(official.blobSha).toBe("02916ec8a3946ec182408afa7f882cb8b2f13311");
		// Empreinte d'un blob git : SHA-1 de « blob <octets>\0<contenu> ».
		const bytes = new TextEncoder().encode(TEXT);
		const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
		const digest = await crypto.subtle.digest("SHA-1", new Uint8Array([...header, ...bytes]));
		const blob = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		expect(blob).toBe(official.blobSha);
		// La coquille documentée : une ligne de la liste sans tiret.
		expect(TEXT).toContain("\n  la mise en œuvre des ressources et expertises externes");
	});

	it("golden : 8 volets « politique » puis 6 volets « travaux », textes identiques à la source", () => {
		expect(POLICY).toHaveLength(8);
		expect(WORKS).toHaveLength(6);
		expect(VOLETS.map((v) => v.description)).toEqual([...POLICY, ...WORKS]);
		expect(VOLETS.map((v) => v.part)).toEqual([...POLICY.map(() => "politique"), ...WORKS.map(() => "travaux")]);
		expect(new Set(VOLETS.map((v) => v.id)).size).toBe(14);
	});

	/**
	 * Golden du document : la sortie Markdown d'un schéma vide est entièrement prévisible. Elle est reconstruite ici
	 * depuis la SOURCE (pas depuis schema.ts) et une liste FERMÉE d'ajouts de Rampe : titres, période, mention,
	 * « Ce volet présente », « [À compléter] », et le message d'un audit incomplet sur les mesures correctives.
	 */
	it("golden : schéma vide, chaque volet officiel cité en entier, dans l'ordre, et « à compléter »", () => {
		const LABELS = [
			"Stratégie",
			"Référent accessibilité numérique",
			"Ressources humaines et financières",
			"Recrutement",
			"Formation et sensibilisation",
			"Ressources externes et outillage",
			"Organisation interne",
			"Clauses contractuelles",
			"Nouveaux projets",
			"Tests utilisateurs",
			"Évaluations prévues",
			"Mesures correctives",
			"Mesures non obligatoires",
			"Bilan des plans d’actions annuels",
		];
		const volet = (label: string, description: string) =>
			[
				`### ${label}`,
				`Ce volet présente ${description}.`,
				...(label === "Mesures correctives"
					? ["L’audit n’est pas complet : aucune action n’a encore été proposée à partir de ses résultats."]
					: []),
				"[À compléter]",
			].join("\n\n");
		const expected = [
			"# Schéma pluriannuel de mise en accessibilité numérique",
			"Période : [à compléter : année de début et durée, de 1 à 3 ans].",
			SCHEMA_MENTION,
			"## Politique d’accessibilité numérique",
			...POLICY.map((d, i) => volet(LABELS[i] as string, d)),
			"## Travaux de mise en conformité",
			...WORKS.map((d, i) => volet(LABELS[8 + i] as string, d)),
		].join("\n\n");
		expect(SCHEMA_MENTION).toBe(
			"Ce document décrit la politique de votre organisme ; Rampe vous aide seulement à le structurer.",
		);
		expect(md(createSession(NOW))).toBe(`${expected}\n`);
	});

	it("HTML : chaque volet officiel figure en entier, dans l'ordre", () => {
		const out = html(createSession(NOW));
		let from = 0;
		for (const d of [...POLICY, ...WORKS]) {
			const at = out.indexOf(`<p>Ce volet présente ${d.replace(/'/g, "&#39;")}.</p>`, from);
			expect(at, d).toBeGreaterThan(from);
			from = at;
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Synchronisation avec l'audit (ADR-0018 §2).
// ---------------------------------------------------------------------------------------------------------------
describe("proposeActions : une action par critère non validé, synchronisation idempotente", () => {
	it("audit complet : une action par critère non validé, avec ses pages, dans l'ordre du référentiel", () => {
		const { session, added, updated } = sync(audit(EXAMPLE));
		expect([added, updated]).toEqual([2, 0]);
		expect(session.schema?.actions).toEqual([
			{
				id: "10000000-0000-4000-8000-000000000001",
				source: "audit",
				criterion: "1.1",
				pages: [P3],
				title: TITLES["1.1"],
				comment: "",
				removed: false,
			},
			{
				id: "10000000-0000-4000-8000-000000000002",
				source: "audit",
				criterion: "8.3",
				pages: [P1, P3],
				title: TITLES["8.3"],
				comment: "",
				removed: false,
			},
		]);
		expect(session.updatedAt).toBe(LATER);
	});

	it("audit incomplet ou sans page : aucune action inventée, session inchangée", () => {
		const incomplete = setEvaluation(audit(EXAMPLE), "11.1", P1, { status: "NT" }, NOW);
		for (const s of [
			incomplete,
			createSession(NOW),
			setEvaluation(audit(EXAMPLE), "1.1", P1, { source: "auto" }, NOW),
		]) {
			const r = sync(s);
			expect(r.session).toBe(s);
			expect([r.added, r.updated]).toEqual([0, 0]);
		}
	});

	it("relancer ne duplique rien et ne change rien (même objet, même date)", () => {
		const once = sync(audit(EXAMPLE)).session;
		const twice = sync(once);
		expect(twice.session).toBe(once);
		expect([twice.added, twice.updated]).toEqual([0, 0]);
	});

	it("ne touche jamais aux réglages de l'utilisateur, ni à une action libre", () => {
		let s = setSchemaPeriod(sync(audit(EXAMPLE)).session, 2026, 3, LATER);
		const [a1, a2] = s.schema?.actions ?? [];
		s = updateAction(
			s,
			a1?.id as string,
			{ priority: "haute", targetYear: 2027, comment: "Logo", status: "faite" },
			LATER,
		);
		s = updateAction(s, a2?.id as string, { removed: true }, LATER);
		s = addFreeAction(s, "Former l’équipe", LATER, "20000000-0000-4000-8000-000000000001");
		// 1.1 échoue désormais aussi sur Panier : seules les pages changent.
		const more = setEvaluation(s, "1.1", P2, { status: "NC" }, NOW);
		const r = sync(more);
		expect([r.added, r.updated]).toEqual([0, 1]);
		expect(r.session.schema?.actions).toEqual([
			{ ...s.schema?.actions[0], pages: [P2, P3] },
			s.schema?.actions[1],
			s.schema?.actions[2],
		]);
	});

	it("une action retirée n'est jamais réinsérée, même si le critère échoue encore", () => {
		const s = sync(audit(EXAMPLE)).session;
		const removed = updateAction(s, s.schema?.actions[1]?.id as string, { removed: true }, LATER);
		const r = sync(removed);
		expect(r.session).toBe(removed);
		expect(r.session.schema?.actions.filter((a) => a.criterion === "8.3")).toHaveLength(1);
	});

	it("critère redevenu validé : l'action reste, marquée « critère désormais validé » ; redevenu NC, la marque part", () => {
		const s = sync(audit(EXAMPLE)).session;
		const fixed = setEvaluation(s, "8.3", P1, { status: "C" }, NOW);
		const fixedBoth = setEvaluation(fixed, "8.3", P3, { status: "C" }, NOW);
		const r = sync(fixedBoth);
		expect(r.session).toBe(fixedBoth);
		const a = r.session.schema?.actions[1];
		expect(a?.criterion).toBe("8.3");
		expect(actionState(a as SchemaAction, conformity(fixedBoth))).toBe("validé");
		expect(md(fixedBoth)).toContain("(critère désormais validé)");
		expect(actionState(a as SchemaAction, conformity(s))).toBeNull();
		// Devenu non applicable partout.
		const na = [P1, P2, P3].reduce((acc, p) => setEvaluation(acc, "8.3", p, { status: "NA" }, NOW), s);
		expect(actionState(a as SchemaAction, conformity(na))).toBe("non applicable");
		// Audit incomplet : on ne sait pas, aucune marque.
		expect(
			actionState(a as SchemaAction, conformity(setEvaluation(fixedBoth, "1.1", P1, { status: "NT" }, NOW))),
		).toBeNull();
	});

	it("une nouvelle non-conformité ajoute une seule action, à la fin", () => {
		const s = sync(audit(EXAMPLE)).session;
		const r = sync(setEvaluation(s, "3.2", P2, { status: "NC" }, NOW), () => "30000000-0000-4000-8000-000000000001");
		expect([r.added, r.updated]).toEqual([1, 0]);
		expect(r.session.schema?.actions.map((a) => a.criterion)).toEqual(["1.1", "8.3", "3.2"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Saisie : période, volets, actions (bornes à l'écriture, ADR-0016).
// ---------------------------------------------------------------------------------------------------------------
describe("saisie du schéma", () => {
	it("période : année de 1900 à 9999, durée de 1 à 3 ans ; vide retire le champ, puis le schéma", () => {
		const s = setSchemaPeriod(createSession(NOW), 2026, 2, LATER);
		expect(s.schema).toEqual({ startYear: 2026, duration: 2, sections: {}, actions: [] });
		for (const [y, d] of [
			[1899, 1],
			[10000, 1],
			[2026.5, 1],
			[2026, 0],
			[2026, 4],
			[2026, 1.5],
			[9998, 3],
		])
			expect(() => setSchemaPeriod(s, y, d, LATER), `${y} ${d}`).toThrow(/invalide/);
		expect(setSchemaPeriod(s, undefined, undefined, LATER)).not.toHaveProperty("schema");
	});

	it("année cible hors période refusée à la saisie ; sans période, aucune année cible", () => {
		let s = addFreeAction(createSession(NOW), "Audit annuel", LATER, P1);
		expect(() => updateAction(s, P1, { targetYear: 2026 }, LATER)).toThrow(/hors de la période/);
		s = setSchemaPeriod(s, 2026, 3, LATER);
		for (const y of [2025, 2029, 2026.5]) expect(() => updateAction(s, P1, { targetYear: y }, LATER)).toThrow(/hors/);
		for (const y of [2026, 2027, 2028])
			expect(updateAction(s, P1, { targetYear: y }, LATER).schema?.actions[0]?.targetYear).toBe(y);
		// Réglage retiré : `undefined` retire le champ.
		const set = updateAction(s, P1, { targetYear: 2027, priority: "basse" }, LATER);
		expect(updateAction(set, P1, { targetYear: undefined, priority: undefined }, LATER).schema?.actions[0]).toEqual({
			id: P1,
			source: "libre",
			title: "Audit annuel",
			comment: "",
			removed: false,
		});
	});

	it("période raccourcie : l'année cible devenue hors période est gardée et signalée, jamais effacée", () => {
		let s = setSchemaPeriod(addFreeAction(createSession(NOW), "Audit", LATER, P1), 2026, 3, LATER);
		s = updateAction(s, P1, { targetYear: 2028 }, LATER);
		s = setSchemaPeriod(s, 2026, 1, LATER);
		expect(s.schema?.actions[0]?.targetYear).toBe(2028);
		expect(md(s)).toContain(`Année cible${NB}: 2028 (hors de la période du schéma, à redéfinir).`);
		roundTrip(s);
	});

	it("valeurs inconnues refusées : priorité, bilan, champ, action, volet", () => {
		const s = addFreeAction(createSession(NOW), "Audit", LATER, P1);
		expect(() => updateAction(s, P1, { priority: "urgente" as never }, LATER)).toThrow(/Priorité/);
		expect(() => updateAction(s, P1, { status: "abandonnée" as never }, LATER)).toThrow(/Bilan/);
		expect(() => updateAction(s, P2, { comment: "x" }, LATER)).toThrow(/Action inconnue/);
		expect(() => setSchemaSection(s, "toString" as never, "x", LATER)).toThrow(/Volet inconnu/);
		expect(() => addFreeAction(s, "  ", LATER)).toThrow(/Intitulé/);
		expect(() => addFreeAction(s, "Autre", LATER, P1)).toThrow(/déjà utilisé/);
		expect(() => addFreeAction(s, "Autre", LATER, "toString")).toThrow(/invalide/);
	});

	it("bornes à l'écriture : intitulé 1 000, commentaire 10 000, volet 10 000 ; textes nettoyés", () => {
		let s = addFreeAction(createSession(NOW), `‮ ${"t".repeat(1000)}\u0007 `, LATER, P1);
		expect(s.schema?.actions[0]?.title).toBe("t".repeat(1000));
		expect(() => addFreeAction(s, "t".repeat(1001), LATER)).toThrow(/1000/);
		expect(() => updateAction(s, P1, { comment: "c".repeat(10_001) }, LATER)).toThrow(/10000/);
		expect(() => setSchemaSection(s, "strategy", "s".repeat(10_001), LATER)).toThrow(/10000/);
		s = updateAction(s, P1, { comment: `ligne 1\n\tligne 2‮${"c".repeat(9980)}` }, LATER);
		s = setSchemaSection(s, "strategy", "s".repeat(10_000), LATER);
		expect(s.schema?.actions[0]?.comment).toMatch(/^ligne 1\n\tligne 2c+$/);
		roundTrip(s);
		expect(setSchemaSection(s, "strategy", "", LATER).schema?.sections).toEqual({});
	});

	it("au-delà de 1 000 actions : refusé", () => {
		let s = createSession(NOW);
		const actions = Array.from({ length: 1000 }, (_, i) => ({
			id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
			source: "libre" as const,
			title: "a",
			comment: "",
			removed: false,
		}));
		s = { ...s, schema: { sections: {}, actions } };
		expect(() => addFreeAction(s, "une de trop", LATER)).toThrow(/1000 actions/);
		expect(refusal({ ...exported(s), schema: { sections: {}, actions: [...actions, actions[0]] } }).detail).toMatch(
			/plus de 1000 éléments/,
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Rendu : schéma et plan d'action annuel.
// ---------------------------------------------------------------------------------------------------------------
function filled() {
	let s = sync(audit(EXAMPLE)).session;
	s = setSchemaPeriod(s, 2026, 3, LATER);
	s = setSchemaSection(s, "strategy", "Accessibilité dans le plan numérique 2026.\n\nRévisée chaque année.", LATER);
	const [a1, a2] = s.schema?.actions ?? [];
	s = updateAction(s, a1?.id as string, { priority: "haute", targetYear: 2026, status: "faite" }, LATER);
	s = updateAction(s, a2?.id as string, { priority: "moyenne", targetYear: 2027, comment: "Avec la refonte" }, LATER);
	s = addFreeAction(s, "Former l’équipe éditoriale", LATER, "20000000-0000-4000-8000-000000000001");
	s = updateAction(s, "20000000-0000-4000-8000-000000000001", { priority: "basse", targetYear: 2027 }, LATER);
	s = addFreeAction(s, "Sous-titrer les vidéos", LATER, "20000000-0000-4000-8000-000000000002");
	return updateAction(s, "20000000-0000-4000-8000-000000000002", { removed: true }, LATER);
}
const NB = " ";

describe("rendu du schéma pluriannuel", () => {
	it("période, saisies, calendrier des actions trié par année puis priorité, retraits visibles", () => {
		const out = md(filled());
		expect(out).toContain("Période : de 2026 à 2028 (3 ans).");
		expect(out).toContain("Ce volet présente la prise en compte");
		expect(out).toContain("Accessibilité dans le plan numérique 2026\\.\n\nRévisée chaque année\\.");
		const actions = out.slice(out.indexOf("Calendrier des actions"));
		expect(actions).toContain(
			[
				`- Critère 1.1${NB}: ${TITLES["1.1"]?.replace(/[-?]/g, "\\$&")} Page concernée${NB}: Paiement. Priorité${NB}: haute. Année cible${NB}: 2026.`,
				`- Critère 8.3${NB}: ${TITLES["8.3"]?.replace(/[-?,]/g, "\\$&")} Pages concernées${NB}: Accueil\\, Paiement. Priorité${NB}: moyenne. Année cible${NB}: 2027. Commentaire${NB}: Avec la refonte`,
				`- Former l’équipe éditoriale. Priorité${NB}: basse. Année cible${NB}: 2027.`,
			].join("\n"),
		);
		expect(out).toContain(
			`Actions retirées par l’organisme, gardées pour mémoire${NB}:\n\n- Sous\\-titrer les vidéos. Priorité${NB}: [à définir]. Année cible${NB}: [à définir]. (retirée)`,
		);
		// Volet rempli : plus « à compléter » ; les autres le restent.
		expect(out.split("### Stratégie")[1]?.split("###")[0]).not.toContain("[À compléter]");
		expect(out.split("### Formation")[1]?.split("###")[0]).toContain("[À compléter]");
	});

	it("HTML autonome : une page avec titre, langue et la mention", () => {
		const out = html(filled());
		expect(out).toMatch(/^<!doctype html>\n<html lang="fr">/);
		expect(out).toContain("<title>Schéma pluriannuel de mise en accessibilité numérique</title>");
		expect(out).toContain(`<p>${SCHEMA_MENTION}</p>`);
		expect(out).toContain("<h1>Schéma pluriannuel de mise en accessibilité numérique</h1>");
		// Fragment : commence au h2, pour se coller sous le h1 d'une page existante.
		const fragment = renderSchema(filled(), conformity(filled()), { format: "html" });
		expect(fragment.startsWith("<h2>Schéma pluriannuel")).toBe(true);
	});

	it("noms de fichier datés, sur le modèle de la déclaration", () => {
		const date = new Date(2026, 9, 5, 23, 59);
		expect(schemaFileName(filled(), date, "md")).toBe("schema-pluriannuel-exemple.fr-2026-10-05.md");
		expect(planFileName(filled(), 2027, date, "html")).toBe("plan-action-2027-exemple.fr-2026-10-05.html");
	});
});

describe("rendu du plan d'action annuel", () => {
	const plan = (year: number, format: "html" | "markdown" = "markdown") =>
		renderAnnualPlan(year, filled(), conformity(filled()), { format });

	it("filtré sur l'année : actions de l'année, sans les retirées ; bilan de l'année précédente", () => {
		const out = plan(2027);
		expect(out.startsWith("# Plan d’action 2027\n")).toBe(true);
		expect(out).toContain(
			"Plan d’action annuel du schéma pluriannuel de mise en accessibilité numérique (de 2026 à 2028).",
		);
		expect(out).toContain(SCHEMA_MENTION);
		const planned = out.slice(out.indexOf("## Actions prévues en 2027"), out.indexOf("## Bilan"));
		expect(planned).toContain("Critère 8.3");
		expect(planned).toContain("Former l’équipe éditoriale");
		expect(planned).not.toContain("Critère 1.1");
		expect(planned).not.toContain("Sous\\-titrer");
		expect(planned).not.toContain("Année cible");
		const review = out.slice(out.indexOf("## Bilan de l’année précédente (2026)"));
		expect(review).toContain(`Critère 1.1${NB}:`);
		expect(review).toContain(`Bilan${NB}: faite.`);
		expect(review).not.toContain("8.3");
	});

	it("bilan non renseigné : à compléter ; aucune action : dit en clair", () => {
		const s = updateAction(filled(), filled().schema?.actions[0]?.id as string, { status: undefined }, LATER);
		expect(renderAnnualPlan(2027, s, conformity(s), { format: "markdown" })).toContain(
			`Bilan${NB}: [à compléter : faite, en cours ou reportée].`,
		);
		const out = plan(2028);
		expect(out).toContain("Aucune action prévue pour cette année.");
		expect(plan(2026)).toContain("Aucune action n’était prévue en 2025 : pas de bilan à faire.");
	});

	it("HTML autonome : titre de la page = année du plan", () => {
		const out = renderAnnualPlan(2027, filled(), conformity(filled()), { format: "html", standalone: true });
		expect(out).toContain("<title>Plan d’action 2027</title>");
		expect(out).toContain("<h1>Plan d’action 2027</h1>");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Sécurité : OWASP XSS Prevention Cheat Sheet, « Output Encoding ».
// ---------------------------------------------------------------------------------------------------------------
describe("saisies hostiles neutralisées, en HTML comme en Markdown", () => {
	const HOSTILE = "<script>alert(1)</script><img src=x onerror=alert(2)>[clic](javascript:alert(3))\n# titre\n- puce";
	const hostile = () => {
		let s = setSchemaPeriod(createSession(NOW), 2026, 1, LATER);
		s = setSchemaSection(s, "strategy", HOSTILE, LATER);
		s = addFreeAction(s, HOSTILE.replace(/\n/g, " "), LATER, P1);
		return updateAction(s, P1, { comment: HOSTILE, targetYear: 2026 }, LATER);
	};
	it("HTML : aucune balise ni attribut venant d'une saisie", () => {
		for (const out of [html(hostile()), renderAnnualPlan(2026, hostile(), conformity(hostile()), { format: "html" })]) {
			expect(out).not.toMatch(/<(script|img|iframe|svg)\b/i);
			expect(out).not.toMatch(/<[^>]*\son\w+=/i);
			expect(out).not.toContain("<a ");
			expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		}
	});
	it("Markdown : toute ponctuation d'une saisie échappée ; aucun titre, lien ni balise ne s'ouvre", () => {
		for (const out of [
			md(hostile()),
			renderAnnualPlan(2026, hostile(), conformity(hostile()), { format: "markdown" }),
		]) {
			expect(out).toContain("\\<script\\>alert\\(1\\)\\<\\/script\\>");
			expect(out).toContain("\\[clic\\]\\(javascript\\:alert\\(3\\)\\)");
			expect(out).not.toMatch(/(^|[^\\])<script/);
			expect(out).not.toMatch(/^# titre/m);
			expect(out).not.toMatch(/^- puce/m);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Session : schemaVersion 4, migration, import strict, relecture tolérante (ADR-0016, ADR-0018 §5).
// ---------------------------------------------------------------------------------------------------------------
describe("schéma dans la session (schemaVersion 4)", () => {
	it("aller-retour export → import et relecture du stockage : identique", () => {
		expect(SCHEMA_VERSION).toBe(4);
		roundTrip(filled());
	});

	it("migration sans perte : une session v3 (avec déclaration) est relue, sans schéma ; un champ « schema » d'une v3 n'est pas lu", () => {
		const v3 = { ...exported(audit(EXAMPLE)), schemaVersion: 3, declaration: { organization: "Mairie" } };
		const expected = { ...audit(EXAMPLE), declaration: { organization: "Mairie" } };
		expect(parse(v3)).toEqual(expected);
		expect(stored(v3)).toEqual(expected);
		expect(parse({ ...v3, schema: { sections: {}, actions: [] } })).not.toHaveProperty("schema");
		for (const v of [1, 2]) expect(stored({ ...exported(audit()), schemaVersion: v })).not.toHaveProperty("schema");
	});

	it("version future (5) : refus spécifique, avant tout autre contrôle", () => {
		expect(() => stored({ ...exported(filled()), schemaVersion: 5, schema: "?" })).toThrow(FUTURE_SESSION);
		expect(refusal({ ...exported(filled()), schemaVersion: 5 }).message).toBe(FUTURE_SESSION);
	});

	it("import strict : structure, types et bornes ; tout ou rien", () => {
		const f = () => exported(filled());
		const action = (patch: Record<string, unknown>) => {
			const file = f();
			Object.assign(file.schema.actions[0], patch);
			return file;
		};
		for (const [file, detail] of [
			[{ ...f(), schema: [] }, /^schema : objet attendu/],
			[{ ...f(), schema: { ...f().schema, startYear: 1899 } }, /^schema\.startYear : année/],
			[{ ...f(), schema: { ...f().schema, startYear: "2026" } }, /^schema\.startYear : année/],
			[{ ...f(), schema: { ...f().schema, duration: 4 } }, /^schema\.duration : durée/],
			[{ ...f(), schema: { ...f().schema, sections: { strategy: 1 } } }, /^schema\.sections\.strategy : texte/],
			[{ ...f(), schema: { ...f().schema, actions: {} } }, /^schema\.actions : liste attendue/],
			[action({ id: "toString" }), /^schema\.actions\[0\]\.id : identifiant/],
			[action({ id: f().schema.actions[1].id }), /^schema\.actions\[1\]\.id : identifiant .* double/],
			[action({ source: "auto" }), /^schema\.actions\[0\]\.source/],
			[action({ criterion: "99.1" }), /^schema\.actions\[0\]\.criterion : critère "99\.1" inexistant/],
			[action({ criterion: undefined }), /^schema\.actions\[0\]\.criterion/],
			[action({ pages: ["x"] }), /^schema\.actions\[0\]\.pages\[0\] : identifiant de page/],
			[action({ priority: "urgente" }), /^schema\.actions\[0\]\.priority/],
			[action({ targetYear: 10_000 }), /^schema\.actions\[0\]\.targetYear : année/],
			[action({ removed: "non" }), /^schema\.actions\[0\]\.removed/],
			[action({ status: "abandonnée" }), /^schema\.actions\[0\]\.status/],
			[action({ title: 3 }), /^schema\.actions\[0\]\.title : texte/],
			[JSON.parse(`{"schema":{"__proto__":{}}}`), /__proto__/],
		] as const)
			expect(refusal({ ...f(), ...file }).detail, String(detail)).toMatch(detail);
		// Une action libre ne porte ni critère ni pages.
		const libre = f();
		libre.schema.actions[2].criterion = "1.1";
		expect(refusal(libre).detail).toMatch(/^schema\.actions\[2\]\.criterion : réservé aux actions de l’audit/);
	});

	it("import : textes nettoyés et tronqués, clés inconnues ignorées, schéma vide retiré", () => {
		const f = exported(filled());
		f.schema.sections.strategy = `‮ligne 1\n\tligne 2${"s".repeat(20_000)}`;
		f.schema.sections.inconnu = "x";
		f.schema.actions[2].title = `‮${"t".repeat(2000)}`;
		f.schema.actions[2].extra = 1;
		const s = parse(f);
		expect(s.schema?.sections.strategy?.startsWith("ligne 1\n\tligne 2s")).toBe(true);
		expect(s.schema?.sections.strategy?.length).toBe(10_000 + "… (tronqué)".length);
		expect(s.schema?.sections).not.toHaveProperty("inconnu");
		expect(s.schema?.actions[2]?.title).toMatch(/^t{1000}… \(tronqué\)$/);
		expect(s.schema?.actions[2]).not.toHaveProperty("extra");
		expect(parse({ ...f, schema: { sections: {}, actions: [] } })).not.toHaveProperty("schema");
	});

	it("relecture du stockage : sans borne ni modification, mais structure et types contrôlés", () => {
		const raw = exported(filled());
		raw.schema.startYear = 1000;
		raw.schema.sections.strategy = `\t${"s".repeat(20_000)}‮`;
		raw.schema.actions[0].title = "t".repeat(5000);
		raw.schema.actions[0].targetYear = 12_000;
		raw.schema.sections.training = "";
		expect(stored(raw).schema).toEqual(raw.schema);
		for (const bad of [
			{ ...raw.schema, duration: 7 },
			{ ...raw.schema, startYear: 2026.5 },
			{ ...raw.schema, actions: [{ ...raw.schema.actions[0], source: "x" }] },
			{ ...raw.schema, actions: [{ ...raw.schema.actions[0], criterion: "99.1" }] },
		])
			expect(() => stored({ ...raw, schema: bad })).toThrow(ReportError);
	});

	it("invariant : tout ce que l'interface produit se réimporte à l'identique (aléatoire)", () => {
		let seed = 11;
		const rand = (n: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed % n;
		};
		const texts = ["", " ", "Texte\n\tsur deux lignes ", "‮<b>x</b>\u0000", "é".repeat(50)];
		for (let run = 0; run < 25; run++) {
			let s = audit(EXAMPLE);
			let n = 0;
			const newId = () => `50000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
			for (let k = 0; k < 30; k++) {
				const actions = s.schema?.actions ?? [];
				const a = actions[rand(Math.max(actions.length, 1))];
				const start = s.schema?.startYear;
				const years = start ? [start, start + 1, start + 2].slice(0, s.schema?.duration ?? 0) : [];
				try {
					switch (rand(7)) {
						case 0:
							s = setSchemaPeriod(s, rand(2) ? 2026 : 9998, 1 + rand(3), LATER);
							break;
						case 1:
							s = setSchemaSection(s, VOLETS[rand(14)]?.id as never, texts[rand(texts.length)] as string, LATER);
							break;
						case 2:
							s = addFreeAction(s, `Action ${texts[rand(texts.length)]}x`, LATER, newId());
							break;
						case 3:
							s = setEvaluation(s, ALL[rand(ALL.length)] as string, [P1, P2, P3][rand(3)] as string, {
								status: (["C", "NC", "NA"] as const)[rand(3)],
							});
							s = proposeActions(s, conformity(s), TITLES, LATER, newId).session;
							break;
						case 4:
							if (a && years.length) s = updateAction(s, a.id, { targetYear: years[rand(years.length)] }, LATER);
							break;
						case 5:
							if (a)
								s = updateAction(
									s,
									a.id,
									{
										priority: (["haute", "moyenne", "basse", undefined] as const)[rand(4)],
										status: (["faite", "en cours", "reportée", undefined] as const)[rand(4)],
										comment: texts[rand(texts.length)] as string,
									},
									LATER,
								);
							break;
						default:
							if (a) s = updateAction(s, a.id, { removed: !a.removed }, LATER);
					}
				} catch (e) {
					// Seuls les refus attendus de la saisie (année hors période…) ; jamais une session abîmée.
					expect((e as Error).message).toMatch(/hors de la période|invalide/);
				}
			}
			try {
				roundTrip(s);
			} catch (e) {
				throw new Error(`${run} : ${(e as ReportError).detail ?? e}`);
			}
		}
	});
});
