// Logique pure de l'audit : validation d'URL, classement des résultats axe (ADR-0011 §3), JSON et texte.
import { type AxeRuleMapping, classifyAxeRule, getCriterion, rgaa } from "@rampe/core";
import pkg from "../package.json" with { type: "json" };

/** Sous-ensemble d'un résultat `axe.run` (violation ou incomplete) utilisé ici. */
export interface AxeRawResult {
	id: string;
	tags: string[];
	impact?: string | null;
	nodes: { target: unknown[]; html: string; failureSummary?: string }[];
}

export type ResultKind = "non-conformite" | "incertain" | "bonne-pratique" | "a-verifier";

export interface AuditResult {
	ruleId: string;
	kind: ResultKind;
	level: AxeRuleMapping["level"];
	/** Tests RGAA cités par la règle (niveau `rgaa` seulement). */
	tests: string[];
	/** Critères RGAA rattachés (vide hors RGAA). */
	criteria: string[];
	/** Critères de succès WCAG (niveaux `wcag` et `hors-rgaa`). */
	wcag: string[];
	flags: { bestPractice: boolean; experimental: boolean };
	impact: string | null;
	nodes: { target: unknown[]; html: string; failureSummary: string | null }[];
}

export interface AuditPage {
	url: string;
	finalUrl: string;
	title: string;
	results: AuditResult[];
}

export interface AuditReport {
	schemaVersion: 1;
	tool: { name: string; version: string };
	engine: { axe: string; browser: string };
	startedAt: string;
	pages: AuditPage[];
}

const HTML_MAX = 500;

/** N'accepte que http: et https: (ADR-0011 §6). Lève une erreur au message lisible sinon. */
export function parseAuditUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`URL invalide : « ${input} ». Exemple attendu : https://exemple.fr/`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`Seules les adresses http:// et https:// sont acceptées (reçu : ${url.protocol}).`);
	return url;
}

const KIND_BY_LEVEL = { rgaa: "non-conformite", wcag: "incertain", "hors-rgaa": "bonne-pratique" } as const;

function toResult(r: AxeRawResult, incomplete: boolean): AuditResult | [] {
	const m = classifyAxeRule(r.tags);
	if (m.deprecated) return [];
	return {
		ruleId: r.id,
		kind: incomplete ? "a-verifier" : KIND_BY_LEVEL[m.level],
		level: m.level,
		tests: m.level === "rgaa" ? m.tests : [],
		criteria: m.level === "hors-rgaa" ? [] : m.criteria,
		wcag: m.level === "rgaa" ? [] : m.wcag,
		flags: { bestPractice: m.bestPractice, experimental: m.experimental },
		impact: r.impact ?? null,
		nodes: r.nodes.map((n) => ({
			target: n.target,
			html: n.html.slice(0, HTML_MAX),
			failureSummary: n.failureSummary ?? null,
		})),
	};
}

/** Classe violations et résultats incomplets d'axe (ADR-0011 §3) ; les règles dépréciées sont exclues. */
export function classifyResults(violations: AxeRawResult[], incomplete: AxeRawResult[]): AuditResult[] {
	return [...violations.flatMap((r) => toResult(r, false)), ...incomplete.flatMap((r) => toResult(r, true))];
}

export function buildReport(input: {
	startedAt: Date;
	axeVersion: string;
	browserVersion: string;
	pages: AuditPage[];
}): AuditReport {
	return {
		schemaVersion: 1,
		tool: { name: pkg.name, version: pkg.version },
		engine: { axe: input.axeVersion, browser: input.browserVersion },
		startedAt: input.startedAt.toISOString(),
		pages: input.pages,
	};
}

// --- Sortie console ---

/** Titre officiel sans les liens markdown vers le glossaire. */
const plainTitle = (id: string) => (getCriterion(id)?.title ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Cible axe : un sélecteur par niveau de cadre ; un niveau peut être un tableau (Shadow DOM).
const selector = (target: unknown[]) => target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" | ");

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

function ruleLine(r: AuditResult, detail: string): string {
	const first = r.nodes[0] ? `, ex. ${selector(r.nodes[0].target)}` : "";
	const flags = [r.flags.bestPractice && "bonne pratique d’axe", r.flags.experimental && "expérimentale"].filter(
		Boolean,
	);
	const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	return `    - ${r.ruleId}${detail} : ${plural(r.nodes.length, "élément")}${first}${suffix}`;
}

/** Rapport console d'une page, en français. `uncovered` : critères sans aucune vérification automatique directe. */
export function formatReport(page: AuditPage, uncovered: number): string {
	const of = (kind: ResultKind) => page.results.filter((r) => r.kind === kind);
	const nonConformities = of("non-conformite");
	const out = [`Audit automatique de ${page.finalUrl}`, `Titre : ${page.title || "(aucun)"}`, ""];

	if (nonConformities.length === 0) out.push("Aucune non-conformité détectée automatiquement.", "");
	else {
		out.push("Non-conformités détectées, par critère RGAA :");
		const criteria = [...new Set(nonConformities.flatMap((r) => r.criteria))].sort((a, b) =>
			a.localeCompare(b, "en", { numeric: true }),
		);
		for (const id of criteria) {
			out.push(`  Critère ${id} — ${plainTitle(id)}`);
			for (const r of nonConformities.filter((x) => x.criteria.includes(id))) {
				const tests = r.tests.filter((t) => t.startsWith(`${id}.`));
				out.push(ruleLine(r, ` (test${tests.length > 1 ? "s" : ""} ${tests.join(", ")})`));
			}
		}
		out.push("");
	}

	const section = (title: string, results: AuditResult[], detail: (r: AuditResult) => string) => {
		if (results.length === 0) return;
		out.push(title);
		for (const r of results) out.push(ruleLine(r, detail(r)));
		out.push("");
	};
	const criteriaOf = (r: AuditResult) =>
		r.criteria.length > 0 ? ` (critère${r.criteria.length > 1 ? "s" : ""} ${r.criteria.join(", ")})` : "";
	section(
		"Problèmes détectés, rattachement RGAA incertain (via WCAG) :",
		of("incertain"),
		(r) => ` (WCAG ${r.wcag.join(", ")} ; critères possibles ${r.criteria.join(", ")})`,
	);
	section("Bonnes pratiques (hors conformité RGAA) :", of("bonne-pratique"), () => "");
	section("À vérifier par un humain :", of("a-verifier"), criteriaOf);

	out.push(
		`${uncovered} critères sur ${rgaa.criteria.length} n’ont aucune vérification automatique directe : audit humain indispensable.`,
		"Ce résultat automatique ne mesure pas la conformité et ne la certifie pas.",
	);
	return out.join("\n");
}
