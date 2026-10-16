// Schéma pluriannuel et plan d'action (ADR-0018) : un guide de rédaction structuré par la liste officielle, et un
// plan d'action pré-rempli depuis l'audit. Rampe n'écrit aucun texte de politique à la place de l'organisme.
//
// Liste des volets : dépôt DISIC/accessibilite.numerique.gouv.fr, fichier src/obligations/schema-pluriannuel.md,
// section « Contenu du schéma ». Copiée le 2026-10-16 depuis le commit ca4019f95073b6cbd2482a16e9f12b52d8de678d
// (dernière modification du fichier : 1cdb9235390ec1cebebd88406b8217753dd0d8bb, 2022-10-19 ; blob
// 02916ec8a3946ec182408afa7f882cb8b2f13311). Licence Ouverte 2.0. Descriptions citées mot pour mot, sans le « ; » ou
// le point qui termine chaque élément de la liste source. La copie brute est test/fixtures/schema-pluriannuel-officiel.json,
// et le test golden relit la liste depuis cette copie.
//
// Pur et sans données du référentiel : l'îlot de /audit/ l'importe ; les titres des critères sont passés.
import {
	ACTION_STATUSES,
	type ActionStatus,
	type AuditSession,
	cleanNote,
	fits,
	getEvaluation,
	isEmptySchema,
	isPageId,
	isYear,
	MAX_ACTIONS,
	MAX_NOTE,
	MAX_SECTION,
	MAX_TITLE,
	own,
	PRIORITIES,
	type Priority,
	SCHEMA_SECTIONS,
	type SchemaAction,
	type SchemaPlan,
	type SchemaSection,
	siteAndDay,
} from "./audit-session.ts";
import type { Conformity } from "./conformity.ts";
import { type Block, blocksToHtml, blocksToMarkdown, type Inline, standaloneHtml } from "./declaration.ts";
import { stripControl, truncate } from "./sample-file.ts";

/** Page officielle du schéma pluriannuel. */
export const SCHEMA_URL = "https://accessibilite.numerique.gouv.fr/obligations/schema-pluriannuel/";
/** Rappel affiché dans l'interface et dans chaque document produit (ADR-0018, « Conséquences »). */
export const SCHEMA_MENTION =
	"Ce document décrit la politique de votre organisme ; Rampe vous aide seulement à le structurer.";

export interface Volet {
	id: SchemaSection;
	part: "politique" | "travaux";
	/** Intitulé court, de Rampe (titre de section). */
	label: string;
	/** Description officielle, mot pour mot. */
	description: string;
}
const volet = (id: SchemaSection, part: Volet["part"], label: string, description: string): Volet => ({
	id,
	part,
	label,
	description,
});
/** Les 14 volets officiels, dans l'ordre de la source. Coquille de la source : le 6e n'y a pas de tiret. */
export const VOLETS: readonly Volet[] = [
	volet(
		"strategy",
		"politique",
		"Stratégie",
		"la prise en compte de l’accessibilité numérique dans la stratégie numérique de l’entité et dans sa politique en faveur de l’intégration des personnes en situation de handicap",
	),
	volet(
		"referent",
		"politique",
		"Référent accessibilité numérique",
		"la position fonctionnelle et les missions du référent accessibilité numérique de l’entité",
	),
	volet(
		"resources",
		"politique",
		"Ressources humaines et financières",
		"les ressources humaines et financières affectées à l’accessibilité numérique",
	),
	volet(
		"recruitment",
		"politique",
		"Recrutement",
		"la prise en compte des compétences ou connaissances requises dans les fiches de poste et dans les processus de recrutement",
	),
	volet(
		"training",
		"politique",
		"Formation et sensibilisation",
		"les actions de formation et de sensibilisation des agents",
	),
	volet(
		"externalResources",
		"politique",
		"Ressources externes et outillage",
		"la mise en œuvre des ressources et expertises externes auxquelles il est, le cas échéant, fait appel, des moyens techniques et de l’outillage pour gérer et tester l’accessibilité numérique",
	),
	volet(
		"organization",
		"politique",
		"Organisation interne",
		"l’organisation interne pour mettre en œuvre les obligations d’accessibilité des services de communication au public en ligne, y compris les modalités de contrôle des services numériques et d’organisation pour le traitement des demandes des usagers",
	),
	volet(
		"contracts",
		"politique",
		"Clauses contractuelles",
		"l’intégration de l’accessibilité numérique dans les clauses contractuelles (appels d’offres et devis), des critères de notation et de sélection des prestataires et les procédures de recette et, le cas échéant, dans les conventions établies avec leurs opérateurs, délégataires ou partenaires",
	),
	volet(
		"newProjects",
		"travaux",
		"Nouveaux projets",
		"la prise en compte de l’accessibilité numérique dans les nouveaux projets",
	),
	volet(
		"userTests",
		"travaux",
		"Tests utilisateurs",
		"la prise en compte des personnes en situation de handicap dans les tests utilisateurs",
	),
	volet(
		"audits",
		"travaux",
		"Évaluations prévues",
		"les évaluations (ou audits) de conformité prévues pour l’ensemble des services de communication",
	),
	volet(
		"correctiveMeasures",
		"travaux",
		"Mesures correctives",
		"les mesures correctives qui seront prises pour traiter les contenus non accessibles, y compris un calendrier de mise en œuvre de ces mesures, tenant compte du caractère prioritaire des contenus les plus consultés et des services les plus utilisés",
	),
	volet(
		"optionalMeasures",
		"travaux",
		"Mesures non obligatoires",
		"les mesures d’accessibilité non obligatoires, notamment l’accès aux contenus audios et vidéos en langue des signes, la traduction de certains contenus en langage simplifié et tout autre mesure permettant de prendre en compte des critères de niveau triple AAA, des normes internationales, listés en annexe de la norme de référence",
	),
	volet("annualReview", "travaux", "Bilan des plans d’actions annuels", "le bilan des plans d’actions annuels"),
];

// Opérations. Bornes à l'écriture (ADR-0016) : tout ce qu'elles produisent se réimporte à l'identique.
const now = () => new Date().toISOString();
const plan = (s: AuditSession): SchemaPlan => s.schema ?? { sections: {}, actions: [] };
/** Session avec ce schéma ; un schéma vide est retiré. */
function withSchema(session: AuditSession, schema: SchemaPlan, at: string): AuditSession {
	const { schema: _old, ...rest } = session;
	return { ...rest, updatedAt: at, ...(!isEmptySchema(schema) && { schema }) };
}
/** Années de la période, dans l'ordre ; vide tant que la période n'est pas complète. */
export const periodYears = (p: SchemaPlan | undefined): number[] =>
	p?.startYear !== undefined && p.duration !== undefined
		? Array.from({ length: p.duration }, (_, i) => (p.startYear as number) + i)
		: [];

/** Période (ADR-0018 §3) : année de début de 1900 à 9999, durée de 1 à 3 ans ; `undefined` retire la valeur. */
export function setSchemaPeriod(
	session: AuditSession,
	startYear: number | undefined,
	duration: number | undefined,
	at = now(),
): AuditSession {
	if (startYear !== undefined && !isYear(startYear)) throw new Error(`Année de début invalide : ${startYear}`);
	if (duration !== undefined && ![1, 2, 3].includes(duration)) throw new Error(`Durée invalide : ${duration}`);
	if (startYear !== undefined && duration !== undefined && !isYear(startYear + duration - 1))
		throw new Error("Période invalide : elle se terminerait après 9999");
	const { startYear: _s, duration: _d, ...rest } = plan(session);
	// Les années cibles hors de la nouvelle période sont gardées : signalées au rendu, jamais effacées.
	return withSchema(
		session,
		{ ...(startYear !== undefined && { startYear }), ...(duration !== undefined && { duration }), ...rest },
		at,
	);
}

/** Texte d'un volet : nettoyé comme une note (sauts de ligne gardés), borné ; vide, le volet est retiré. */
export function setSchemaSection(
	session: AuditSession,
	section: SchemaSection,
	text: string,
	at = now(),
): AuditSession {
	if (!(SCHEMA_SECTIONS as readonly string[]).includes(section)) throw new Error(`Volet inconnu : ${section}`);
	const p = plan(session);
	const clean = cleanNote(text);
	if (!fits(clean, MAX_SECTION, own(p.sections, section)))
		throw new Error(`Volet de plus de ${MAX_SECTION} caractères`);
	const { [section]: _old, ...sections } = p.sections;
	return withSchema(session, { ...p, sections: clean === "" ? sections : { ...sections, [section]: clean } }, at);
}

/** Action libre (ADR-0018 §2). */
export function addFreeAction(
	session: AuditSession,
	title: string,
	at = now(),
	id: string = crypto.randomUUID(),
): AuditSession {
	const p = plan(session);
	if (!isPageId(id)) throw new Error(`Id d’action invalide : ${id}`);
	if (p.actions.some((a) => a.id === id)) throw new Error(`Id d’action déjà utilisé : ${id}`);
	if (p.actions.length >= MAX_ACTIONS) throw new Error(`Plus de ${MAX_ACTIONS} actions dans le schéma`);
	const clean = stripControl(title).trim();
	if (!clean) throw new Error("Intitulé de l’action vide");
	if (clean.length > MAX_TITLE) throw new Error(`Intitulé de plus de ${MAX_TITLE} caractères`);
	const action: SchemaAction = { id, source: "libre", title: clean, comment: "", removed: false };
	return withSchema(session, { ...p, actions: [...p.actions, action] }, at);
}

export type ActionPatch = {
	priority?: Priority | undefined;
	targetYear?: number | undefined;
	comment?: string;
	removed?: boolean;
	status?: ActionStatus | undefined;
};

/**
 * Réglages d'une action. Une clé présente à `undefined` retire le réglage (« à définir »). L'année cible doit être
 * dans la période du schéma (ADR-0018 §3) : sans période, aucune année cible.
 */
export function updateAction(session: AuditSession, id: string, patch: ActionPatch, at = now()): AuditSession {
	const p = plan(session);
	const current = p.actions.find((a) => a.id === id);
	if (!current) throw new Error(`Action inconnue : ${id}`);
	if (patch.priority !== undefined && !PRIORITIES.includes(patch.priority))
		throw new Error(`Priorité inconnue : ${patch.priority}`);
	if (patch.status !== undefined && !ACTION_STATUSES.includes(patch.status))
		throw new Error(`Bilan inconnu : ${patch.status}`);
	if (patch.targetYear !== undefined && !(isYear(patch.targetYear) && periodYears(p).includes(patch.targetYear)))
		throw new Error(`Année cible hors de la période du schéma : ${patch.targetYear}`);
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (!["priority", "targetYear", "comment", "removed", "status"].includes(key)) continue;
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	if (patch.comment !== undefined) {
		next.comment = cleanNote(patch.comment);
		if (!fits(next.comment as string, MAX_NOTE, current.comment))
			throw new Error(`Commentaire de plus de ${MAX_NOTE} caractères`);
	}
	if (typeof next.removed !== "boolean") throw new Error("Retrait : vrai ou faux attendu");
	return withSchema(
		session,
		{ ...p, actions: p.actions.map((a) => (a.id === id ? (next as unknown as SchemaAction) : a)) },
		at,
	);
}

/** Pages où le critère est non conforme, dans l'ordre de l'échantillon. */
const failingPages = (session: AuditSession, criterion: string) =>
	session.pages.filter((p) => getEvaluation(session, criterion, p.id).status === "NC").map((p) => p.id);

/**
 * Synchronise le tableau d'actions avec l'audit (ADR-0018 §2). Audit complet seulement (ADR-0015 §2) : sinon rien
 * n'est proposé. Une action par critère non validé, avec ses pages ; relancer ne duplique rien, ne réinsère pas une
 * action retirée et ne touche à aucun réglage : seuls les pages et le titre d'une action existante sont mis à jour.
 * Un critère redevenu validé garde son action (marquée au rendu par `actionState`). Rien à changer : même objet.
 */
export function proposeActions(
	session: AuditSession,
	result: Conformity,
	criterionTitles: Readonly<Record<string, string>>,
	at = now(),
	newId: () => string = () => crypto.randomUUID(),
): { session: AuditSession; added: number; updated: number } {
	if (!result.complete) return { session, added: 0, updated: 0 };
	const p = plan(session);
	const actions = [...p.actions];
	let added = 0;
	let updated = 0;
	for (const { criterion, status } of result.criteria) {
		if (status !== "non validé") continue;
		const pages = failingPages(session, criterion);
		const title = truncate(stripControl(own(criterionTitles, criterion) ?? "").trim(), MAX_TITLE);
		const i = actions.findIndex((a) => a.source === "audit" && a.criterion === criterion);
		const existing = actions[i];
		if (!existing) {
			if (actions.length >= MAX_ACTIONS) throw new Error(`Plus de ${MAX_ACTIONS} actions dans le schéma`);
			actions.push({ id: newId(), source: "audit", criterion, pages, title, comment: "", removed: false });
			added++;
		} else if (existing.title !== title || (existing.pages ?? []).join() !== pages.join()) {
			actions[i] = { ...existing, pages, title };
			updated++;
		}
	}
	if (added + updated === 0) return { session, added, updated };
	return { session: withSchema(session, { ...p, actions }, at), added, updated };
}

/**
 * Critère d'une action de l'audit qui n'est plus non validé : « validé » ou « non applicable ». `null` : action libre,
 * critère toujours non validé, ou audit incomplet (on ne sait pas).
 */
export function actionState(action: SchemaAction, result: Conformity): "validé" | "non applicable" | null {
	if (action.source !== "audit" || !result.complete) return null;
	const status = result.criteria.find((c) => c.criterion === action.criterion)?.status;
	return status === "validé" || status === "non applicable" ? status : null;
}

// Rendu : même modèle intermédiaire que la déclaration (ADR-0017), toute saisie en `input`, échappée à la sortie
// (OWASP XSS Prevention Cheat Sheet, « Output Encoding »).
const text = (t: string): Inline => ({ kind: "text", text: t });
const slot = (t: string): Inline => ({ kind: "slot", text: t });
const input = (t: string): Inline => ({ kind: "input", text: t });
const heading = (level: 1 | 2 | 3, t: string): Block => ({ kind: "heading", level, content: [text(t)] });
const paragraph = (...content: Inline[]): Block => ({ kind: "paragraph", content });
const NB = " ";
const PRIORITY_RANK: Record<string, number> = { haute: 0, moyenne: 1, basse: 2 };
const SCHEMA_TITLE = "Schéma pluriannuel de mise en accessibilité numérique";
const planTitle = (year: number) => `Plan d’action ${year}`;

/** Une ligne d'un texte saisi par paragraphe ; contrôles et bidi retirés à la sortie (la relecture ne nettoie rien). */
const lines = (value: string | undefined) =>
	(value ?? "")
		.split("\n")
		.map((l) => stripControl(l).trim())
		.filter(Boolean);

const periodText = (p: SchemaPlan | undefined): string | null => {
	const years = periodYears(p);
	if (years.length === 0) return null;
	return years.length === 1 ? `${years[0]} (1 an)` : `de ${years[0]} à ${years.at(-1)} (${years.length} ans)`;
};

function actionLine(session: AuditSession, a: SchemaAction, result: Conformity, withYear: boolean): Inline[] {
	const out: Inline[] = [];
	const title = stripControl(a.title).trim();
	if (a.source === "audit") {
		const names = (a.pages ?? []).flatMap((id) => {
			const page = session.pages.find((x) => x.id === id);
			return page ? [stripControl(page.title).trim() || page.url] : [];
		});
		out.push(text(`Critère ${a.criterion}${NB}: `), input(title));
		if (names.length > 0)
			out.push(text(names.length > 1 ? ` Pages concernées${NB}: ` : ` Page concernée${NB}: `), input(names.join(", ")));
		out.push(text("."));
	} else out.push(input(title), text("."));
	out.push(text(` Priorité${NB}: `), a.priority ? text(a.priority) : slot("à définir"), text("."));
	if (withYear) {
		out.push(text(` Année cible${NB}: `));
		if (a.targetYear === undefined) out.push(slot("à définir"), text("."));
		else {
			const outside = !periodYears(session.schema).includes(a.targetYear);
			out.push(text(`${a.targetYear}${outside ? " (hors de la période du schéma, à redéfinir)" : ""}.`));
		}
	}
	const comment = lines(a.comment).join(" ");
	if (comment) out.push(text(` Commentaire${NB}: `), input(comment));
	const state = actionState(a, result);
	if (state) out.push(text(` (critère désormais ${state})`));
	return out;
}

/** Calendrier : par année cible (sans année en dernier), puis par priorité, puis dans l'ordre du tableau. */
const byCalendar = (actions: SchemaAction[]) =>
	actions
		.map((a, i) => ({ a, i }))
		.sort(
			(x, y) =>
				(x.a.targetYear ?? Number.POSITIVE_INFINITY) - (y.a.targetYear ?? Number.POSITIVE_INFINITY) ||
				(PRIORITY_RANK[x.a.priority ?? ""] ?? 3) - (PRIORITY_RANK[y.a.priority ?? ""] ?? 3) ||
				x.i - y.i,
		)
		.map(({ a }) => a);

/** Schéma pluriannuel, bloc par bloc : chaque volet officiel cité, la saisie de l'organisme, ou « à compléter ». */
export function schemaBlocks(session: AuditSession, result: Conformity): Block[] {
	const p = session.schema;
	const period = periodText(p);
	const blocks: Block[] = [
		heading(1, SCHEMA_TITLE),
		paragraph(
			text("Période : "),
			...(period ? [text(period)] : [slot("à compléter : année de début et durée, de 1 à 3 ans")]),
			text("."),
		),
		paragraph(text(SCHEMA_MENTION)),
	];
	for (const v of VOLETS) {
		if (v.id === "strategy") blocks.push(heading(2, "Politique d’accessibilité numérique"));
		if (v.id === "newProjects") blocks.push(heading(2, "Travaux de mise en conformité"));
		blocks.push(heading(3, v.label), paragraph(text(`Ce volet présente ${v.description}.`)));
		const own = lines(p?.sections[v.id]).map((l) => paragraph(input(l)));
		blocks.push(...own);
		let empty = own.length === 0;
		if (v.id === "correctiveMeasures") {
			const actions = p?.actions ?? [];
			const active = byCalendar(actions.filter((a) => !a.removed));
			const removed = actions.filter((a) => a.removed);
			if (!result.complete && !actions.some((a) => a.source === "audit"))
				blocks.push(
					paragraph(
						text("L’audit n’est pas complet : aucune action n’a encore été proposée à partir de ses résultats."),
					),
				);
			if (active.length > 0) {
				blocks.push(paragraph(text(`Calendrier des actions${NB}:`)), {
					kind: "list",
					items: active.map((a) => actionLine(session, a, result, true)),
				});
				empty = false;
			}
			if (removed.length > 0)
				blocks.push(paragraph(text(`Actions retirées par l’organisme, gardées pour mémoire${NB}:`)), {
					kind: "list",
					items: removed.map((a) => [...actionLine(session, a, result, true), text(" (retirée)")]),
				});
		}
		if (empty) blocks.push(paragraph(slot("À compléter")));
	}
	return blocks;
}

/**
 * Plan d'action de `year` (ADR-0018 §4) : les actions non retirées dont c'est l'année cible, puis le bilan de
 * l'année précédente (faite, en cours, reportée, ou à compléter).
 */
export function planBlocks(session: AuditSession, result: Conformity, year: number): Block[] {
	const actions = (session.schema?.actions ?? []).filter((a) => !a.removed);
	const planned = byCalendar(actions.filter((a) => a.targetYear === year));
	const previous = byCalendar(actions.filter((a) => a.targetYear === year - 1));
	const period = periodText(session.schema);
	return [
		heading(1, planTitle(year)),
		paragraph(
			text(
				`Plan d’action annuel du schéma pluriannuel de mise en accessibilité numérique${period ? ` (${period.replace(/ \(.*\)$/, "")})` : ""}.`,
			),
		),
		paragraph(text(SCHEMA_MENTION)),
		heading(2, `Actions prévues en ${year}`),
		planned.length > 0
			? { kind: "list", items: planned.map((a) => actionLine(session, a, result, false)) }
			: paragraph(text("Aucune action prévue pour cette année.")),
		heading(2, `Bilan de l’année précédente (${year - 1})`),
		previous.length > 0
			? {
					kind: "list",
					items: previous.map((a) => [
						...actionLine(session, a, result, false),
						text(` Bilan${NB}: `),
						a.status ? text(a.status) : slot("à compléter : faite, en cours ou reportée"),
						text("."),
					]),
				}
			: paragraph(text(`Aucune action n’était prévue en ${year - 1} : pas de bilan à faire.`)),
	];
}

export interface SchemaRenderOptions {
	format: "html" | "markdown";
	/** HTML : page complète ; sinon fragment qui commence au h2, à coller sous le h1 d'une page existante. */
	standalone?: boolean;
}
const render = (blocks: Block[], title: string, { format, standalone }: SchemaRenderOptions) =>
	format === "markdown"
		? blocksToMarkdown(blocks)
		: standalone
			? standaloneHtml(title, blocksToHtml(blocks))
			: blocksToHtml(blocks, 1);

export const renderSchema = (session: AuditSession, result: Conformity, options: SchemaRenderOptions) =>
	render(schemaBlocks(session, result), SCHEMA_TITLE, options);

export const renderAnnualPlan = (
	year: number,
	session: AuditSession,
	result: Conformity,
	options: SchemaRenderOptions,
) => render(planBlocks(session, result, year), planTitle(year), options);

/** `schema-pluriannuel-<hôte>-<AAAA-MM-JJ>.<html|md>`, date locale. */
export const schemaFileName = (session: AuditSession, date: Date, extension: "html" | "md") =>
	`schema-pluriannuel-${siteAndDay(session, date)}.${extension}`;
/** `plan-action-<année>-<hôte>-<AAAA-MM-JJ>.<html|md>`. */
export const planFileName = (session: AuditSession, year: number, date: Date, extension: "html" | "md") =>
	`plan-action-${year}-${siteAndDay(session, date)}.${extension}`;
