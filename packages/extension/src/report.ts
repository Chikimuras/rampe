// Logique pure de l'extension (ADR-0019) : refus des pages non analysables, rapport JSON v2, regroupement par critère.
// Classement et forme du rapport viennent de @rampe/core, comme pour la CLI (ADR-0019 §4).
// Points d'entrée légers de @rampe/core : ni glossaire ni méthodologies dans le panneau.
import type { AuditReport, AuditResult, ResultKind } from "@rampe/core/audit-report";
import { type AxeRawResult, buildReport, byNumber, classifyResults, TITLE_MAX } from "@rampe/core/axe-results";
import { plural, truncate, urlKey } from "@rampe/core/sample-file";

/** Erreur expliquée à l'utilisateur, en français : affichée telle quelle, sans détail technique. */
export class UserError extends Error {}

/** Ce que le script injecté dans l'onglet renvoie (voir `runAxe` dans popup.ts). */
export interface PageRun {
	url: string;
	title: string;
	axeVersion: string;
	violations: AxeRawResult[];
	incomplete: AxeRawResult[];
}

export const NO_ACCESS =
	"Rampe n’a pas accès à cet onglet. Ouvrez la page à analyser, puis cliquez sur l’icône de Rampe dans la barre d’outils.";

// Le navigateur interdit aux extensions d'agir sur ses magasins d'extensions, même en http(s).
const STORES = ["chromewebstore.google.com", "addons.mozilla.org", "microsoftedge.microsoft.com"];

/**
 * Adresse de l'onglet, si Rampe peut l'analyser : http(s) uniquement (ADR-0011 §6, ADR-0019 §5).
 * `url` est absente quand l'extension n'a pas la permission de voir l'onglet (activeTab non accordée).
 */
export function checkTabUrl(url: string | undefined): URL {
	if (!url) throw new UserError(NO_ACCESS);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UserError(NO_ACCESS);
	}
	if (parsed.protocol === "file:")
		throw new UserError(
			"Rampe n’analyse pas les fichiers ouverts depuis l’ordinateur. Servez la page avec un serveur web (http://localhost…), ou publiez-la.",
		);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new UserError(
			"Rampe n’analyse que les pages web (adresses http:// ou https://). Les pages internes du navigateur et des extensions ne peuvent pas être analysées.",
		);
	if (
		STORES.includes(parsed.hostname) ||
		(parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
	)
		throw new UserError("Le navigateur interdit aux extensions d’analyser les magasins d’extensions.");
	return parsed;
}

/** Types de documents analysables : axe-core ne vaut que pour du HTML. */
const HTML_TYPES = ["text/html", "application/xhtml+xml"];

/** Refuse un document qui n'est pas du HTML (PDF, image, texte brut…), d'après `document.contentType`. */
export function checkContentType(type: string): void {
	if (!HTML_TYPES.includes(type))
		throw new UserError(
			`Rampe n’analyse que les pages HTML. Ce document est de type « ${type.slice(0, 100)} » (PDF, image, texte…) : son accessibilité se vérifie à la main, avec un outil adapté à ce format.`,
		);
}

/** Durée maximale d'une analyse, injection comprise (comme le délai par défaut de la CLI). */
export const ANALYSIS_TIMEOUT_MS = 60_000;
export const TIMEOUT_MESSAGE = `L’analyse a dépassé ${ANALYSIS_TIMEOUT_MS / 1000} secondes : la page est peut-être bloquée par un script. Rechargez-la, puis relancez l’analyse.`;

/** Rejette avec `TIMEOUT_MESSAGE` si `work` n'a pas abouti en `ms` millisecondes. */
export function withTimeout<T>(work: Promise<T>, ms = ANALYSIS_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new UserError(TIMEOUT_MESSAGE)), ms);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export const PAGE_CHANGED = "La page a changé pendant l’analyse : relancez-la.";
/** Détail technique d'une injection sans résultat (document remplacé pendant l'analyse). */
export const NO_RESULT = "scripting.executeScript : aucun résultat renvoyé (document remplacé ?)";

/**
 * Message en français d'une erreur d'analyse ; `detail` : message technique d'origine (affiché replié), nul pour une
 * `UserError`. `started` : l'onglet était déjà accessible (une injection a réussi) ; un refus vient alors d'un
 * changement de page (navigation, fermeture), qui retire la permission activeTab.
 */
export function explainError(e: unknown, started: boolean): { message: string; detail: string | null } {
	if (e instanceof UserError) return { message: e.message, detail: null };
	const detail = (e instanceof Error ? e.message : String(e)).slice(0, 500);
	const known: [RegExp, string][] = [
		[/extensions gallery|webstore/i, "Le navigateur interdit aux extensions d’analyser les magasins d’extensions."],
		[
			/aucun résultat|removed|No tab with id|Invalid tab|destroyed|disconnected|navigat|unloaded|Frame not found/i,
			PAGE_CHANGED,
		],
		[/Cannot access|host permission|permission to access/i, started ? PAGE_CHANGED : NO_ACCESS],
		[/error page/i, "La page affiche une erreur du navigateur : rechargez-la, puis relancez l’analyse."],
	];
	const message =
		known.find(([re]) => re.test(detail))?.[1] ?? "L’analyse a échoué. Rechargez la page, puis relancez-la.";
	return { message, detail };
}

/** Version du navigateur, lue dans l'agent utilisateur (« Chrome 156.0.0.0 » : version réduite chez Chromium). */
export const browserName = (userAgent: string) => {
	// Edge se déclare aussi « Chrome » : il est cherché d'abord ; le mode headless se déclare « HeadlessChrome ».
	for (const [token, name] of [
		["Edg", "Edge"],
		["Firefox", "Firefox"],
		["HeadlessChrome", "Chrome"],
		["Chrome", "Chrome"],
	]) {
		const m = new RegExp(`\\b${token}/([\\d.]+)`).exec(userAgent);
		if (m) return `${name} ${m[1]}`;
	}
	return "inconnu";
};

/** Version complète d'un navigateur Chromium (`userAgentData.getHighEntropyValues(["fullVersionList"])`), ou null. */
export function browserFromBrands(brands: readonly { brand: string; version: string }[] | undefined): string | null {
	for (const [brand, name] of [
		["Microsoft Edge", "Edge"],
		["Opera", "Opera"],
		["Google Chrome", "Chrome"],
		["Chromium", "Chrome"],
		["HeadlessChrome", "Chrome"],
	]) {
		const b = brands?.find((x) => x.brand === brand);
		if (b) return `${name} ${b.version}`;
	}
	return null;
}

/** Rapport v2, même structure que celui de la CLI ; `tool.name` : `@rampe/extension` (ADR-0014 §4). */
export function buildExtensionReport(input: {
	version: string;
	startedAt: Date;
	browser: string;
	run: PageRun;
}): AuditReport {
	const { run } = input;
	// La page a pu naviguer pendant l'analyse : on ne rapporte que du http(s). Fragment et identifiants retirés
	// (OWASP User Privacy Protection Cheat Sheet) ; la requête reste, elle peut être nécessaire pour retrouver la page.
	const url = urlKey(checkTabUrl(run.url));
	return buildReport({
		tool: { name: "@rampe/extension", version: input.version },
		startedAt: input.startedAt,
		axeVersion: run.axeVersion,
		browserVersion: input.browser,
		pages: [
			{
				url,
				finalUrl: url,
				title: truncate(run.title, TITLE_MAX),
				warnings: [],
				results: classifyResults(run.violations, run.incomplete),
				error: null,
			},
		],
	});
}

/** Nom du fichier téléchargé : `rampe-<hôte>-<date>.json`. */
export const reportFileName = (report: AuditReport) => {
	const host = new URL(report.pages[0]?.url ?? "https://page.invalid").hostname.replace(/[^a-z0-9.-]/gi, "_");
	return `rampe-${host}-${report.startedAt.slice(0, 10)}.json`;
};

/** Catégories de la CLI (ADR-0011 §3), dans l'ordre d'affichage. */
export const CATEGORIES: { kind: ResultKind; title: string }[] = [
	{ kind: "non-conformite", title: "Non-conformités détectées" },
	{ kind: "incertain", title: "Problèmes détectés, rattachement RGAA incertain" },
	{ kind: "a-verifier", title: "À vérifier par un humain" },
	{ kind: "bonne-pratique", title: "Bonnes pratiques (hors conformité RGAA)" },
];

/** Résultats d'une catégorie rangés par critère RGAA (ordre naturel) ; `null` : aucun critère rattaché. */
export function groupByCriterion(results: AuditResult[], kind: ResultKind): [string | null, AuditResult[]][] {
	const of = results.filter((r) => r.kind === kind);
	const ids = [...new Set(of.flatMap((r) => r.criteria))].sort(byNumber);
	const groups: [string | null, AuditResult[]][] = ids.map((id) => [id, of.filter((r) => r.criteria.includes(id))]);
	const none = of.filter((r) => r.criteria.length === 0);
	if (none.length > 0) groups.push([null, none]);
	return groups;
}

/** Phrase d'état après l'analyse ; signale les cadres (iframes) non analysés (règle `frame-tested` d'axe). */
export function summary(report: AuditReport): string {
	const results = report.pages[0]?.results ?? [];
	const nc = results.filter((r) => r.kind === "non-conformite");
	const criteria = new Set(nc.flatMap((r) => r.criteria)).size;
	const main =
		nc.length === 0
			? "Analyse terminée : aucune non-conformité détectée automatiquement. Vérifiez quand même chaque critère à la main."
			: `Analyse terminée : ${plural(nc.length, "règle")} en non-conformité, sur ${plural(criteria, "critère")}.`;
	const frames = results.find((r) => r.ruleId === "frame-tested");
	return frames
		? `${main} ${plural(frames.nodes.length, "cadre")} (iframe) non analysé${frames.nodes.length > 1 ? "s" : ""} : vérifiez-les à part.`
		: main;
}
