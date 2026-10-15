// Modèle d'une session d'audit manuel (ADR-0013 §1) : données et opérations pures, sans dépendance.
// Volontairement indépendant du référentiel (rgaa.ts) : l'îlot de /audit/ l'importe sans embarquer les données RGAA.
// Statuts et règles : méthode RGAA, src/obligations/evaluation-conformite.md.
import { stripBidi } from "./sample-file.ts";

export const SCHEMA_VERSION = 2;

/** C : conforme, NC : non conforme, NA : non applicable, NT : non testé (état initial). */
export type Status = "C" | "NC" | "NA" | "NT";
export const STATUSES: readonly Status[] = ["C", "NC", "NA", "NT"];

export interface SessionPage {
	/** Id stable (jamais un index de tableau) : retirer une page ne décale pas les évaluations des autres. */
	id: string;
	url: string;
	title: string;
	/** Nom du processus (formulaire en plusieurs étapes…) auquel la page appartient. */
	process?: string;
}

/** Qui a posé l'évaluation (ADR-0014 §1) : un import automatique ne remplace jamais une évaluation `humain`. */
export type Source = "auto" | "humain";

export interface Evaluation {
	status: Status;
	note: string;
	source: Source;
}

/** Classes de résultat de la CLI (ADR-0011 §3). */
export type ResultKind = "non-conformite" | "incertain" | "bonne-pratique" | "a-verifier";
export const RESULT_KINDS: readonly ResultKind[] = ["non-conformite", "incertain", "bonne-pratique", "a-verifier"];

/** Indice importé d'un rapport automatique (ADR-0014 §2) : affiché à l'humain, il ne vaut ni C ni NC. */
export interface Finding {
	ruleId: string;
	kind: ResultKind;
	impact?: string;
	/** Nombre d'éléments en défaut sur la page. */
	nodes: number;
	/** Description de la règle par axe, en anglais. */
	help?: string;
}

export interface AuditSession {
	schemaVersion: typeof SCHEMA_VERSION;
	/** Origine du site audité, fixée par la première page. */
	site: string;
	createdAt: string;
	updatedAt: string;
	pages: SessionPage[];
	/** `evaluations[critère][pageId]`. Une évaluation absente vaut « non testé ». */
	evaluations: Record<string, Record<string, Evaluation>>;
	/** `findings[critère][pageId]` : indices des imports automatiques. */
	findings: Record<string, Record<string, Finding[]>>;
}

export interface Count {
	/** Évaluations encore « non testé ». */
	remaining: number;
	/** Évaluations posées par un import (source `auto`) que l'humain n'a pas encore confirmées. */
	toConfirm: number;
	total: number;
}

const NOT_TESTED: Evaluation = { status: "NT", note: "", source: "humain" };
const now = () => new Date().toISOString();

/** Ids de page : UUID (crypto.randomUUID). Jamais un nom hérité d'Object.prototype (`toString`, `__proto__`…). */
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isPageId = (id: string) => PAGE_ID.test(id);
/**
 * Forme d'un numéro de critère RGAA (« 1.1 » … « 13.12 »). Le modèle ne connaît pas le référentiel (il doit rester
 * sans données pour l'îlot) : il refuse tout ce qui n'a pas cette forme, l'appelant ne passe que des critères réels.
 */
const CRITERION_ID = /^[1-9]\d?\.[1-9]\d?$/;
export const own = <T>(record: Record<string, T>, key: string): T | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined;

export function createSession(at = now()): AuditSession {
	return {
		schemaVersion: SCHEMA_VERSION,
		site: "",
		createdAt: at,
		updatedAt: at,
		pages: [],
		evaluations: {},
		findings: {},
	};
}

export function addPage(
	session: AuditSession,
	page: Omit<SessionPage, "id">,
	at = now(),
	id: string = crypto.randomUUID(),
): AuditSession {
	if (!PAGE_ID.test(id)) throw new Error(`Id de page invalide : ${id}`);
	if (session.pages.some((p) => p.id === id)) throw new Error(`Id de page déjà utilisé : ${id}`);
	let site = session.site;
	if (!site) {
		try {
			site = new URL(page.url).origin;
		} catch {}
	}
	// Contrôles bidi retirés : un nom de page ne doit pas pouvoir retourner le texte affiché à côté (Trojan Source).
	return { ...session, site, updatedAt: at, pages: [...session.pages, { ...page, title: stripBidi(page.title), id }] };
}

/** Copie de `byCriterion` sans les entrées de `pageId` (critères vidés retirés). */
function withoutPage<T>(byCriterion: Record<string, Record<string, T>>, pageId: string) {
	const out: Record<string, Record<string, T>> = {};
	for (const [criterion, byPage] of Object.entries(byCriterion)) {
		const { [pageId]: _removed, ...rest } = byPage;
		if (Object.keys(rest).length > 0) out[criterion] = rest;
	}
	return out;
}

/** Retire la page, ses évaluations et ses indices ; sans page, la session n'est plus rattachée à aucun site. */
export function removePage(session: AuditSession, pageId: string, at = now()): AuditSession {
	const pages = session.pages.filter((p) => p.id !== pageId);
	return {
		...session,
		site: pages.length > 0 ? session.site : "",
		updatedAt: at,
		pages,
		evaluations: withoutPage(session.evaluations, pageId),
		findings: withoutPage(session.findings, pageId),
	};
}

export function getEvaluation(session: AuditSession, criterionId: string, pageId: string): Evaluation {
	const byPage = own(session.evaluations, criterionId);
	return (byPage && own(byPage, pageId)) ?? NOT_TESTED;
}

export function getFindings(session: AuditSession, criterionId: string, pageId: string): Finding[] {
	const byPage = own(session.findings, criterionId);
	return (byPage && own(byPage, pageId)) ?? [];
}

/**
 * Évaluation saisie par l'humain : la source devient `humain` (ADR-0014 §1), même si seule la note change.
 * Un patch vide confirme une évaluation automatique telle quelle. Changer le statut d'une évaluation encore
 * automatique vide sa note générée (jamais éditée : éditer la note l'aurait rendue humaine).
 */
export function setEvaluation(
	session: AuditSession,
	criterionId: string,
	pageId: string,
	patch: Partial<Omit<Evaluation, "source">> & { source?: Source },
	at = now(),
): AuditSession {
	if (!CRITERION_ID.test(criterionId)) throw new Error(`Évaluation sur un critère inconnu : ${criterionId}`);
	if (!session.pages.some((p) => p.id === pageId)) throw new Error(`Évaluation sur une page inconnue : ${pageId}`);
	const current = getEvaluation(session, criterionId, pageId);
	const next: Evaluation = { ...current, source: "humain", ...patch };
	if (current.source === "auto" && patch.status !== undefined && patch.status !== current.status && !("note" in patch))
		next.note = "";
	next.note = stripBidi(next.note);
	return {
		...session,
		updatedAt: at,
		evaluations: {
			...session.evaluations,
			[criterionId]: { ...own(session.evaluations, criterionId), [pageId]: next },
		},
	};
}

/** Avancement : évaluations « non testé » restantes et évaluations automatiques à confirmer. */
export function progress(
	session: AuditSession,
	criteria: readonly { id: string; topic: number }[],
): { total: Count; byTopic: Record<number, Count>; byCriterion: Record<string, Count> } {
	const empty = (): Count => ({ remaining: 0, toConfirm: 0, total: 0 });
	const total = empty();
	const byTopic: Record<number, Count> = {};
	const byCriterion: Record<string, Count> = {};
	for (const c of criteria) {
		const count = empty();
		for (const p of session.pages) {
			const e = getEvaluation(session, c.id, p.id);
			if (e.status === "NT") count.remaining++;
			if (e.source === "auto") count.toConfirm++;
			count.total++;
		}
		byCriterion[c.id] = count;
		const topic = byTopic[c.topic] ?? empty();
		byTopic[c.topic] = topic;
		for (const t of [topic, total]) {
			t.remaining += count.remaining;
			t.toConfirm += count.toConfirm;
			t.total += count.total;
		}
	}
	return { total, byTopic, byCriterion };
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

function isFinding(f: unknown): f is Finding {
	return (
		isObject(f) &&
		isString(f.ruleId) &&
		RESULT_KINDS.includes(f.kind as ResultKind) &&
		Number.isSafeInteger(f.nodes) &&
		(f.nodes as number) >= 0 &&
		(f.impact === undefined || isString(f.impact)) &&
		(f.help === undefined || isString(f.help))
	);
}

/** Vrai si `byCriterion` n'a que des critères bien formés, des pages connues et des valeurs acceptées par `valid`. */
function validMap(byCriterion: unknown, ids: Set<string>, valid: (v: unknown) => boolean): boolean {
	if (!isObject(byCriterion)) return false;
	for (const [criterionId, byPage] of Object.entries(byCriterion)) {
		if (!CRITERION_ID.test(criterionId) || !isObject(byPage)) return false;
		for (const [pageId, v] of Object.entries(byPage)) if (!ids.has(pageId) || !valid(v)) return false;
	}
	return true;
}

/**
 * Session écrite par une version plus récente de Rampe (onglet resté sur l'ancienne version pendant un
 * déploiement) : ni lisible ni corrompue, elle ne doit surtout pas être écrasée.
 */
export const isFutureSession = (value: unknown): boolean =>
	isObject(value) && typeof value.schemaVersion === "number" && value.schemaVersion > SCHEMA_VERSION;

/**
 * Relit une session venue du stockage local : forme et `schemaVersion` vérifiées, `null` sinon.
 * Une session v1 (sans `source` ni `findings`) est migrée sans perte : ses évaluations sont humaines (ADR-0014).
 * Contrôle minimal pour ne pas planter l'interface ; un fichier venu de l'extérieur passe par une validation stricte.
 */
export function parseSession(value: unknown): AuditSession | null {
	if (!isObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== SCHEMA_VERSION)) return null;
	const v1 = value.schemaVersion === 1;
	const { site, createdAt, updatedAt, pages, evaluations } = value;
	if (![site, createdAt, updatedAt].every(isString) || !Array.isArray(pages)) return null;
	const ids = new Set<string>();
	for (const p of pages) {
		if (!isObject(p) || !isString(p.id) || !PAGE_ID.test(p.id) || !isString(p.url) || !isString(p.title)) return null;
		if (ids.has(p.id)) return null;
		if (p.process !== undefined && !isString(p.process)) return null;
		ids.add(p.id);
	}
	const isEvaluation = (e: unknown) =>
		isObject(e) &&
		STATUSES.includes(e.status as Status) &&
		isString(e.note) &&
		(v1 || e.source === "auto" || e.source === "humain");
	if (!validMap(evaluations, ids, isEvaluation)) return null;
	if (!v1) {
		const findings = value.findings;
		if (!validMap(findings, ids, (list) => Array.isArray(list) && list.every(isFinding))) return null;
		return value as unknown as AuditSession;
	}
	const migrated: AuditSession["evaluations"] = {};
	for (const [criterionId, byPage] of Object.entries(evaluations as AuditSession["evaluations"])) {
		migrated[criterionId] = {};
		for (const [pageId, e] of Object.entries(byPage)) migrated[criterionId][pageId] = { ...e, source: "humain" };
	}
	return { ...(value as unknown as AuditSession), schemaVersion: SCHEMA_VERSION, evaluations: migrated, findings: {} };
}
