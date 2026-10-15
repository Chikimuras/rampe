// Logique pure de l'audit : validation d'URL, classement des résultats axe (ADR-0011 §3), JSON et texte.
import {
	type AxeRuleMapping,
	classifyAxeRule,
	criteriaWithDirectRule,
	getCriterion,
	isDirectCheck,
	rgaa,
} from "@rampe/core";
import axe from "axe-core";
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
	/** Nul si la page est en erreur. */
	finalUrl: string | null;
	title: string | null;
	/** Avertissements sur l'audit de la page (ex. redirection vers une autre origine). */
	warnings: string[];
	results: AuditResult[];
	/** Message d'erreur si la page n'a pas pu être auditée (échantillon) ; nul sinon. */
	error: string | null;
}

export interface AuditReport {
	schemaVersion: 2;
	tool: { name: string; version: string };
	engine: { axe: string; browser: string };
	startedAt: string;
	pages: AuditPage[];
}

const HTML_MAX = 500;

/** Critères sans aucune vérification automatique directe (même décompte que le site). */
export const uncoveredCriteria = () =>
	rgaa.criteria.length - criteriaWithDirectRule(axe.getRules().map((r) => r.tags)).size;

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

/**
 * Contrôles de direction bidirectionnelle (U+202A–202E, U+2066–2069) : un titre de page qui en contient pourrait
 * retourner visuellement le texte de Rampe qui le suit (attaque dite « Trojan Source »).
 */
export const stripBidi = (text: string): string => text.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");

/** Retire les caractères de contrôle (séquences d'échappement de terminal, contrôles bidi) venus de la page auditée. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ce qu'on retire.
export const stripControl = (text: string): string => stripBidi(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");

/** Tronque à `max` unités UTF-16 sans couper une paire de substitution, avec une marque visible. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}… (tronqué)`;
}

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
			html: truncate(n.html, HTML_MAX),
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
		schemaVersion: 2,
		tool: { name: pkg.name, version: pkg.version },
		engine: { axe: input.axeVersion, browser: input.browserVersion },
		startedAt: input.startedAt.toISOString(),
		pages: input.pages,
	};
}

// --- Sortie console ---

/** Titre officiel sans les liens markdown vers le glossaire. */
export const plainTitle = (id: string) => (getCriterion(id)?.title ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Cible axe : un sélecteur par niveau de cadre ; un niveau peut être un tableau (Shadow DOM).
export const selector = (target: unknown[]) =>
	stripControl(target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" | "));

export const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
export const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

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
