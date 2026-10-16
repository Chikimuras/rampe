// Logique de l'audit propre à la CLI : rapport console. Classement et JSON v2 viennent de @rampe/core (ADR-0019 §4).
import {
	type AuditPage,
	type AuditResult,
	type AxeRawResult,
	buildReport as buildCoreReport,
	byNumber,
	plainTitle,
	plural,
	type ResultKind,
	redact,
	rgaa,
	selector,
	stripControl,
	uncoveredCriteria as uncoveredFor,
} from "@rampe/core";
import axe from "axe-core";

// Fonctions partagées avec le site et l'extension : elles vivent dans @rampe/core.
export {
	byNumber,
	classifyResults,
	parseAuditUrl,
	plainTitle,
	plural,
	redact,
	selector,
	stripBidi,
	stripControl,
	TITLE_MAX,
	truncate,
} from "@rampe/core";

import pkg from "../package.json" with { type: "json" };

/** Cible axe : un sélecteur, ou un tableau (par cadre, Shadow DOM) de cibles ; rien d'autre. */
const isTarget = (t: unknown): boolean => typeof t === "string" || (Array.isArray(t) && t.every(isTarget));

/** Vérifie la forme d'un résultat axe relu côté Node : rien de ce qui en sort n'est cru sur parole. */
function isAxeResult(r: unknown): r is AxeRawResult {
	const o = r as AxeRawResult;
	return (
		typeof o === "object" &&
		o !== null &&
		typeof o.id === "string" &&
		(o.help === undefined || typeof o.help === "string") &&
		Array.isArray(o.tags) &&
		o.tags.every((t) => typeof t === "string") &&
		(o.impact === undefined || o.impact === null || typeof o.impact === "string") &&
		Array.isArray(o.nodes) &&
		o.nodes.every(
			(n) =>
				typeof n === "object" &&
				n !== null &&
				Array.isArray(n.target) &&
				isTarget(n.target) &&
				typeof n.html === "string" &&
				(n.failureSummary === undefined || typeof n.failureSummary === "string"),
		)
	);
}

/**
 * Relit le JSON sérialisé par axe dans le monde isolé (ADR-0020) et en vérifie la forme ; lève une erreur sinon.
 */
export function parseAxeOutput(value: unknown): {
	title: string;
	violations: AxeRawResult[];
	incomplete: AxeRawResult[];
} {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : null;
	} catch {
		parsed = null;
	}
	const { title, violations, incomplete } = (parsed ?? {}) as Record<string, unknown>;
	if (
		typeof title !== "string" ||
		!Array.isArray(violations) ||
		!Array.isArray(incomplete) ||
		![...violations, ...incomplete].every(isAxeResult)
	)
		throw new Error("résultat d’axe-core illisible : audit impossible.");
	return { title, violations, incomplete };
}

// Forme du JSON : partagée avec le site (import dans l'audit guidé, ADR-0014), elle vit dans @rampe/core.
export type { AuditPage, AuditReport, AuditResult, AxeRawResult, ResultKind } from "@rampe/core";

/** Critères sans aucune vérification automatique directe (même décompte que le site). */
export const uncoveredCriteria = () => uncoveredFor(axe.getRules());

export const buildReport = (input: Omit<Parameters<typeof buildCoreReport>[0], "tool">) =>
	buildCoreReport({ ...input, tool: { name: "@rampe/cli", version: pkg.version } });

// --- Sortie console ---

function ruleLine(r: AuditResult, detail: string, showFlags = true): string {
	const first = r.nodes[0] ? `, ex. ${selector(r.nodes[0].target)}` : "";
	const flags = [r.flags.bestPractice && "règle indicative d’axe", r.flags.experimental && "expérimentale"].filter(
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
export const formatReport = (page: AuditPage, uncovered: number): string =>
	`${formatPage(page)}\n${reminder(uncovered)}`;

/** Rappel d'honnêteté de chaque rapport (ADR-0002 §4). */
const reminder = (uncovered: number) =>
	[
		`Les ${rgaa.criteria.length} critères demandent une vérification humaine. ${uncovered} d’entre eux n’ont même aucune vérification automatique directe.`,
		"Ce résultat automatique ne mesure pas la conformité et ne la certifie pas.",
	].join("\n");

/** Résultats d'une page, sans le rappel final. */
export function formatPage(page: AuditPage): string {
	if (page.error !== null)
		return `Page en erreur : ${stripControl(redact(page.url))}\n${stripControl(redact(page.error))}\n`;
	const of = (kind: ResultKind) => page.results.filter((r) => r.kind === kind);
	const nonConformities = of("non-conformite");
	const out = [
		`Audit automatique de ${stripControl(redact(page.finalUrl ?? page.url))}`,
		`Titre : ${stripControl(page.title ?? "") || "(aucun)"}`,
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
				(r) => ` ; règle ${r.flags.bestPractice ? "indicative" : "expérimentale"} d’axe : à confirmer par une personne`,
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

	return out.join("\n");
}

/** Synthèse d'un échantillon : critères en non-conformité sur au moins une page, pages en erreur, rappel. */
export function formatSynthesis(pages: AuditPage[], uncovered: number): string {
	const where = (p: AuditPage) => stripControl(redact(p.finalUrl ?? p.url));
	const failed = pages.filter((p) => p.error !== null);
	const audited = pages.length - failed.length;
	const out = [
		`Synthèse de l’échantillon : ${plural(audited, "page")} auditée${audited > 1 ? "s" : ""}, ${failed.length} en erreur`,
		"",
	];
	const byCrit = new Map<string, Set<string>>();
	for (const p of pages)
		for (const r of p.results.filter((x) => x.kind === "non-conformite"))
			for (const c of r.criteria) byCrit.set(c, (byCrit.get(c) ?? new Set()).add(where(p)));
	if (audited === 0) out.push("Aucune page n’a pu être auditée.");
	else if (byCrit.size === 0) out.push("Aucune non-conformité détectée automatiquement sur les pages auditées.");
	else {
		out.push("Critères avec une non-conformité détectée sur au moins une page :");
		for (const id of [...byCrit.keys()].sort(byNumber)) {
			const urls = [...(byCrit.get(id) ?? [])];
			out.push(
				`  Critère ${id} — ${plainTitle(id)} : ${plural(urls.length, "page")}`,
				...urls.map((u) => `    - ${u}`),
			);
		}
	}
	out.push("");
	if (failed.length > 0)
		out.push(
			`${plural(failed.length, "page")} en erreur, non auditée${failed.length > 1 ? "s" : ""} :`,
			...failed.map((p) => `  - ${where(p)}`),
			"",
		);
	out.push(reminder(uncovered));
	return out.join("\n");
}
