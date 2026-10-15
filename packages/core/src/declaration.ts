// Déclaration d'accessibilité (ADR-0017) : le format officiel à la lettre, l'état déduit de l'audit, rien d'inventé.
//
// Gabarit : dépôt DISIC/accessibilite.numerique.gouv.fr, fichier src/obligations/declaration-accessibilite.md,
// section « La déclaration d'accessibilité adopte obligatoirement ce format ». Copié le 2026-10-15 depuis le commit
// ca4019f95073b6cbd2482a16e9f12b52d8de678d (dernière modification du fichier : ba61de5893b13d30f476a228a8437c3b3d370934,
// 2026-05-19). Licence Ouverte 2.0. Texte figé : la copie brute est test/fixtures/declaration-format-officiel.json, et
// le test de fidélité vérifie que chaque phrase imposée figure ici mot pour mot, dans l'ordre. Seuls les passages
// entre crochets sont remplis ; un passage non rempli reste affiché entre crochets, visiblement à compléter.
//
// Pur et sans données : l'îlot de /audit/ l'importe ; les titres des critères et la version du RGAA sont passés.
import {
	type AuditSession,
	type DeclarationField,
	type DeclarationFields,
	getEvaluation,
	own,
	siteAndDay,
} from "./audit-session.ts";
import { type Conformity, formatRate } from "./conformity.ts";
import { stripControl } from "./sample-file.ts";

/** Pages officielles, pour l'interface : la déclaration et son format, et le champ d'application (qui est soumis). */
export const DECLARATION_URL = "https://accessibilite.numerique.gouv.fr/obligations/declaration-accessibilite/";
export const SCOPE_URL = "https://accessibilite.numerique.gouv.fr/obligations/champ-application/";

export type NonConformityReason = "incomplete" | "no-applicable" | "below-half";
export type ConformityState = { state: "totalement" | "partiellement" } | { state: "non"; reason: NonConformityReason };

/** Motif d'une déclaration « non conforme », en clair. */
export const NON_CONFORMITY_REASONS: Record<NonConformityReason, string> = {
	incomplete:
		"Aucun résultat d’audit complet permettant de mesurer le respect des critères : l’audit n’est pas terminé.",
	"no-applicable":
		"Aucun critère RGAA n’est applicable sur les pages vérifiées : le respect des critères ne peut pas être mesuré.",
	"below-half": "Moins de 50 % des critères RGAA sont respectés.",
};

/**
 * État de conformité, règle officielle : « totalement » si tous les critères sont respectés, « partiellement » si au
 * moins 50 % le sont, « non » si moins de 50 % le sont ou s'il n'existe aucun résultat d'audit permettant de mesurer
 * le respect des critères.
 * - Décidé sur les ENTIERS (validés v, applicables a) : `2v ≥ a`, jamais sur un pourcentage arrondi (49,996 % < 50 %).
 * - Audit incomplet (ADR-0015 §2) : « non », quel que soit le reste.
 * - Aucun critère applicable : « non ». Rien n'a été mesuré ; « tous les critères sont respectés » serait vrai à vide,
 *   et la règle officielle classe « non conforme » l'absence de résultat « permettant de mesurer le respect des
 *   critères ».
 */
export function conformityState(result: Conformity): ConformityState {
	if (!result.complete) return { state: "non", reason: "incomplete" };
	const { validated, applicable } = result;
	if (applicable === 0) return { state: "non", reason: "no-applicable" };
	if (validated === applicable) return { state: "totalement" };
	if (2 * validated >= applicable) return { state: "partiellement" };
	return { state: "non", reason: "below-half" };
}

// Modèle intermédiaire, rendu en HTML, en Markdown, ou par l'aperçu de l'îlot (Preact, qui échappe lui-même).
export type Inline =
	/** Texte du gabarit officiel, ou calculé par Rampe (taux, dates) : sûr. */
	| { kind: "text"; text: string }
	/** Saisie de l'utilisateur ou donnée de l'audit : toujours échappée. */
	| { kind: "input"; text: string }
	/** Passage du gabarit à compléter, affiché entre crochets. */
	| { kind: "slot"; text: string }
	/** `href` déjà vérifié par `safeUrl` (http, https, mailto). */
	| { kind: "link"; href: string; label: Inline[] }
	| { kind: "break" }
	/** Retour à la ligne du source Markdown (gabarit), une simple espace une fois rendu. */
	| { kind: "newline" };
export type Block =
	| { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
	| { kind: "paragraph"; content: Inline[] }
	| { kind: "list"; items: Inline[][] };

export interface DeclarationOptions {
	/** Date d'établissement quand l'utilisateur n'en a pas saisi : en principe, aujourd'hui (date locale). */
	date: Date;
	/** Version du RGAA de l'audit, ex. « 4.1.2 ». */
	rgaaVersion: string;
	/** Titre officiel de chaque critère, en texte brut. */
	criterionTitles: Readonly<Record<string, string>>;
}

const MONTHS = "janvier février mars avril mai juin juillet août septembre octobre novembre décembre".split(" ");
/** « JJ mois AAAA », comme le gabarit. */
const day = (y: number, m: number, d: number) => `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
const dayOf = (iso: string | undefined): string | null => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
	return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? day(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

/** Saisie relue : contrôles et bidi retirés (la relecture du stockage ne nettoie rien), espaces de bord ignorés. */
const clean = (text: string) => stripControl(text).trim();
const EMAIL = /^[^\s@:/<>()[\]\\,;"]+@[^\s@:/<>()[\]\\,;"]+$/;

/**
 * Adresse publiable : http(s) ou `mailto:` seulement (OWASP XSS Prevention Cheat Sheet, liens : valider le schéma
 * d'une URL insérée dans un attribut `href`). Une adresse e-mail seule devient `mailto:`. Les caractères qui
 * fermeraient une destination de lien Markdown ou un attribut sont encodés. `null` : rien de publiable.
 */
export function safeUrl(value: string): { href: string; label: string } | null {
	const text = clean(value);
	if (!text) return null;
	let url: URL;
	try {
		url = new URL(EMAIL.test(text) ? `mailto:${text}` : text);
	} catch {
		return null;
	}
	if (url.protocol === "mailto:" ? !EMAIL.test(decodeURIComponentSafe(url.pathname)) : !/^https?:$/.test(url.protocol))
		return null;
	if (url.protocol !== "mailto:" && !url.hostname) return null;
	const href = url.href.replace(
		/[\s"'<>()\\`[\]]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);
	return { href, label: text.replace(/^mailto:/i, "") };
}
const decodeURIComponentSafe = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

const text = (t: string): Inline => ({ kind: "text", text: t });
const slot = (t: string): Inline => ({ kind: "slot", text: t });
const input = (t: string): Inline => ({ kind: "input", text: t });
const BREAK: Inline = { kind: "break" };
const NEWLINE: Inline = { kind: "newline" };
const heading = (level: 1 | 2 | 3, t: string): Block => ({ kind: "heading", level, content: [text(t)] });
const paragraph = (...content: Inline[]): Block => ({ kind: "paragraph", content });
const list = (items: Inline[][]): Block => ({ kind: "list", items });

/** Gabarit rempli, bloc par bloc. Le texte de chaque `text(…)` du gabarit est celui de la source, à la lettre. */
export function declarationBlocks(
	session: AuditSession,
	result: Conformity,
	fields: DeclarationFields,
	options: DeclarationOptions,
): Block[] {
	const value = (key: DeclarationField) => clean(own(fields, key) ?? "");
	const or = (key: DeclarationField, placeholder: string) => (value(key) ? input(value(key)) : slot(placeholder));
	const link = (href: string, label: Inline): Inline => ({ kind: "link", href, label: [label] });
	const url = (key: DeclarationField, placeholder: string) => {
		const u = safeUrl(value(key));
		return u ? link(u.href, input(u.label)) : slot(placeholder);
	};
	/** Un élément de liste par ligne non vide ; `placeholder` (et le point du gabarit) si aucune. */
	const lines = (key: DeclarationField, placeholder: Inline[], period = false, before: Inline[][] = []) => {
		const items = [
			...before,
			...(own(fields, key) ?? "")
				.split("\n")
				.map(clean)
				.filter(Boolean)
				.map((l) => [input(l)]),
		];
		if (items.length === 0) return list([placeholder]);
		// Le gabarit termine ces listes par un point (« …s’il y a lieu]. ») : il suit le dernier élément.
		const last = items.at(-1) as Inline[];
		const end = last.at(-1);
		if (period && !(end?.kind === "input" && /[.!?…]$/.test(end.text)) && end?.kind !== "text") last.push(text("."));
		return list(items);
	};

	const state = conformityState(result);
	const complete = result.complete && result.applicable > 0 ? result : null;

	const scheme = safeUrl(value("schemeUrl"));
	const plan = safeUrl(value("actionPlanUrl"));
	const strategy: Inline[] =
		scheme || plan
			? [
					scheme ? link(scheme.href, text("schéma pluriannuel")) : slot("lien vers le schéma pluriannuel"),
					text(" et "),
					plan
						? link(plan.href, text("plan d’action de l’année en cours"))
						: slot(
								"lien vers le plan d’action de l’année en cours incluant le bilan des actions réalisées l’année précédente",
							),
				]
			: [
					slot(
						"liens vers le schéma pluriannuel et vers le plan d’action de l’année en cours incluant le bilan des actions réalisées l’année précédente",
					),
				];

	const auditBy = value("auditBy");
	const auditor: Inline[] =
		auditBy === "interne"
			? [text("en interne")]
			: auditBy === "prestataire"
				? [text("par la société "), or("auditCompany", "nom de la société")]
				: [slot("en interne / par la société NNN")];

	const reason = state.state === "non" && state.reason !== "below-half" ? NON_CONFORMITY_REASONS[state.reason] : null;
	const report = safeUrl(value("reportUrl"));
	const details: Inline[] = [
		...(reason ? [text(reason)] : []),
		...(reason && report ? [text(" ")] : []),
		...(report ? [link(report.href, input(report.label))] : []),
	];

	const pageName = (id: string) => {
		const p = session.pages.find((x) => x.id === id);
		return p ? clean(p.title) || p.url : "";
	};
	const failing: Inline[][] = complete
		? complete.criteria
				.filter((c) => c.status === "non validé")
				.map((c) => {
					const pages = session.pages
						.filter((p) => getEvaluation(session, c.criterion, p.id).status === "NC")
						.map((p) => pageName(p.id));
					return [
						text(`Critère ${c.criterion}\u00a0: `),
						input(clean(own(options.criterionTitles, c.criterion) ?? "")),
						text(pages.length > 1 ? " Pages concernées\u00a0: " : " Page concernée\u00a0: "),
						input(pages.join(", ")),
						text("."),
					];
				})
		: [];

	const pages: Inline[][] = session.pages.map((p) => {
		const u = safeUrl(p.url);
		const address = u ? link(u.href, input(p.url)) : input(p.url);
		const title = clean(p.title);
		return title ? [input(title), text("\u00a0: "), address] : [address];
	});

	const established =
		dayOf(value("establishedOn")) ??
		day(options.date.getFullYear(), options.date.getMonth() + 1, options.date.getDate());
	const updated = dayOf(value("updatedOn"));
	const defenseur = (label: string, href: string): Inline[] => [
		// Comme le gabarit : l'adresse entre parenthèses, à la ligne suivante du source.
		text(label),
		NEWLINE,
		text("("),
		link(href, text(href)),
		text(")"),
	];

	return [
		heading(1, "Déclaration d’accessibilité"),
		paragraph(
			or("organization", "Nom de l’organisme concerné"),
			text(" s’engage à rendre "),
			or("commitment", "son (ses) site(s) internet, intranet, extranet et son (ses) application(s) mobile(s), etc."),
			text(" accessibles conformément à l’article 47 de la loi n° 2005-102 du 11 février 2005."),
		),
		paragraph(text("À cette fin, il met en œuvre la stratégie et les actions suivantes "), ...strategy, text(".")),
		paragraph(
			text("Cette déclaration d’accessibilité s’applique à "),
			or(
				"serviceName",
				"Nom du site web de l’application mobile, ou d’un autre service auquel la déclaration s’applique",
			),
			text("."),
		),
		heading(2, "État de conformité"),
		paragraph(
			or("serviceName", "Nom du site web, de l’application mobile, ou d’un autre service concerné"),
			text(" est"),
			BREAK,
			text(`${state.state} conforme avec `),
			text(`le référentiel général d’amélioration de l’accessibilité (RGAA), version ${options.rgaaVersion}`),
			text("."),
		),
		heading(3, "Résultat des tests"),
		paragraph(text("L’audit de conformité réalisé "), ...auditor, text(" révèle que\u00a0:")),
		list([
			[
				complete?.globalRate != null
					? text(formatRate(complete.globalRate))
					: slot("pourcentage de critères RGAA respectés"),
				text(" des critères RGAA sont respectés."),
			],
			complete?.averageRate != null
				? [
						text("Le taux moyen de conformité du service en ligne s’élève à "),
						text(formatRate(complete.averageRate)),
						text("."),
					]
				: [
						slot("Facultatif"),
						text(" Le taux moyen de conformité du service en ligne s’élève à "),
						slot("taux moyen de conformité du service en ligne"),
						text("."),
					],
		]),
		paragraph(
			...(details.length > 0
				? details
				: [slot("Détailler ici les résultats des tests ou insérer un lien vers le rapport de test")]),
		),
		heading(2, "Contenus non accessibles"),
		paragraph(text("Les contenus listés ci-dessous ne sont pas accessibles pour les raisons suivantes.")),
		heading(3, "Non conformité"),
		lines(
			"nonConformities",
			[
				slot(
					"Lister la/les non-conformité(s) du/de la/des site(s) internet/application(s) mobile(s) et/ou décrire quels section(s)/contenu(s)/fonction(s) ne sont pas encore conformes, indiquer les alternatives s’il y a lieu",
				),
				text("."),
			],
			true,
			failing,
		),
		heading(3, "Dérogations pour charge disproportionnée"),
		lines(
			"derogations",
			[
				slot(
					"Lister la/le/les section(s)/contenu(s)/fonction(s) non accessible(s) pour laquelle/lequel/lesquels la dérogation pour charge disproportionnée est temporairement invoquée, indiquer les alternatives s’il y a lieu",
				),
				text("."),
			],
			true,
		),
		heading(3, "Contenus non soumis à l’obligation d’accessibilité"),
		lines(
			"exemptions",
			[
				slot(
					"Lister la/le/les section(s)/contenu(s)/fonction(s) non accessible(s) qui n’entre(nt) pas dans le champ d’application de la législation applicable, indiquer les alternatives s’il y a lieu",
				),
				text("."),
			],
			true,
		),
		heading(2, "Établissement de cette déclaration d’accessibilité"),
		paragraph(
			text("Cette déclaration a été établie le "),
			text(established),
			text(". Elle a été mise à jour le "),
			updated ? text(updated) : slot("JJ mois AAAA"),
			text("."),
		),
		{ kind: "heading", level: 3, content: [text("Technologies utilisées pour la réalisation "), text("du site web")] },
		lines("technologies", [slot("Liste des technologies utilisées")]),
		heading(3, "Environnement de test"),
		paragraph(text("Agents utilisateurs, technologies d’assistance et outils utilisés pour vérifier l’accessibilité")),
		lines("testEnvironment", [
			slot("Indiquer les combinaisons utilisées pour effectuer les vérifications de conformité"),
		]),
		heading(3, "Les outils utilisés lors de l’évaluation"),
		lines("tools", [slot("Indiquer les outils utilisés")]),
		heading(3, "Pages du site ayant fait l’objet de la vérification de conformité"),
		list(pages.length > 0 ? pages : [[slot("Indiquer la liste des pages qui ont été testées")]]),
		heading(2, "Retour d’information et contact"),
		paragraph(
			text("Si vous n’arrivez pas à accéder à un contenu ou à un service, vous pouvez contacter le responsable du "),
			text("site internet"),
			text(" pour être orienté vers une alternative accessible ou obtenir le contenu sous une autre forme."),
		),
		list([
			[text("Envoyer un message "), url("contactFormUrl", "url du formulaire en ligne")],
			[
				text("Contacter "),
				or("contactEntity", "Nom de l’entité responsable du service en ligne"),
				text(" "),
				url("contactPageUrl", "url d’une page avec les coordonnées de l’entité"),
			],
		]),
		heading(2, "Voies de recours"),
		paragraph(text("Cette procédure est à utiliser dans le cas suivant.")),
		paragraph(
			text(
				"Vous avez signalé au responsable du site internet un défaut d’accessibilité qui vous empêche d’accéder à un contenu ou à un des services du portail et vous n’avez pas obtenu de réponse satisfaisante.",
			),
		),
		list([
			defenseur("Écrire un message au Défenseur des droits", "https://www.defenseurdesdroits.fr/nous-contacter-355"),
			defenseur(
				"Contacter le délégué du Défenseur des droits près de chez vous",
				"https://www.defenseurdesdroits.fr/carte-des-delegues",
			),
			[
				text("Envoyer un courrier par la poste (gratuit, ne pas mettre de timbre)\u00a0:"),
				BREAK,
				text("Défenseur des droits"),
				BREAK,
				text("Libre réponse 71120"),
				BREAK,
				text("75342 Paris CEDEX 07"),
			],
		]),
	];
}

// Sorties. OWASP XSS Prevention Cheat Sheet, « Output Encoding » : toute saisie est encodée pour son contexte
// (contenu HTML, attribut entre guillemets) ; le gabarit est encodé lui aussi, sans effet sur son texte.
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
/**
 * Markdown : tout caractère de ponctuation ASCII d'une saisie est précédé d'une barre oblique inverse (CommonMark,
 * « Backslash escapes » : toute ponctuation ASCII peut l'être). Aucune saisie ne peut donc ouvrir un lien, une image,
 * une balise HTML, un titre, une liste ou une entité.
 */
export const escapeMarkdown = (s: string) => s.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, "\\$&");

function inlineHtml(i: Inline): string {
	switch (i.kind) {
		case "text":
		case "input":
			return escapeHtml(i.text);
		case "slot":
			return escapeHtml(`[${i.text}]`);
		case "link":
			return `<a href="${escapeHtml(i.href)}">${i.label.map(inlineHtml).join("")}</a>`;
		case "break":
			return "<br>";
		case "newline":
			return "\n";
	}
}

function inlineMarkdown(i: Inline, inList: boolean): string {
	switch (i.kind) {
		case "text":
			return i.text;
		case "input":
			return escapeMarkdown(i.text);
		case "slot":
			return `[${i.text}]`;
		case "link": {
			const [only] = i.label;
			// Adresse affichée telle quelle (voies de recours) : écrite nue, comme dans le gabarit.
			if (i.label.length === 1 && only?.kind === "text" && only.text === i.href) return i.href;
			return `[${i.label.map((l) => inlineMarkdown(l, inList)).join("")}](${i.href})`;
		}
		case "break":
			return inList ? "<br>\n  " : "  \n";
		case "newline":
			return inList ? "\n  " : "\n";
	}
}

/** Fragment HTML sémantique ; `offset` décale les niveaux de titre (fragment collé sous le h1 d'une page). */
export function blocksToHtml(blocks: readonly Block[], offset = 0): string {
	return blocks
		.map((b) => {
			const inline = (content: Inline[]) => content.map(inlineHtml).join("");
			if (b.kind === "heading") return `<h${b.level + offset}>${inline(b.content)}</h${b.level + offset}>`;
			if (b.kind === "paragraph") return `<p>${inline(b.content)}</p>`;
			return `<ul>\n${b.items.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</ul>`;
		})
		.join("\n");
}

export function blocksToMarkdown(blocks: readonly Block[]): string {
	return `${blocks
		.map((b) => {
			const inline = (content: Inline[], inList = false) => content.map((i) => inlineMarkdown(i, inList)).join("");
			if (b.kind === "heading") return `${"#".repeat(b.level)} ${inline(b.content)}`;
			if (b.kind === "paragraph") return inline(b.content);
			return b.items.map((item) => `- ${inline(item, true)}`).join("\n");
		})
		.join("\n\n")}\n`;
}

/**
 * Déclaration remplie. `html` : fragment à coller dans une page existante, qui a déjà son h1 : il commence au h2
 * (« Déclaration d’accessibilité »), ses sections en h3 et h4. `standalone` : page HTML complète, prête à publier
 * telle quelle, avec la déclaration en h1. `markdown` : saisies échappées.
 */
export function renderDeclaration(
	session: AuditSession,
	result: Conformity,
	fields: DeclarationFields,
	options: DeclarationOptions & { format: "html" | "markdown"; standalone?: boolean },
): string {
	const blocks = declarationBlocks(session, result, fields, options);
	if (options.format === "markdown") return blocksToMarkdown(blocks);
	if (!options.standalone) return blocksToHtml(blocks, 1);
	const fragment = blocksToHtml(blocks);
	return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Déclaration d’accessibilité</title>
</head>
<body>
<main>
${fragment}
</main>
</body>
</html>
`;
}

/** `declaration-accessibilite-<hôte>-<AAAA-MM-JJ>.<html|md>`, date locale. */
export const declarationFileName = (session: AuditSession, date: Date, extension: "html" | "md") =>
	`declaration-accessibilite-${siteAndDay(session, date)}.${extension}`;
