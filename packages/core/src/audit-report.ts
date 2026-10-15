// Rapport JSON v2 de la CLI (ADR-0011, ADR-0012) et son import dans l'audit guidé (ADR-0014).
// Les types vivent ici pour que la CLI (qui écrit le fichier) et le site (qui le relit) partagent la même forme,
// sans que le site dépende de la CLI. Code pur, sans données RGAA : l'appelant passe les critères existants.

import {
	type AuditSession,
	addPage,
	type Finding,
	getEvaluation,
	getFindings,
	isObject,
	own,
	RESULT_KINDS,
	type ResultKind,
	setEvaluation,
} from "./audit-session.ts";
import type { AxeRuleMapping } from "./axe.ts";
import { parseAuditUrl, plural, stripControl, urlKey } from "./sample-file.ts";

export type { ResultKind } from "./audit-session.ts";

export interface AuditResult {
	ruleId: string;
	/** Description de la règle par axe (en anglais). Absente des fichiers écrits avant son ajout. */
	help?: string;
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
	schemaVersion: typeof REPORT_SCHEMA_VERSION;
	tool: { name: string; version: string };
	engine: { axe: string; browser: string };
	startedAt: string;
	pages: AuditPage[];
}

export const REPORT_SCHEMA_VERSION = 2;
/** Nom écrit par la CLI dans `tool.name` (nom de son paquet). */
export const REPORT_TOOL_NAME = "@rampe/cli";
/** ADR-0014 §4 : taille maximale du fichier, vérifiée par l'appelant AVANT lecture. */
export const MAX_REPORT_BYTES = 20 * 1024 * 1024;

/** Rapport validé : seuls les champs utilisés par l'import, nettoyés et bornés. */
export interface ImportableReport {
	/** Origine commune à toutes les pages. */
	site: string;
	pages: {
		/** Adresse normalisée : sans fragment ni identifiants. */
		url: string;
		title: string;
		error: string | null;
		results: { ruleId: string; help?: string; kind: ResultKind; impact?: string; nodes: number; criteria: string[] }[];
	}[];
}

// Bornes (ADR-0014 §4, OWASP Input Validation Cheat Sheet : type, forme et bornes en liste blanche).
const MAX_PAGES = 1000;
const MAX_RESULTS = 1000;
const MAX_CRITERIA = 200;
const MAX_URL = 2048;
const MAX_TITLE = 2000;
const MAX_ERROR = 2000;
const MAX_HELP = 1000;
const MAX_DEPTH = 64;
const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMPACTS = ["minor", "moderate", "serious", "critical"];
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

class InvalidReport extends Error {}
const fail = (path: string, problem: string): never => {
	throw new InvalidReport(`Fichier refusé, rien n’a été importé. ${path} : ${problem}.`);
};

/** Refuse les clés dangereuses partout dans le fichier, et une imbrication anormale (pile bornée). */
function checkKeys(value: unknown, path: string, depth: number): void {
	if (typeof value !== "object" || value === null) return;
	if (depth > MAX_DEPTH) fail(path, "structure trop profonde");
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_KEYS.includes(key)) fail(path, `clé interdite « ${key} »`);
		checkKeys((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
	}
}

const field = (o: Record<string, unknown>, key: string) => (Object.hasOwn(o, key) ? o[key] : undefined);
const object = (v: unknown, path: string) => (isObject(v) ? v : fail(path, "objet attendu"));
const array = (v: unknown, path: string, max: number) => {
	if (!Array.isArray(v)) return fail(path, "liste attendue");
	return v.length > max ? fail(path, `plus de ${max} éléments`) : v;
};
const text = (v: unknown, path: string, max: number) => {
	if (typeof v !== "string") return fail(path, "texte attendu");
	return v.length > max ? fail(path, `texte de plus de ${max} caractères`) : stripControl(v);
};
const textOrNull = (v: unknown, path: string, max: number) => (v === null ? null : text(v, path, max));

/**
 * Valide un rapport JSON de la CLI (ADR-0014 §4), déjà désérialisé par `JSON.parse` seul.
 * Tout ou rien : lève une erreur dont le message nomme le premier défaut trouvé. Propriétés inconnues ignorées.
 * `knownCriteria` : critères du référentiel (le modèle n'embarque pas les données RGAA).
 */
export function parseAuditReport(json: unknown, knownCriteria: ReadonlySet<string>): ImportableReport {
	try {
		checkKeys(json, "fichier", 0);
		const root = object(json, "fichier");
		const version = field(root, "schemaVersion");
		if (version !== REPORT_SCHEMA_VERSION)
			fail("schemaVersion", `version ${JSON.stringify(version) ?? "absente"} non prise en charge (attendu : 2)`);
		const name = field(object(field(root, "tool"), "tool"), "name");
		if (name !== REPORT_TOOL_NAME) fail("tool.name", `ce fichier n’a pas été produit par la CLI Rampe`);
		let site = "";
		const pages = array(field(root, "pages"), "pages", MAX_PAGES).map((rawPage, i) => {
			const at = `pages[${i}]`;
			const page = object(rawPage, at);
			const rawUrl = text(field(page, "url"), `${at}.url`, MAX_URL);
			let url: URL;
			try {
				url = parseAuditUrl(rawUrl);
			} catch (e) {
				return fail(`${at}.url`, (e as Error).message.replace(/\.$/, ""));
			}
			if (!site) site = url.origin;
			else if (url.origin !== site) fail(`${at}.url`, `autre site que ${site} : un rapport porte sur un seul site`);
			const results = array(field(page, "results"), `${at}.results`, MAX_RESULTS).map((rawResult, j) => {
				const rat = `${at}.results[${j}]`;
				const result = object(rawResult, rat);
				const ruleId = text(field(result, "ruleId"), `${rat}.ruleId`, 100);
				if (!RULE_ID.test(ruleId)) fail(`${rat}.ruleId`, "identifiant de règle mal formé");
				const kind = field(result, "kind");
				if (!RESULT_KINDS.includes(kind as ResultKind)) fail(`${rat}.kind`, `classe inconnue ${JSON.stringify(kind)}`);
				const impact = field(result, "impact");
				if (impact !== undefined && impact !== null && !IMPACTS.includes(impact as string))
					fail(`${rat}.impact`, "impact inconnu");
				const help = field(result, "help");
				const criteria = array(field(result, "criteria"), `${rat}.criteria`, MAX_CRITERIA).map((c, k) => {
					if (typeof c !== "string" || !knownCriteria.has(c))
						fail(`${rat}.criteria[${k}]`, `critère ${JSON.stringify(c)} inexistant dans le référentiel`);
					return c as string;
				});
				return {
					ruleId,
					kind: kind as ResultKind,
					nodes: array(field(result, "nodes"), `${rat}.nodes`, Number.MAX_SAFE_INTEGER).length,
					criteria,
					...(typeof impact === "string" && { impact }),
					...(help !== undefined && { help: text(help, `${rat}.help`, MAX_HELP) }),
				};
			});
			return {
				url: urlKey(url),
				title: textOrNull(field(page, "title"), `${at}.title`, MAX_TITLE)?.trim() ?? "",
				error: textOrNull(field(page, "error"), `${at}.error`, MAX_ERROR),
				results,
			};
		});
		if (pages.length === 0) fail("pages", "le rapport ne contient aucune page");
		return { site, pages };
	} catch (e) {
		// Message court même face à une valeur hostile : jamais de texte importé non borné dans l'erreur.
		if (e instanceof InvalidReport) throw new Error(e.message.slice(0, 500));
		throw e;
	}
}

export interface ImportSummary {
	pagesAdded: number;
	/** Statuts « Non conforme » posés sur des évaluations encore « non testé ». */
	statusesSet: number;
	findingsAdded: number;
	/** Pages du rapport en erreur : rien n'en est importé. */
	pagesSkipped: { url: string; reason: string }[];
}

const sameKey = (a: string, b: string) => {
	try {
		return urlKey(new URL(a)) === b;
	} catch {
		return false;
	}
};

/**
 * Importe un rapport validé (ADR-0014 §1-3), sans modifier la session reçue. Réimporter le même rapport ne change rien.
 * - non-conformité : statut NC (source `auto`, note générée) seulement si l'évaluation est encore « non testé » ;
 * - chaque résultat est aussi rangé comme indice sous ses critères, pour la page : une non-conformité trouvée sur un
 *   critère déjà évalué par l'humain reste ainsi visible, sans toucher à son évaluation ;
 * - pages rapprochées par adresse normalisée ; une page absente est ajoutée ; un autre site est refusé.
 */
export function importAutomaticResults(
	session: AuditSession,
	report: ImportableReport,
	at = new Date().toISOString(),
	newId: () => string = () => crypto.randomUUID(),
): { session: AuditSession; summary: ImportSummary } {
	if (session.site && session.site !== report.site)
		throw new Error(
			`Ce rapport porte sur ${report.site}, mais l’audit en cours porte sur ${session.site}. Un audit porte sur un seul site : rien n’a été importé.`,
		);
	const summary: ImportSummary = { pagesAdded: 0, statusesSet: 0, findingsAdded: 0, pagesSkipped: [] };
	let next = session;
	/** Non-conformités par critère puis page, pour une seule note générée par évaluation. */
	const detected = new Map<string, Map<string, string[]>>();
	for (const page of report.pages) {
		if (page.error !== null) {
			summary.pagesSkipped.push({ url: page.url, reason: page.error });
			continue;
		}
		// ponytail: recherche linéaire (pages × pages, 1000 × 1000 au pire) ; un index par clé si ça devient lent.
		let target = next.pages.find((p) => sameKey(p.url, page.url));
		if (!target) {
			next = addPage(next, { url: page.url, title: page.title }, at, newId());
			target = next.pages[next.pages.length - 1];
			summary.pagesAdded++;
		}
		if (!target) continue;
		const pageId = target.id;
		for (const r of page.results) {
			const finding: Finding = {
				ruleId: r.ruleId,
				kind: r.kind,
				nodes: r.nodes,
				...(r.impact && { impact: r.impact }),
				...(r.help && { help: r.help }),
			};
			for (const criterionId of r.criteria) {
				const list = getFindings(next, criterionId, pageId);
				const same = list.findIndex((f) => f.ruleId === r.ruleId && f.kind === r.kind);
				if (same === -1) summary.findingsAdded++;
				const findings = same === -1 ? [...list, finding] : list.map((f, k) => (k === same ? finding : f));
				next = {
					...next,
					findings: { ...next.findings, [criterionId]: { ...own(next.findings, criterionId), [pageId]: findings } },
				};
				if (r.kind !== "non-conformite") continue;
				const byPage = detected.get(criterionId) ?? new Map<string, string[]>();
				detected.set(criterionId, byPage);
				byPage.set(pageId, [...(byPage.get(pageId) ?? []), `${r.ruleId} (${plural(r.nodes, "élément")})`]);
			}
		}
	}
	for (const [criterionId, byPage] of detected)
		for (const [pageId, rules] of byPage) {
			// La machine ne remplace jamais une évaluation : ni humaine, ni automatique d'un import précédent.
			// Une note saisie sur un critère « non testé » est un travail humain : elle n'est pas remplacée non plus.
			const current = getEvaluation(next, criterionId, pageId);
			if (current.status !== "NT" || current.note.trim() !== "") continue;
			const note = `Détecté automatiquement : ${[...new Set(rules)].join(", ")}`;
			next = setEvaluation(next, criterionId, pageId, { status: "NC", note, source: "auto" }, at);
			summary.statusesSet++;
		}
	return { session: { ...next, updatedAt: at }, summary };
}
