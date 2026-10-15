// Rapport JSON v2 de la CLI (ADR-0011, ADR-0012) et son import dans l'audit guidé (ADR-0014).
// Les types vivent ici pour que la CLI (qui écrit le fichier) et le site (qui le relit) partagent la même forme,
// sans que le site dépende de la CLI. Code pur, sans données RGAA : l'appelant passe les critères existants.

import {
	type AuditSession,
	type Evaluation,
	type Finding,
	isPageId,
	own,
	RESULT_KINDS,
	type ResultKind,
} from "./audit-session.ts";
import type { AxeRuleMapping } from "./axe.ts";
import { parseAuditUrl, plural, stripBidi, urlKey } from "./sample-file.ts";
import {
	array,
	checkKeys,
	display,
	displayOrNull,
	fail,
	field,
	IMPACTS,
	MAX_FINDINGS,
	MAX_PAGES,
	MAX_URL,
	object,
	REPORT_TOOL_NAME,
	ReportError,
	RULE_ID,
	SESSION_TOOL_NAME,
	strictly,
	string,
	toolName,
} from "./strict.ts";

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
export { MAX_FINDINGS, MAX_REPORT_BYTES, REPORT_TOOL_NAME, ReportError } from "./strict.ts";

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
// La structure, les adresses, les critères, les classes et les nombres font rejeter le fichier ; les textes
// seulement affichés (titre, erreur de page, description de règle) sont tronqués.
const MAX_RESULTS = 1000;
const MAX_CRITERIA = 200;
const MAX_TITLE = 300;
const MAX_ERROR = 500;
const MAX_HELP = 300;

export const INVALID_REPORT =
	"Ce fichier n’est pas un rapport de la CLI Rampe, ou il a été modifié. Rien n’a été importé.";
/** Audit complet donné au champ du rapport (ADR-0016) : on oriente vers le bon champ. */
export const SESSION_GIVEN_AS_REPORT =
	"Ce fichier est un audit Rampe complet (téléchargé depuis l’audit guidé), pas un rapport de la CLI : importez-le avec le champ « Importer un audit (JSON) », section « Sauvegarde de l’audit ». Rien n’a été importé.";

/**
 * Valide un rapport JSON de la CLI (ADR-0014 §4), déjà désérialisé par `JSON.parse` seul.
 * Tout ou rien : lève une `ReportError` dont `detail` nomme le premier défaut trouvé. Propriétés inconnues ignorées.
 * `knownCriteria` : critères du référentiel (le modèle n'embarque pas les données RGAA).
 */
export function parseAuditReport(json: unknown, knownCriteria: ReadonlySet<string>): ImportableReport {
	return strictly(INVALID_REPORT, () => parseReport(json, knownCriteria));
}

function parseReport(json: unknown, knownCriteria: ReadonlySet<string>): ImportableReport {
	checkKeys(json, "fichier");
	const root = object(json, "fichier");
	if (toolName(root) === SESSION_TOOL_NAME) throw new ReportError(SESSION_GIVEN_AS_REPORT);
	const version = field(root, "schemaVersion");
	if (version !== REPORT_SCHEMA_VERSION)
		fail("schemaVersion", `version ${JSON.stringify(version) ?? "absente"} non prise en charge (attendu : 2)`);
	const name = field(object(field(root, "tool"), "tool"), "name");
	if (name !== REPORT_TOOL_NAME) fail("tool.name", `ce fichier n’a pas été produit par la CLI Rampe`);
	let site = "";
	let findings = 0;
	const pages = array(field(root, "pages"), "pages", MAX_PAGES).map((rawPage, i) => {
		const at = `pages[${i}]`;
		const page = object(rawPage, at);
		const rawUrl = string(field(page, "url"), `${at}.url`);
		if (rawUrl.length > MAX_URL) fail(`${at}.url`, `adresse de plus de ${MAX_URL} caractères`);
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
			const ruleId = string(field(result, "ruleId"), `${rat}.ruleId`);
			if (ruleId.length > 100 || !RULE_ID.test(ruleId)) fail(`${rat}.ruleId`, "identifiant de règle mal formé");
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
			findings += criteria.length;
			if (findings > MAX_FINDINGS)
				fail(`${rat}.criteria`, `plus de ${MAX_FINDINGS.toLocaleString("fr-FR")} indices dans le rapport`);
			return {
				ruleId,
				kind: kind as ResultKind,
				nodes: array(field(result, "nodes"), `${rat}.nodes`, Number.MAX_SAFE_INTEGER).length,
				criteria,
				...(typeof impact === "string" && { impact }),
				...(help !== undefined && { help: display(help, `${rat}.help`, MAX_HELP) }),
			};
		});
		return {
			url: urlKey(url),
			title: displayOrNull(field(page, "title"), `${at}.title`, MAX_TITLE) ?? "",
			error: displayOrNull(field(page, "error"), `${at}.error`, MAX_ERROR),
			results,
		};
	});
	if (pages.length === 0) fail("pages", "le rapport ne contient aucune page");
	return { site, pages };
}

export interface ImportSummary {
	pagesAdded: number;
	/** Statuts « Non conforme » posés là où aucune évaluation n'existait. */
	statusesSet: number;
	/** Indices nouveaux (absents avant l'import pour la même page, le même critère, la même règle et la même classe). */
	findingsAdded: number;
	/** Pages du rapport en erreur : rien n'en est importé. */
	pagesSkipped: { url: string; reason: string }[];
}

/**
 * Importe un rapport validé (ADR-0014 §1-3), sans modifier la session reçue. Réimporter le même rapport ne change rien.
 * - non-conformité : statut NC (source `auto`, note générée) seulement si AUCUNE évaluation n'est enregistrée pour ce
 *   critère et cette page (un « non testé » remis par l'humain est un choix humain) ;
 * - chaque résultat est rangé comme indice sous ses critères, pour la page : une non-conformité trouvée sur un critère
 *   déjà évalué par l'humain reste ainsi visible, sans toucher à son évaluation ;
 * - les indices d'une page du rapport REMPLACENT ceux qu'elle avait : un rapport plus récent ne laisse pas d'indice
 *   périmé ; les pages absentes du rapport gardent les leurs ;
 * - pages rapprochées par adresse normalisée ; une page absente est ajoutée ; un autre site est refusé.
 */
export function importAutomaticResults(
	session: AuditSession,
	report: ImportableReport,
	at = new Date().toISOString(),
	newId: () => string = () => crypto.randomUUID(),
): { session: AuditSession; summary: ImportSummary } {
	if (session.site && session.site !== report.site)
		throw new ReportError(
			`Ce rapport porte sur un autre site (${report.site}) que l’audit en cours (${session.site}). Un audit porte sur un seul site : rien n’a été importé.`,
		);
	const summary: ImportSummary = { pagesAdded: 0, statusesSet: 0, findingsAdded: 0, pagesSkipped: [] };
	// Copies faites une seule fois, puis modifiées sur place : la session reçue n'est jamais touchée.
	const pages = [...session.pages];
	const evaluations = { ...session.evaluations };
	const findings = { ...session.findings };
	const copied = { evaluations: new Set<string>(), findings: new Set<string>() };
	function writable<T>(map: Record<string, Record<string, T>>, which: keyof typeof copied, criterionId: string) {
		if (!copied[which].has(criterionId)) {
			map[criterionId] = { ...own(map, criterionId) };
			copied[which].add(criterionId);
		}
		return map[criterionId] as Record<string, T>;
	}
	const byUrl = new Map<string, string>();
	for (const p of pages) {
		try {
			const key = urlKey(new URL(p.url));
			if (!byUrl.has(key)) byUrl.set(key, p.id);
		} catch {}
	}
	/** Pages dont les anciens indices ont été retirés, avec leurs clés `critère|classe|règle` d'avant l'import. */
	const previous = new Map<string, Set<string>>();
	/** Non-conformités par critère puis page, pour une seule note générée par évaluation. */
	const detected = new Map<string, Map<string, string[]>>();

	for (const page of report.pages) {
		if (page.error !== null) {
			summary.pagesSkipped.push({ url: page.url, reason: page.error });
			continue;
		}
		let pageId = byUrl.get(page.url);
		if (!pageId) {
			pageId = newId();
			if (!isPageId(pageId) || pages.some((p) => p.id === pageId)) throw new Error(`Id de page invalide : ${pageId}`);
			pages.push({ id: pageId, url: page.url, title: stripBidi(page.title) });
			byUrl.set(page.url, pageId);
			summary.pagesAdded++;
		}
		let before = previous.get(pageId);
		if (!before) {
			before = new Set();
			previous.set(pageId, before);
			for (const criterionId of Object.keys(findings)) {
				const list = own(findings[criterionId] ?? {}, pageId);
				if (!list) continue;
				for (const f of list) before.add(`${criterionId}|${f.kind}|${f.ruleId}`);
				delete writable(findings, "findings", criterionId)[pageId];
			}
		}
		for (const r of page.results) {
			const finding: Finding = {
				ruleId: r.ruleId,
				kind: r.kind,
				nodes: r.nodes,
				...(r.impact && { impact: r.impact }),
				...(r.help && { help: r.help }),
			};
			for (const criterionId of r.criteria) {
				const byPage = writable(findings, "findings", criterionId);
				const list = own(byPage, pageId) ?? [];
				byPage[pageId] = list; // liste créée par cet import : la modifier ne touche pas la session reçue
				const same = list.findIndex((f) => f.ruleId === r.ruleId && f.kind === r.kind);
				if (same !== -1) list[same] = finding;
				else {
					list.push(finding);
					if (!before.has(`${criterionId}|${r.kind}|${r.ruleId}`)) summary.findingsAdded++;
				}
				if (r.kind !== "non-conformite") continue;
				const nc = detected.get(criterionId) ?? new Map<string, string[]>();
				detected.set(criterionId, nc);
				nc.set(pageId, [...(nc.get(pageId) ?? []), `${r.ruleId} (${plural(r.nodes, "élément")})`]);
			}
		}
	}
	for (const [criterionId, byPage] of detected)
		for (const [pageId, rules] of byPage) {
			// La machine ne remplace jamais une évaluation enregistrée : humaine (même « non testé »), ni automatique.
			const stored = own(evaluations, criterionId);
			if (stored && own(stored, pageId)) continue;
			const evaluation: Evaluation = {
				status: "NC",
				note: `Détecté automatiquement : ${[...new Set(rules)].join(", ")}`,
				source: "auto",
			};
			writable(evaluations, "evaluations", criterionId)[pageId] = evaluation;
			summary.statusesSet++;
		}
	// Critères vidés par le remplacement des indices : retirés, comme removePage le fait.
	for (const criterionId of copied.findings)
		if (Object.keys(findings[criterionId] ?? {}).length === 0) delete findings[criterionId];
	const site = session.site || (pages.length > 0 ? report.site : "");
	return { session: { ...session, site, updatedAt: at, pages, evaluations, findings }, summary };
}
