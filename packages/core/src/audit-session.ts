// Modèle d'une session d'audit manuel (ADR-0013 §1) : données et opérations pures, sans dépendance.
// Volontairement indépendant du référentiel (rgaa.ts) : l'îlot de /audit/ l'importe sans embarquer les données RGAA.
// Statuts et règles : méthode RGAA, src/obligations/evaluation-conformite.md.

export const SCHEMA_VERSION = 1;

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

export interface Evaluation {
	status: Status;
	note: string;
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
}

export interface Count {
	/** Évaluations encore « non testé ». */
	remaining: number;
	total: number;
}

const NOT_TESTED: Evaluation = { status: "NT", note: "" };
const now = () => new Date().toISOString();

export function createSession(at = now()): AuditSession {
	return { schemaVersion: SCHEMA_VERSION, site: "", createdAt: at, updatedAt: at, pages: [], evaluations: {} };
}

export function addPage(
	session: AuditSession,
	page: Omit<SessionPage, "id">,
	at = now(),
	id: string = crypto.randomUUID(),
): AuditSession {
	if (session.pages.some((p) => p.id === id)) throw new Error(`Id de page déjà utilisé : ${id}`);
	let site = session.site;
	if (!site) {
		try {
			site = new URL(page.url).origin;
		} catch {}
	}
	return { ...session, site, updatedAt: at, pages: [...session.pages, { ...page, id }] };
}

/** Retire la page et toutes ses évaluations. */
export function removePage(session: AuditSession, pageId: string, at = now()): AuditSession {
	const evaluations: AuditSession["evaluations"] = {};
	for (const [criterion, byPage] of Object.entries(session.evaluations)) {
		const { [pageId]: _removed, ...rest } = byPage;
		if (Object.keys(rest).length > 0) evaluations[criterion] = rest;
	}
	return { ...session, updatedAt: at, pages: session.pages.filter((p) => p.id !== pageId), evaluations };
}

export function getEvaluation(session: AuditSession, criterionId: string, pageId: string): Evaluation {
	return session.evaluations[criterionId]?.[pageId] ?? NOT_TESTED;
}

export function setEvaluation(
	session: AuditSession,
	criterionId: string,
	pageId: string,
	patch: Partial<Evaluation>,
	at = now(),
): AuditSession {
	if (!session.pages.some((p) => p.id === pageId)) throw new Error(`Évaluation sur une page inconnue : ${pageId}`);
	const next = { ...getEvaluation(session, criterionId, pageId), ...patch };
	return {
		...session,
		updatedAt: at,
		evaluations: {
			...session.evaluations,
			[criterionId]: { ...session.evaluations[criterionId], [pageId]: next },
		},
	};
}

/** Avancement : évaluations « non testé » restantes, par critère, par thématique et au total. */
export function progress(
	session: AuditSession,
	criteria: readonly { id: string; topic: number }[],
): { total: Count; byTopic: Record<number, Count>; byCriterion: Record<string, Count> } {
	const total: Count = { remaining: 0, total: 0 };
	const byTopic: Record<number, Count> = {};
	const byCriterion: Record<string, Count> = {};
	for (const c of criteria) {
		const remaining = session.pages.filter((p) => getEvaluation(session, c.id, p.id).status === "NT").length;
		const count = { remaining, total: session.pages.length };
		byCriterion[c.id] = count;
		const topic = byTopic[c.topic] ?? { remaining: 0, total: 0 };
		byTopic[c.topic] = topic;
		topic.remaining += remaining;
		topic.total += count.total;
		total.remaining += remaining;
		total.total += count.total;
	}
	return { total, byTopic, byCriterion };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

/**
 * Relit une session venue du stockage local : forme et `schemaVersion` vérifiées, `null` sinon.
 * Contrôle minimal pour ne pas planter l'interface ; l'import de fichier (tâche distincte) validera plus strictement.
 */
export function parseSession(value: unknown): AuditSession | null {
	if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
	const { site, createdAt, updatedAt, pages, evaluations } = value;
	if (![site, createdAt, updatedAt].every(isString) || !Array.isArray(pages) || !isObject(evaluations)) return null;
	const ids = new Set<string>();
	for (const p of pages) {
		if (!isObject(p) || !isString(p.id) || !isString(p.url) || !isString(p.title) || ids.has(p.id)) return null;
		if (p.process !== undefined && !isString(p.process)) return null;
		ids.add(p.id);
	}
	for (const byPage of Object.values(evaluations)) {
		if (!isObject(byPage)) return null;
		for (const [pageId, e] of Object.entries(byPage)) {
			if (!ids.has(pageId) || !isObject(e) || !STATUSES.includes(e.status as Status) || !isString(e.note)) return null;
		}
	}
	return value as unknown as AuditSession;
}
