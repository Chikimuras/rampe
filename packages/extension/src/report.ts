// Logique pure de l'extension (ADR-0019) : refus des pages non analysables, rapport JSON v2, regroupement par critère.
// Classement et forme du rapport viennent de @rampe/core, comme pour la CLI (ADR-0019 §4).
import {
	type AuditReport,
	type AuditResult,
	type AxeRawResult,
	buildReport,
	byNumber,
	classifyResults,
	type ResultKind,
	redact,
	TITLE_MAX,
	truncate,
} from "@rampe/core";

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
	if (!url) throw new Error(NO_ACCESS);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(NO_ACCESS);
	}
	if (parsed.protocol === "file:")
		throw new Error(
			"Rampe n’analyse pas les fichiers ouverts depuis l’ordinateur. Servez la page avec un serveur web (http://localhost…), ou publiez-la.",
		);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		throw new Error(
			"Rampe n’analyse que les pages web (adresses http:// ou https://). Les pages internes du navigateur et des extensions ne peuvent pas être analysées.",
		);
	if (
		STORES.includes(parsed.hostname) ||
		(parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
	)
		throw new Error("Le navigateur interdit aux extensions d’analyser les magasins d’extensions.");
	return parsed;
}

/** Version du navigateur, lue dans l'agent utilisateur (« Chrome 156.0.8078.4 », « Firefox 157.0 »). */
export const browserName = (userAgent: string) => {
	// Edge se déclare aussi « Chrome » : il est cherché d'abord.
	for (const [token, name] of [
		["Edg", "Edge"],
		["Firefox", "Firefox"],
		["Chrome", "Chrome"],
	]) {
		const m = new RegExp(`\\b${token}/([\\d.]+)`).exec(userAgent);
		if (m) return `${name} ${m[1]}`;
	}
	return "inconnu";
};

/** Rapport v2, même structure que celui de la CLI ; `tool.name` : `@rampe/extension` (ADR-0014 §4). */
export function buildExtensionReport(input: {
	version: string;
	startedAt: Date;
	browser: string;
	run: PageRun;
}): AuditReport {
	const { run } = input;
	// La page a pu naviguer pendant l'analyse : on ne rapporte que du http(s).
	const url = redact(checkTabUrl(run.url).href);
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
