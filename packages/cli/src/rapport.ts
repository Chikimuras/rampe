// Rapport HTML autonome, sans JavaScript, lui-même accessible (ADR-0011 §4), généré à partir du JSON v2.
// Toute donnée venue de la page auditée ou de l'URL passe par `escapeHtml` (ADR-0011 §6 ; OWASP Cross Site Scripting
// Prevention Cheat Sheet, « Output Encoding » pour le contexte HTML) : une page malveillante ne doit pas piéger son rapport.
import { rgaa, topicIntros } from "@rampe/core";
import {
	type AuditPage,
	type AuditReport,
	type AuditResult,
	byNumber,
	plainTitle,
	plural,
	type ResultKind,
	selector,
	uncoveredCriteria,
} from "./audit.ts";

const SITE = "https://chikimuras.github.io/rampe";

/** Encodage du contexte HTML (contenu et attributs entre guillemets) : & < > " '. */
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);

/** Lien seulement vers une adresse http(s) ; sinon le texte seul (défense en profondeur, le JSON peut être modifié). */
const link = (href: string, text: string) =>
	/^https?:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : escapeHtml(text);

const criterionUrl = (id: string) => `${SITE}/referentiel/${id.replace(".", "-")}/`;
const where = (p: AuditPage) => p.finalUrl ?? p.url;

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

/** Éléments en défaut d'une règle, page par page, repliés. */
function elements(hits: Hit[]): string {
	return hits
		.map(({ page, result }) => {
			const items = result.nodes
				.map(
					(n) => `<li>
<p>Élément : <code>${escapeHtml(selector(n.target))}</code></p>
<pre><code>${escapeHtml(n.html)}</code></pre>${
						n.failureSummary
							? `\n<p class="diag">Diagnostic d’axe, en anglais : <span lang="en">${escapeHtml(n.failureSummary)}</span></p>`
							: ""
					}
</li>`,
				)
				.join("\n");
			return `<details>
<summary>${escapeHtml(where(page))} : ${plural(result.nodes.length, "élément")}</summary>
<ol class="nodes">
${items}
</ol>
</details>`;
		})
		.join("\n");
}

const flagsNote = (r: AuditResult) =>
	r.flags.bestPractice ? "règle de bonne pratique d’axe" : r.flags.experimental ? "règle expérimentale d’axe" : "";

/** Ce que dit le rattachement d'une règle hors non-conformité, en clair. */
function attachment(r: AuditResult): string {
	const crits = r.criteria.map((c) => link(criterionUrl(c), c)).join(", ");
	if (r.kind === "bonne-pratique") return "hors conformité RGAA";
	if (r.kind === "incertain" && r.level === "rgaa")
		return `cite le test ${r.tests.join(", ")} (critère ${crits}), mais c’est une ${flagsNote(r)} : à confirmer par un humain`;
	if (r.level === "wcag")
		return `via WCAG ${r.wcag.join(", ")} ; critère${r.criteria.length > 1 ? "s" : ""} possible${r.criteria.length > 1 ? "s" : ""} : ${crits}`;
	return r.criteria.length > 0 ? `critère${r.criteria.length > 1 ? "s" : ""} ${crits}` : "sans critère RGAA associé";
}

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
		audited === 0
			? "<p>Aucune page n’a pu être auditée.</p>"
			: criteria.length === 0
				? "<p>Aucune non-conformité détectée automatiquement sur les pages auditées. Cela ne veut pas dire que le site est conforme : la plupart des critères demandent une vérification humaine.</p>"
				: `<p>L’outil a trouvé un défaut certain pour ces critères. Chacun doit être corrigé.</p>
<ul class="criteria">
${criteria
	.map(
		(id) =>
			`<li><strong><a href="#critere-${id.replace(".", "-")}">Critère ${id}</a> — ${escapeHtml(plainTitle(id))}</strong> : ${plural(pageCount(ncOf(id)), "page")}</li>`,
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
	.map(
		([rule, hs]) =>
			`<li><a href="#${id}-${escapeHtml(rule)}"><code>${escapeHtml(rule)}</code></a> (${attachment(hs[0]?.result as AuditResult)}) : ${plural(pageCount(hs), "page")}</li>`,
	)
	.join("\n")}
</ul>`;
	}).join("\n");

	const detailNc = criteria
		.map((id) => {
			const c = rgaa.criteria.find((x) => x.id === id);
			const topic = rgaa.topics.find((t) => t.number === c?.topic);
			const rules = byRule(ncOf(id));
			return `<article id="critere-${id.replace(".", "-")}">
<h3>Critère ${id} — ${escapeHtml(plainTitle(id))}</h3>
${
	topic
		? `<div class="note">
<p class="note-label">Explication Rampe — non normative (thématique ${topic.number} : ${escapeHtml(topic.title)})</p>
<p>${escapeHtml(topicIntros[topic.number] ?? "")}</p>
</div>`
		: ""
}
<p>Concerne ${plural(pageCount(ncOf(id)), "page")}. ${link(criterionUrl(id), `Fiche du critère ${id} sur le site Rampe`)} : texte officiel, tests et méthode.</p>
${[...rules]
	.map(([rule, hs]) => {
		const tests = (hs[0]?.result.tests ?? []).filter((t) => t.startsWith(`${id}.`));
		return `<h4>Règle <code>${escapeHtml(rule)}</code> (test${tests.length > 1 ? "s" : ""} ${tests.join(", ")}) : ${plural(nodeCount(hs), "élément")}</h4>
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
<h3 id="titre-${id}">${title}</h3>
${[...rules]
	.map(
		([
			rule,
			hs,
		]) => `<h4 id="${id}-${escapeHtml(rule)}">Règle <code>${escapeHtml(rule)}</code> : ${plural(nodeCount(hs), "élément")}</h4>
<p>${attachment(hs[0]?.result as AuditResult)}.</p>
${elements(hs)}`,
	)
	.join("\n")}
</section>`;
	}).join("\n");

	const warnings = pages.flatMap((p) => p.warnings.map((w) => `<li>${escapeHtml(where(p))} : ${escapeHtml(w)}</li>`));
	const pageList = pages
		.map((p) => {
			const name = p.title ? ` (titre : « ${escapeHtml(p.title)} »)` : "";
			if (p.error !== null)
				return `<li class="error"><strong>En erreur, non auditée :</strong> ${link(p.url, p.url)}<br>${escapeHtml(p.error)}</li>`;
			const n = p.results.filter((r) => r.kind === "non-conformite").length;
			const status =
				n > 0 ? `${plural(n, "règle")} en non-conformité` : "aucune non-conformité détectée automatiquement";
			return `<li>${link(where(p), where(p))}${name} : ${status}</li>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport d’audit automatique — ${escapeHtml(site)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header>
<p class="brand">Rampe</p>
<h1>Rapport d’audit automatique<span class="site">${escapeHtml(site)}</span></h1>
<dl class="meta">
<div><dt>Date</dt><dd><time datetime="${escapeHtml(report.startedAt)}">${escapeHtml(formatDate(report.startedAt))}</time></dd></div>
<div><dt>Pages auditées</dt><dd>${audited}</dd></div>
<div><dt>Pages en erreur</dt><dd>${failed.length}</dd></div>
<div><dt>Moteur</dt><dd>axe-core ${escapeHtml(report.engine.axe)}, Chromium ${escapeHtml(report.engine.browser)}</dd></div>
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
${failed.length > 0 ? `<li>${plural(failed.length, "page")} en erreur, non auditée${failed.length > 1 ? "s" : ""} : voir <a href="#pages">la liste des pages</a>. Elles ne sont pas comptées comme sans défaut.</li>\n` : ""}${warnings.join("\n")}
</ul>
</section>`
		: ""
}
<section aria-labelledby="titre-synthese">
<h2 id="titre-synthese">Synthèse</h2>
<h3>Non-conformités détectées</h3>
${synthesisNc}
${synthesisOthers}
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
${failed.length > 0 ? `<p>${plural(audited, "page")} auditée${audited > 1 ? "s" : ""}, ${plural(failed.length, "page")} en erreur.</p>` : ""}
<ul class="pages">
${pageList}
</ul>
</section>
<section aria-labelledby="titre-suite">
<h2 id="titre-suite">Ce qui reste à faire</h2>
<ol>
<li>Corriger les non-conformités détectées, puis relancer l’audit.</li>
<li>Faire vérifier les ${total} critères par une personne, sur le même échantillon de pages : c’est l’audit humain, le seul qui mesure la conformité. ${link(`${SITE}/referentiel/`, "Le référentiel RGAA sur le site Rampe")} détaille chaque critère.</li>
<li>Publier la déclaration d’accessibilité du site, obligatoire : elle indique le niveau de conformité issu de cet audit humain.</li>
</ol>
</section>
</main>
<footer>
<p>Rapport produit par ${escapeHtml(report.tool.name)} ${escapeHtml(report.tool.version)}, outil libre et gratuit d’aide à la conformité. Il ne modifie pas le site audité.</p>
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
h1 .site{display:block;font-size:1.1rem;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
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
code{font-size:.9em;overflow-wrap:anywhere}
pre{margin:.25rem 0;padding:.5rem .75rem;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
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
