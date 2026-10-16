// Panneau de l'extension (ADR-0019) : analyse l'onglet courant au clic, affiche les résultats par critère RGAA,
// propose le rapport JSON v2. Tout texte venu de la page est inséré comme TEXTE (textContent), jamais comme HTML
// (OWASP Cross Site Scripting Prevention Cheat Sheet, « Safe Sinks »).
import { type AuditReport, type AuditResult, plainTitle, plural, rgaa, selector, stripControl } from "@rampe/core";
import {
	browserName,
	buildExtensionReport,
	CATEGORIES,
	checkTabUrl,
	groupByCriterion,
	type PageRun,
	reportFileName,
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
let report: AuditReport | null = null;

/** Élément dont les enfants sont des nœuds ou du texte (jamais interprété comme HTML). */
function el(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	e.append(...children);
	return e;
}

$("rappel").textContent =
	`Les ${rgaa.criteria.length} critères demandent une vérification humaine ; ${__RAMPE_UNCOVERED__} n’en ont aucune vérification automatique directe. Ce résultat ne mesure pas la conformité et ne la certifie pas : aucun score n’est calculé.`;

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

function summary(rep: AuditReport) {
	const results = rep.pages[0]?.results ?? [];
	const nc = results.filter((r) => r.kind === "non-conformite");
	const criteria = new Set(nc.flatMap((r) => r.criteria)).size;
	return nc.length === 0
		? "Analyse terminée : aucune non-conformité détectée automatiquement. Vérifiez quand même chaque critère à la main."
		: `Analyse terminée : ${plural(nc.length, "règle")} en non-conformité, sur ${plural(criteria, "critère")}.`;
}

function say(text: string, error = false) {
	status.textContent = text;
	status.classList.toggle("erreur", error);
}

analyse.addEventListener("click", async () => {
	analyse.disabled = true;
	section.hidden = true;
	report = null;
	say("Analyse en cours…");
	try {
		const [tab] = await api().tabs.query({ active: true, currentWindow: true });
		checkTabUrl(tab?.url);
		const tabId = tab?.id as number;
		const startedAt = new Date();
		// axe-core embarqué, jamais chargé à distance (ADR-0019 §3) ; injecté au clic seulement (activeTab).
		await api().scripting.executeScript({ target: { tabId }, files: ["axe.min.js"] });
		const [injection] = await api().scripting.executeScript({ target: { tabId }, func: runAxe });
		if (!injection?.result) throw new Error("L’analyse n’a renvoyé aucun résultat.");
		report = buildExtensionReport({
			version: api().runtime.getManifest().version,
			startedAt,
			browser: browserName(navigator.userAgent),
			run: injection.result,
		});
		render(report);
		say(summary(report));
	} catch (e) {
		say(stripControl((e as Error).message || "L’analyse a échoué."), true);
	} finally {
		analyse.disabled = false;
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
