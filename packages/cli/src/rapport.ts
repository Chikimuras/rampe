// Rapport HTML autonome, sans JavaScript, lui-même accessible (ADR-0011 §4), généré à partir du JSON v2.
// Toute donnée venue de la page auditée ou de l'URL passe par `text`/`data` : contrôles bidi retirés puis `escapeHtml`
// (ADR-0011 §6 ; OWASP Cross Site Scripting Prevention Cheat Sheet, « Output Encoding » pour le contexte HTML), et
// isolée du texte de Rampe (`<bdi>`, ou `unicode-bidi: isolate` en CSS) : une page malveillante ne doit pas piéger son
// rapport, ni retourner visuellement le verdict qui suit son titre.
import { rgaa, topicIntros } from "@rampe/core";
import axe from "axe-core";
import {
	type AuditPage,
	type AuditReport,
	type AuditResult,
	byNumber,
	plainTitle,
	plural,
	type ResultKind,
	selector,
	stripBidi,
	truncate,
	uncoveredCriteria,
} from "./audit.ts";

const SITE = "https://chikimuras.github.io/rampe";
const OBLIGATIONS = "https://accessibilite.numerique.gouv.fr/obligations/";
/** Longueur maximale affichée d'un titre de page ou d'un sélecteur. */
const SHORT_MAX = 300;

/** Encodage du contexte HTML (contenu et attributs entre guillemets) : & < > " '. */
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);

/** Donnée externe dans du texte : contrôles bidi retirés, puis échappée. */
const text = (s: string, max = Number.POSITIVE_INFINITY) => escapeHtml(stripBidi(truncate(s, max)));
/** Donnée externe en ligne, isolée du texte de Rampe qui l'entoure. */
const data = (s: string, max?: number) => `<bdi>${text(s, max)}</bdi>`;

/** Lien seulement vers une adresse http(s) ; sinon le texte seul (défense en profondeur). */
const link = (href: string, label: string) =>
	/^https?:\/\//i.test(href) ? `<a href="${escapeHtml(stripBidi(href))}">${label}</a>` : label;

const criterionUrl = (id: string) => `${SITE}/referentiel/${id.replace(".", "-")}/`;
const anchor = (id: string) => `critere-${id.replace(".", "-")}`;
const where = (p: AuditPage) => p.finalUrl ?? p.url;

/** Description courte de chaque règle par axe (en anglais). */
const HELP = new Map(axe.getRules().map((r) => [r.ruleId, r.help]));
const ruleName = (rule: string) => {
	const help = HELP.get(rule);
	return `<code>${text(rule)}</code>${help ? ` « <span lang="en">${text(help)}</span> »` : ""}`;
};

interface Hit {
	page: AuditPage;
	result: AuditResult;
}

/** Regroupe par règle, dans l'ordre d'apparition. */
function byRule(hits: Hit[]): Map<string, Hit[]> {
	const map = new Map<string, Hit[]>();
	for (const h of hits) map.set(h.result.ruleId, [...(map.get(h.result.ruleId) ?? []), h]);
	return map;
}

const pageCount = (hits: Hit[]) => new Set(hits.map((h) => h.page)).size;
const nodeCount = (hits: Hit[]) => hits.reduce((n, h) => n + h.result.nodes.length, 0);
const upperFirst = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const s = (n: number) => (n > 1 ? "s" : "");

/** Éléments en défaut d'une règle, page par page, repliés. */
function elements(hits: Hit[]): string {
	return hits
		.map(({ page, result }) => {
			const n = result.nodes.length;
			const items = result.nodes
				.map(
					(node) => `<li>
<p>Élément : <code>${text(selector(node.target), SHORT_MAX)}</code></p>
<pre><code>${text(node.html)}</code></pre>${
						node.failureSummary
							? `\n<p class="diag">Diagnostic d’axe, en anglais : <span lang="en">${text(node.failureSummary)}</span></p>`
							: ""
					}
</li>`,
				)
				.join("\n");
			return `<details>
<summary>Voir ${n > 1 ? `les ${n} éléments concernés` : "l’élément concerné"} par ${text(result.ruleId)} sur ${data(where(page))}</summary>
<ol class="nodes">
${items}
</ol>
</details>`;
		})
		.join("\n");
}

const critLinks = (ids: string[]) => ids.map((c) => link(criterionUrl(c), c)).join(", ");

/** Rattachement d'une règle hors non-conformité, en une phrase sans parenthèses imbriquées. */
function attachment(r: AuditResult): string {
	const n = r.criteria.length;
	const tests = r.tests.length > 0 ? ` (test${s(r.tests.length)} ${r.tests.join(", ")})` : "";
	if (r.kind === "bonne-pratique") return "hors conformité RGAA";
	if (r.level === "wcag") {
		const possible =
			n > 3
				? `${n} critères RGAA possibles, listés ci-dessous`
				: `critère${s(n)} RGAA possible${s(n)} : ${critLinks(r.criteria)}`;
		return `lié au critère de succès WCAG ${r.wcag.join(", ")} ; ${possible}`;
	}
	if (n === 0) return "sans critère RGAA associé";
	const base = `lié au critère${s(n)} ${critLinks(r.criteria)}${tests}`;
	if (r.kind !== "incertain") return base;
	return r.flags.bestPractice
		? `${base}, mais axe classe cette règle comme indicative : à confirmer par une personne`
		: `${base}, mais c’est une règle expérimentale d’axe : à confirmer par une personne`;
}

/** Liste repliée des critères possibles quand il y en a plus de 3 (niveau wcag). */
const possibleList = (r: AuditResult) =>
	r.level === "wcag" && r.criteria.length > 3
		? `<details><summary>Voir les ${r.criteria.length} critères RGAA possibles</summary><p>${critLinks(r.criteria)}</p></details>`
		: "";

const KINDS: { kind: Exclude<ResultKind, "non-conformite">; title: string; id: string; intro: string }[] = [
	{
		kind: "incertain",
		title: "Rattachement incertain",
		id: "incertains",
		intro:
			"Un problème a été détecté, mais son lien avec un critère RGAA précis doit être confirmé par une personne. Ce n’est pas, à lui seul, une non-conformité.",
	},
	{
		kind: "a-verifier",
		title: "À vérifier par un humain",
		id: "a-verifier",
		intro: "L’outil n’a pas pu trancher : une personne doit regarder ces éléments pour savoir s’il y a un problème.",
	},
	{
		kind: "bonne-pratique",
		title: "Bonnes pratiques",
		id: "bonnes-pratiques",
		intro: "Ces points ne comptent pas pour la conformité RGAA, mais les corriger rend le site plus facile à utiliser.",
	},
];

/** Raison d'une erreur de page en français clair ; le message technique reste disponible, replié. */
function errorReason(error: string): string {
	const http = /^HTTP (\d{3})/.exec(error);
	if (http) return `le serveur a répondu HTTP ${http[1]}`;
	if (/interrompu après/.test(error)) return "délai dépassé";
	if (/quitté le web/.test(error)) return "la page a quitté le web pendant le chargement";
	if (/net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(error)) return "adresse injoignable";
	return "erreur inattendue";
}

const dateFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });

function host(report: AuditReport): string {
	const first = report.pages[0];
	if (!first) return "site inconnu";
	try {
		return new URL(where(first)).host;
	} catch {
		return where(first);
	}
}

/** Rapport HTML complet d'un audit (une page ou un échantillon). Fonction pure. */
export function renderHtmlReport(report: AuditReport): string {
	const pages = report.pages;
	const failed = pages.filter((p) => p.error !== null);
	const audited = pages.length - failed.length;
	const hits: Hit[] = pages.flatMap((page) => page.results.map((result) => ({ page, result })));
	const nc = hits.filter((h) => h.result.kind === "non-conformite");
	const criteria = [...new Set(nc.flatMap((h) => h.result.criteria))].sort(byNumber);
	const ncOf = (id: string) => nc.filter((h) => h.result.criteria.includes(id));
	const site = host(report);
	const uncovered = uncoveredCriteria();
	const total = rgaa.criteria.length;

	const synthesisNc =
		criteria.length === 0
			? "<p>Aucune non-conformité détectée automatiquement sur les pages auditées. Cela ne veut pas dire que le site est conforme : la plupart des critères demandent une vérification humaine.</p>"
			: `<p>L’outil a trouvé un défaut certain pour ces critères. Chacun doit être corrigé.</p>
<ul class="criteria">
${criteria
	.map(
		(id) =>
			`<li><strong><a href="#${anchor(id)}">Critère ${id}</a> — ${escapeHtml(plainTitle(id))}</strong> : ${plural(pageCount(ncOf(id)), "page")}</li>`,
	)
	.join("\n")}
</ul>`;

	const synthesisOthers = KINDS.map(({ kind, title, id, intro }) => {
		const rules = byRule(hits.filter((h) => h.result.kind === kind));
		if (rules.size === 0) return `<h3>${title}</h3>\n<p>Rien à signaler.</p>`;
		return `<h3>${title}</h3>
<p>${intro}</p>
<ul>
${[...rules]
	.map(([rule, hs]) => {
		const r = hs[0]?.result as AuditResult;
		return `<li><a href="#${id}-${escapeHtml(rule)}">${ruleName(rule)}</a> — ${attachment(r)} : ${plural(pageCount(hs), "page")}${possibleList(r)}</li>`;
	})
	.join("\n")}
</ul>`;
	}).join("\n");

	const synthesis =
		audited === 0
			? "<p>Aucune page n’a pu être auditée : aucun résultat.</p>"
			: `<h3>Non-conformités détectées</h3>\n${synthesisNc}\n${synthesisOthers}`;

	const detailNc = criteria
		.map((id) => {
			const c = rgaa.criteria.find((x) => x.id === id);
			const topic = rgaa.topics.find((t) => t.number === c?.topic);
			const rules = byRule(ncOf(id));
			return `<article id="${anchor(id)}">
<h3>Critère ${id} — ${escapeHtml(plainTitle(id))}</h3>
${
	topic
		? `<div class="note">
<p class="note-label">Explication Rampe — non normative, thématique ${topic.number} : ${escapeHtml(topic.title)}</p>
<p>${escapeHtml(topicIntros[topic.number] ?? "")}</p>
</div>`
		: ""
}
<p>Concerne ${plural(pageCount(ncOf(id)), "page")}. ${link(criterionUrl(id), `Fiche du critère ${id} sur le site Rampe`)} : texte officiel, tests et méthode.</p>
${[...rules]
	.map(([rule, hs]) => {
		const tests = (hs[0]?.result.tests ?? []).filter((t) => t.startsWith(`${id}.`));
		return `<h4>Règle ${ruleName(rule)}, test${s(tests.length)} ${tests.join(", ")} : ${plural(nodeCount(hs), "élément")}</h4>
${elements(hs)}`;
	})
	.join("\n")}
</article>`;
		})
		.join("\n");

	const detailOthers = KINDS.map(({ kind, title, id }) => {
		const rules = byRule(hits.filter((h) => h.result.kind === kind));
		if (rules.size === 0) return "";
		return `<section aria-labelledby="titre-${id}">
<h3 id="titre-${id}">Détail : ${title.charAt(0).toLowerCase()}${title.slice(1)}</h3>
${[...rules]
	.map(([rule, hs]) => {
		const r = hs[0]?.result as AuditResult;
		return `<h4 id="${id}-${escapeHtml(rule)}">Règle ${ruleName(rule)} : ${plural(nodeCount(hs), "élément")}</h4>
<p>${upperFirst(attachment(r))}.</p>
${possibleList(r)}
${elements(hs)}`;
	})
	.join("\n")}
</section>`;
	}).join("\n");

	const warnings = pages.flatMap((p) => p.warnings.map((w) => `<li>${data(where(p))} : ${data(w)}</li>`));
	const pageList = pages
		.map((p) => {
			if (p.error !== null)
				return `<li class="error"><strong>Non auditée :</strong> ${link(p.url, data(p.url))}. La page n’a pas pu être chargée : ${errorReason(p.error)}.
<details><summary>Message technique</summary><pre><code>${text(p.error)}</code></pre></details></li>`;
			const title = p.title ? `, titre « ${data(p.title, SHORT_MAX)} »` : "";
			const n = p.results.filter((r) => r.kind === "non-conformite").length;
			const toCheck = p.results.filter((r) => r.kind === "a-verifier").length;
			const status = [
				n > 0 ? `${plural(n, "règle")} en non-conformité` : "aucune non-conformité détectée automatiquement",
				...(toCheck > 0 ? [`${plural(toCheck, "point")} à vérifier par un humain`] : []),
			].join(" ; ");
			return `<li>${link(where(p), data(where(p)))}${title} : ${status}</li>`;
		})
		.join("\n");

	const steps = [
		...(criteria.length > 0 ? ["Corriger les non-conformités détectées, puis relancer l’audit."] : []),
		`Faire vérifier les ${total} critères par une personne, sur le même échantillon de pages : c’est l’audit humain, le seul qui mesure la conformité. ${link(`${SITE}/referentiel/`, "Le référentiel RGAA sur le site Rampe")} détaille chaque critère.`,
		`Si votre organisation est soumise à l’obligation d’accessibilité, publier une déclaration d’accessibilité. ${link(OBLIGATIONS, "Les obligations, sur le site officiel du RGAA")}.`,
	];

	return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport d’audit automatique — ${text(site)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header>
<p class="brand">Rampe</p>
<h1>Rapport d’audit automatique<span class="site">${text(site)}</span></h1>
<dl class="meta">
<div><dt>Date</dt><dd><time datetime="${text(report.startedAt)}">${text(formatDate(report.startedAt))}</time></dd></div>
<div><dt>Pages auditées</dt><dd>${audited}</dd></div>
<div><dt>Pages en erreur</dt><dd>${failed.length}</dd></div>
<div><dt>Moteur</dt><dd>axe-core ${data(report.engine.axe)}, Chromium ${data(report.engine.browser)}</dd></div>
</dl>
</header>
<main id="contenu">
<section class="honesty" aria-labelledby="titre-honnetete">
<h2 id="titre-honnetete">Ce rapport n’est pas un audit de conformité.</h2>
<p>Les ${total} critères demandent une vérification humaine ; ${uncovered} n’ont aucune vérification automatique directe.</p>
<p>Ce rapport liste ce qu’un outil automatique a pu repérer. Il ne mesure pas la conformité et ne la certifie pas. Une page sans défaut détecté n’est pas pour autant une page conforme.</p>
</section>
${
	warnings.length > 0 || failed.length > 0
		? `<section class="warnings" aria-labelledby="titre-avertissements">
<h2 id="titre-avertissements">Avertissements</h2>
<ul>
${failed.length > 0 ? `<li>${plural(failed.length, "page")} en erreur, non auditée${s(failed.length)} : voir <a href="#pages">la liste des pages</a>. ${failed.length > 1 ? "Elles ne sont pas comptées" : "Elle n’est pas comptée"} comme sans défaut.</li>\n` : ""}${warnings.join("\n")}
</ul>
</section>`
		: ""
}
<section aria-labelledby="titre-synthese">
<h2 id="titre-synthese">Synthèse</h2>
${synthesis}
</section>
${
	criteria.length > 0
		? `<section aria-labelledby="titre-criteres">
<h2 id="titre-criteres">Non-conformités, critère par critère</h2>
${detailNc}
</section>`
		: ""
}
${
	detailOthers.trim()
		? `<section aria-labelledby="titre-autres">
<h2 id="titre-autres">Autres résultats</h2>
${detailOthers}
</section>`
		: ""
}
<section id="pages" aria-labelledby="titre-pages">
<h2 id="titre-pages">Pages de l’audit</h2>
${failed.length > 0 ? `<p>${plural(audited, "page")} auditée${s(audited)}, ${plural(failed.length, "page")} en erreur.</p>` : ""}
<ul class="pages">
${pageList}
</ul>
</section>
<section aria-labelledby="titre-suite">
<h2 id="titre-suite">Ce qui reste à faire</h2>
<ol>
${steps.map((x) => `<li>${x}</li>`).join("\n")}
</ol>
</section>
</main>
<footer>
<p>Rapport produit par ${text(report.tool.name)} ${text(report.tool.version)}, outil libre et gratuit d’aide à la conformité. Il ne modifie pas le site audité.</p>
<p>Référentiel RGAA ${escapeHtml(rgaa.version)} © DINUM, Licence Ouverte 2.0. Les explications marquées « Explication Rampe » ne sont pas normatives.</p>
</footer>
</body>
</html>
`;
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : `${dateFr.format(d)} (heure de Paris)`;
}

// Mêmes couleurs que le site (apps/site/src/layouts/Base.astro), contrastes AA en clair et en sombre.
const CSS = `
:root{--bg:#fbfaf7;--surface:#fff;--text:#1c1b19;--muted:#5d5a53;--line:#e3e0d8;--accent:#0b5d4b;--accent-soft:#e2f0eb;--warn:#8a4b00;--warn-soft:#fbefdf;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#151513;--surface:#1e1e1b;--text:#ecebe6;--muted:#a9a69d;--line:#34332f;--accent:#6fd3b5;--accent-soft:#1c3a32;--warn:#f2b45c;--warn-soft:#33260f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:1rem;top:1rem;background:var(--surface);padding:.5rem 1rem;z-index:1}
header,main,footer{max-width:52rem;margin:0 auto;padding:0 1rem}
header{padding-block:1.5rem 1rem;border-bottom:1px solid var(--line)}
.brand{margin:0;font-weight:700}
h1{font-size:1.9rem;line-height:1.2;margin:.75rem 0 1rem}
h1 .site{display:block;unicode-bidi:isolate;font-size:1.1rem;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
h2{font-size:1.45rem;line-height:1.25;margin:2.5rem 0 .75rem}
h3{font-size:1.2rem;line-height:1.3;margin:2rem 0 .5rem}
h4{font-size:1rem;margin:1.5rem 0 .5rem}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.5rem 1.5rem;margin:0}
.meta dt{font-size:.875rem;color:var(--muted)}
.meta dd{margin:0;font-weight:600}
main{padding-block:1.5rem 3rem}
.honesty{margin-top:1rem;padding:1rem 1.25rem;background:var(--warn-soft);border:2px solid var(--warn);border-radius:6px}
.honesty h2{margin:0 0 .5rem;font-size:1.3rem}
.honesty p{margin:.4rem 0}
.honesty p:first-of-type{font-weight:600;font-size:1.05rem}
.warnings{border-left:4px solid var(--warn);padding-left:1rem}
.warnings h2{margin-top:2rem}
.criteria li{margin-bottom:.35rem}
article{border-top:1px solid var(--line);margin-top:2rem}
.note{margin:1rem 0;padding:.75rem 1rem;background:var(--accent-soft);border-left:4px solid var(--accent);border-radius:0 6px 6px 0}
.note p{margin:0}
.note-label{font-size:.875rem;font-weight:600;margin-bottom:.25rem!important}
details{margin:.5rem 0;background:var(--surface);border:1px solid var(--line);border-radius:6px}
summary{cursor:pointer;padding:.5rem .75rem;overflow-wrap:anywhere}
.nodes{margin:0;padding:.25rem 1rem .75rem 2.25rem}
.nodes li{margin-top:.75rem}
.nodes p{margin:.25rem 0}
code{font-size:.9em;overflow-wrap:anywhere;unicode-bidi:isolate}
pre{unicode-bidi:isolate;margin:.25rem 0;padding:.5rem .75rem;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.diag span{white-space:pre-line}
.pages li{margin-bottom:.5rem;overflow-wrap:anywhere}
.pages .error{color:var(--warn)}
footer{color:var(--muted);font-size:.875rem;padding-block:1.5rem;border-top:1px solid var(--line)}
@media print{
:root{--bg:#fff;--surface:#fff;--text:#000;--muted:#333;--accent:#0b5d4b;--warn:#8a4b00}
body{font-size:11pt}
.skip{display:none}
details::details-content{content-visibility:visible;display:block}
details{break-inside:avoid-page}
summary{list-style:none}
}
`;
