// Panneau de l'extension (ADR-0019) : analyse l'onglet courant au clic, affiche les résultats par critère RGAA,
// propose le rapport JSON v2. Tout texte venu de la page est inséré comme TEXTE (textContent), jamais comme HTML
// (OWASP Cross Site Scripting Prevention Cheat Sheet, « Safe Sinks »).
// Points d'entrée légers de @rampe/core : ni glossaire ni méthodologies dans le panneau.
import type { AuditReport, AuditResult } from "@rampe/core/audit-report";
import { NODE_HTML_MAX, plainTitle, selector } from "@rampe/core/axe-results";
import { baseCriteria } from "@rampe/core/criteres";
import { plural, stripControl } from "@rampe/core/sample-file";
import {
	browserFromBrands,
	browserName,
	buildExtensionReport,
	CATEGORIES,
	checkContentType,
	checkTabUrl,
	explainError,
	groupByCriterion,
	NO_RESULT,
	type PageRun,
	reportFileName,
	summary,
	withTimeout,
} from "./report.ts";

/** Critères sans vérification automatique directe : calculé au build depuis axe-core (vite.config.ts). */
declare const __RAMPE_UNCOVERED__: number;

// Sous-ensemble des API d'extension utilisées : espace `browser` (Firefox, promesses garanties), sinon `chrome`.
interface ExtensionApi {
	runtime: { getManifest(): { version: string } };
	tabs: { query(q: { active: true; currentWindow: true }): Promise<{ id?: number; url?: string }[]> };
	scripting: {
		executeScript<T>(d: {
			target: { tabId: number };
			files?: string[];
			func?: () => T;
		}): Promise<{ result?: Awaited<T> }[]>;
	};
}
declare const chrome: ExtensionApi;
const api = () => (globalThis as { browser?: ExtensionApi }).browser ?? chrome;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const analyse = $("analyser") as HTMLButtonElement;
const status = $("etat");
const section = $("resultats");
const technical = $("detail") as HTMLDetailsElement;
let report: AuditReport | null = null;
/** Analyse en cours : le bouton reste focalisable (aria-disabled) pour que le focus ne se perde pas. */
let running = false;

/** Élément dont les enfants sont des nœuds ou du texte (jamais interprété comme HTML). */
function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	e.append(...children);
	return e;
}

$("rappel").textContent =
	`Les ${baseCriteria.length} critères demandent une vérification humaine ; ${__RAMPE_UNCOVERED__} n’en ont aucune vérification automatique directe. Ce résultat ne mesure pas la conformité et ne la certifie pas : aucun score n’est calculé.`;

$("partage").textContent =
	`Avant de partager ce rapport, relisez-le : il contient l’adresse de la page avec ses paramètres, et des extraits du code de la page (jusqu’à ${NODE_HTML_MAX} caractères par élément en défaut), qui peuvent contenir des données personnelles.`;

/** Exécuté dans l'onglet (monde isolé de l'extension) : la page ne peut ni lire ni modifier axe. */
async function runAxe(): Promise<PageRun> {
	const axe = (globalThis as unknown as { axe: typeof import("axe-core") }).axe;
	// Configuration par défaut, comme la CLI (ADR-0011 §2).
	const r = await axe.run();
	const keep = (list: typeof r.violations) =>
		list.map((x) => ({
			id: x.id,
			help: x.help,
			tags: x.tags,
			impact: x.impact ?? null,
			nodes: x.nodes.map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
		}));
	return {
		url: location.href,
		title: document.title,
		axeVersion: axe.version,
		violations: keep(r.violations),
		incomplete: keep(r.incomplete),
	};
}

function ruleItem(r: AuditResult, criterion: string | null) {
	const tests = criterion ? r.tests.filter((t) => t.startsWith(`${criterion}.`)) : [];
	const where = [
		tests.length > 0 && `test${tests.length > 1 ? "s" : ""} ${tests.join(", ")}`,
		r.level === "wcag" && `via WCAG ${r.wcag.join(", ")}`,
		r.kind === "incertain" &&
			r.level === "rgaa" &&
			`règle ${r.flags.bestPractice ? "indicative" : "expérimentale"} d’axe : à confirmer par une personne`,
	].filter(Boolean);
	const first = r.nodes[0] ? `, ex. ${selector(r.nodes[0].target)}` : "";
	return el(
		"li",
		{},
		el("code", {}, r.ruleId),
		where.length > 0 ? ` (${where.join(" ; ")})` : "",
		...(r.help ? [" — ", el("span", { lang: "en" }, stripControl(r.help))] : []),
		` : ${plural(r.nodes.length, "élément")}${first}`,
	);
}

function render(rep: AuditReport) {
	const page = rep.pages[0];
	if (!page) return;
	$("page").textContent =
		`${stripControl(page.title ?? "") || "(sans titre)"} — ${stripControl(page.finalUrl ?? page.url)}`;
	const blocks = CATEGORIES.map(({ kind, title }) => {
		const groups = groupByCriterion(page.results, kind);
		const block = el("section", {}, el("h3", {}, title));
		if (groups.length === 0) block.append(el("p", {}, "Aucun résultat."));
		for (const [id, results] of groups)
			block.append(
				el("h4", {}, id ? `Critère ${id} — ${plainTitle(id)}` : "Sans critère RGAA rattaché"),
				el("ul", {}, ...results.map((r) => ruleItem(r, id))),
			);
		return block;
	});
	$("categories").replaceChildren(...blocks);
	section.hidden = false;
}

function say(text: string, error = false, detail: string | null = null) {
	status.textContent = text;
	status.classList.toggle("erreur", error);
	technical.hidden = detail === null;
	technical.open = false;
	$("detail-texte").textContent = detail ?? "";
}

/** Version complète du navigateur si Chromium la donne (comparable à la CLI), sinon celle de l'agent utilisateur. */
async function browserVersion() {
	const data = (
		navigator as {
			userAgentData?: {
				getHighEntropyValues(h: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
			};
		}
	).userAgentData;
	const full = await data?.getHighEntropyValues(["fullVersionList"]).catch(() => undefined);
	return browserFromBrands(full?.fullVersionList) ?? browserName(navigator.userAgent);
}

async function analyseTab() {
	const [tab] = await api().tabs.query({ active: true, currentWindow: true });
	checkTabUrl(tab?.url);
	const target = { tabId: tab?.id as number };
	const startedAt = new Date();
	const state = { started: false };
	try {
		const [probe] = await api().scripting.executeScript({ target, func: () => document.contentType });
		state.started = true;
		checkContentType(probe?.result ?? "");
		// axe-core embarqué, jamais chargé à distance (ADR-0019 §3) ; injecté au clic seulement (activeTab).
		await api().scripting.executeScript({ target, files: ["axe.min.js"] });
		const [injection] = await api().scripting.executeScript({ target, func: runAxe });
		// Le navigateur renvoie un résultat vide quand le document a été remplacé pendant l'analyse.
		if (!injection?.result) throw new Error(NO_RESULT);
		return buildExtensionReport({
			version: api().runtime.getManifest().version,
			startedAt,
			browser: await browserVersion(),
			run: injection.result,
		});
	} catch (e) {
		throw Object.assign(new Error(), { explained: explainError(e, state.started) });
	}
}

analyse.addEventListener("click", async () => {
	if (running) return;
	running = true;
	analyse.setAttribute("aria-disabled", "true");
	section.hidden = true;
	report = null;
	say("Analyse en cours…");
	try {
		const rep = await withTimeout(analyseTab());
		report = rep;
		render(rep);
		say(summary(rep));
	} catch (e) {
		const { message, detail } =
			(e as { explained?: ReturnType<typeof explainError> }).explained ?? explainError(e, false);
		say(stripControl(message), true, detail && stripControl(detail));
	} finally {
		running = false;
		analyse.removeAttribute("aria-disabled");
	}
});

$("telecharger").addEventListener("click", () => {
	if (!report) return;
	// Fichier construit localement (Blob) : aucune requête réseau.
	const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }));
	const a = el("a", { href: url, download: reportFileName(report) });
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
});
