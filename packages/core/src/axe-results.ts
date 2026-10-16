// Classement des résultats axe (ADR-0011 §3) et construction du rapport JSON v2, partagés par la CLI et l'extension
// navigateur (ADR-0019 §4) : même logique, même fichier. Dépend des critères (criteres.ts, sans glossaire ni méthodologies), pas d'axe-core.
import type { AuditPage, AuditReport, AuditResult, ReportToolName } from "./audit-report.ts";
import { REPORT_SCHEMA_VERSION } from "./audit-report.ts";
import type { ResultKind } from "./audit-session.ts";
import { type AxeRuleMapping, classifyAxeRule, criteriaWithDirectRule, isDirectCheck } from "./axe.ts";
import { baseCriteria, getBaseCriterion } from "./criteres.ts";
import { stripControl, truncate } from "./sample-file.ts";

/** Sous-ensemble d'un résultat `axe.run` (violation ou incomplete) utilisé ici. */
export interface AxeRawResult {
	id: string;
	/** Description courte de la règle, en anglais. */
	help?: string;
	tags: string[];
	impact?: string | null;
	nodes: { target: unknown[]; html: string; failureSummary?: string }[];
}

/** Extrait HTML d'un élément en défaut, borné à l'écriture : il peut contenir des données de la page. */
export const NODE_HTML_MAX = 500;
/** Titre de page : borné à l'écriture. */
export const TITLE_MAX = 300;

/** Critères sans aucune vérification automatique directe, d'après les règles d'axe (`axe.getRules()`). */
export const uncoveredCriteria = (rules: readonly { tags: readonly string[] }[]) =>
	baseCriteria.length - criteriaWithDirectRule(rules.map((r) => r.tags)).size;

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
		...(r.help !== undefined && { help: r.help }),
		kind: kindOf(m, incomplete),
		level: m.level,
		tests: m.level === "rgaa" ? m.tests : [],
		criteria: m.level === "hors-rgaa" ? [] : m.criteria,
		wcag: m.level === "rgaa" ? [] : m.wcag,
		flags: { bestPractice: m.bestPractice, experimental: m.experimental },
		impact: r.impact ?? null,
		nodes: r.nodes.map((n) => ({
			target: n.target,
			html: truncate(n.html, NODE_HTML_MAX),
			failureSummary: n.failureSummary ?? null,
		})),
	};
}

/** Classe violations et résultats incomplets d'axe (ADR-0011 §3) ; les règles dépréciées sont exclues. */
export function classifyResults(violations: AxeRawResult[], incomplete: AxeRawResult[]): AuditResult[] {
	return [...violations.flatMap((r) => toResult(r, false)), ...incomplete.flatMap((r) => toResult(r, true))];
}

export function buildReport(input: {
	tool: { name: ReportToolName; version: string };
	startedAt: Date;
	axeVersion: string;
	browserVersion: string;
	pages: AuditPage[];
}): AuditReport {
	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		tool: input.tool,
		engine: { axe: input.axeVersion, browser: input.browserVersion },
		startedAt: input.startedAt.toISOString(),
		pages: input.pages,
	};
}

/** Titre officiel sans les liens markdown vers le glossaire. */
export const plainTitle = (id: string) => (getBaseCriterion(id)?.title ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Cible axe : un sélecteur par niveau de cadre ; un niveau peut être un tableau (Shadow DOM).
export const selector = (target: unknown[]) =>
	stripControl(target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" | "));

export const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
