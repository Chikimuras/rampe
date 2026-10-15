// Logique pure de l'audit : validation d'URL, classement des résultats axe (ADR-0011 §3), JSON et texte.
import { type AxeRuleMapping, classifyAxeRule, getCriterion, isDirectCheck, rgaa } from "@rampe/core";
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
	/** Identifiants éventuels masqués (`***`). */
	url: string;
	finalUrl: string;
	title: string;
	/** Avertissements sur l'audit de la page (ex. redirection vers une autre origine). */
	warnings: string[];
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

/** Masque identifiant et mot de passe de toute URL http(s) du texte (audits de préproduction derrière authentification). */
export const redact = (text: string): string => text.replace(/\b(https?:\/\/)[^\s/?#@]+@/gi, "$1***:***@");

/** Retire les caractères de contrôle (séquences d'échappement de terminal venues de la page auditée). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ce qu'on retire.
export const stripControl = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// ADR-0011 §3 : seule une vérification directe (ni bonne pratique ni expérimentale) est une non-conformité.
function kindOf(m: AxeRuleMapping, incomplete: boolean): ResultKind {
	if (incomplete) return "a-verifier";
	if (isDirectCheck(m)) return "non-conformite";
	return m.level === "hors-rgaa" ? "bonne-pratique" : "incertain";
}

function toResult(r: AxeRawResult, incomplete: boolean): AuditResult | [] {
	const m = classifyAxeRule(r.tags);
	if (m.deprecated) return [];
	return {
		ruleId: r.id,
		kind: kindOf(m, incomplete),
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
const selector = (target: unknown[]) =>
	stripControl(target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" | "));

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function ruleLine(r: AuditResult, detail: string, showFlags = true): string {
	const first = r.nodes[0] ? `, ex. ${selector(r.nodes[0].target)}` : "";
	const flags = [r.flags.bestPractice && "bonne pratique d’axe", r.flags.experimental && "expérimentale"].filter(
		Boolean,
	);
	const suffix = showFlags && flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	return `    - ${r.ruleId}${detail} : ${plural(r.nodes.length, "élément")}${first}${suffix}`;
}

/** Lignes « Critère x.y — titre » suivies des règles qui citent un de ses tests. */
function byCriterion(results: AuditResult[], note: (r: AuditResult) => string = () => ""): string[] {
	const out: string[] = [];
	for (const id of [...new Set(results.flatMap((r) => r.criteria))].sort(byNumber)) {
		out.push(`  Critère ${id} — ${plainTitle(id)}`);
		for (const r of results.filter((x) => x.criteria.includes(id))) {
			const tests = r.tests.filter((t) => t.startsWith(`${id}.`));
			out.push(ruleLine(r, ` (test${tests.length > 1 ? "s" : ""} ${tests.join(", ")}${note(r)})`, !note(r)));
		}
	}
	return out;
}

/** Rapport console d'une page, en français. `uncovered` : critères sans aucune vérification automatique directe. */
export function formatReport(page: AuditPage, uncovered: number): string {
	const of = (kind: ResultKind) => page.results.filter((r) => r.kind === kind);
	const nonConformities = of("non-conformite");
	const out = [
		`Audit automatique de ${stripControl(redact(page.finalUrl))}`,
		`Titre : ${stripControl(page.title) || "(aucun)"}`,
		"",
	];

	if (nonConformities.length === 0) out.push("Aucune non-conformité détectée automatiquement.", "");
	else out.push("Non-conformités détectées, par critère RGAA :", ...byCriterion(nonConformities), "");

	const uncertain = of("incertain");
	if (uncertain.length > 0) {
		out.push("Problèmes détectés, rattachement RGAA incertain :");
		// Règles qui citent un test RGAA mais relèvent des bonnes pratiques ou règles expérimentales d'axe.
		out.push(
			...byCriterion(
				uncertain.filter((r) => r.level === "rgaa"),
				(r) =>
					` ; règle ${r.flags.bestPractice ? "de bonne pratique" : "expérimentale"} d’axe : à confirmer par un humain`,
			),
		);
		for (const r of uncertain.filter((x) => x.level === "wcag"))
			out.push(ruleLine(r, ` (via WCAG ${r.wcag.join(", ")} ; critères possibles ${r.criteria.join(", ")})`));
		out.push("");
	}

	const section = (title: string, results: AuditResult[], detail: (r: AuditResult) => string) => {
		if (results.length === 0) return;
		out.push(title);
		for (const r of results) out.push(ruleLine(r, detail(r)));
		out.push("");
	};
	section("Bonnes pratiques (hors conformité RGAA) :", of("bonne-pratique"), () => "");
	section("À vérifier par un humain :", of("a-verifier"), (r) =>
		r.criteria.length > 0 ? ` (critère${r.criteria.length > 1 ? "s" : ""} ${r.criteria.join(", ")})` : "",
	);

	out.push(
		`Les ${rgaa.criteria.length} critères demandent une vérification humaine. ${uncovered} d’entre eux n’ont même aucune vérification automatique directe.`,
		"Ce résultat automatique ne mesure pas la conformité et ne la certifie pas.",
	);
	return out.join("\n");
}
