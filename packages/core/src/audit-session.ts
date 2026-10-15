// Modèle d'une session d'audit manuel (ADR-0013 §1) : données et opérations pures, sans dépendance.
// Volontairement indépendant du référentiel (rgaa.ts) : l'îlot de /audit/ l'importe sans embarquer les données RGAA.
// Statuts et règles : méthode RGAA, src/obligations/evaluation-conformite.md.
import { parseAuditUrl, stripBidi, stripControl, truncate } from "./sample-file.ts";
import {
	array,
	checkKeys,
	display,
	fail,
	field,
	IMPACTS,
	isObject,
	MAX_FINDINGS,
	MAX_PAGES,
	MAX_URL,
	object,
	REPORT_TOOL_NAME,
	ReportError,
	RULE_ID,
	SESSION_TOOL_NAME,
	strictly,
	string,
	toolName,
} from "./strict.ts";

export { isObject, MAX_PAGES, MAX_SESSION_BYTES, MAX_URL, SESSION_TOOL_NAME } from "./strict.ts";

/**
 * 3 : champs de la déclaration d'accessibilité (ADR-0017). Une session v1 ou v2 est migrée sans perte (elle n'en a
 * pas) ; un onglet resté sur une version précédente voit une session v3 comme « future » et ne l'écrase pas, au lieu
 * de la relire en perdant la déclaration.
 */
export const SCHEMA_VERSION = 3;

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
	/**
	 * Date du dernier téléchargement de l'audit (ADR-0016 §4) ; absente : jamais téléchargé. Dans la session plutôt
	 * qu'à côté : elle suit l'audit qu'elle décrit (synchro des onglets, « Annuler cet import », « Recommencer »).
	 */
	exportedAt?: string;
	pages: SessionPage[];
	/** `evaluations[critère][pageId]`. Une évaluation absente vaut « non testé ». */
	evaluations: Record<string, Record<string, Evaluation>>;
	/** `findings[critère][pageId]` : indices des imports automatiques. */
	findings: Record<string, Record<string, Finding[]>>;
	/** Champs de la déclaration d'accessibilité saisis par l'utilisateur (ADR-0017 §3) ; absent : aucun saisi. */
	declaration?: DeclarationFields;
}

/**
 * Champs que Rampe ne remplit jamais à la place de l'utilisateur (ADR-0017 §3), et leur nature :
 * - `text` : une ligne ; `lines` : un élément de liste par ligne ; `url` : adresse http(s) ou `mailto:` (une adresse
 *   e-mail seule vaut `mailto:`), vérifiée au RENDU, pas à la saisie : un texte en cours de frappe est gardé tel quel,
 *   et un audit produit par l'interface se réimporte toujours ;
 * - `date` : `AAAA-MM-JJ` (champ date du navigateur) ; `auditBy` : `interne` ou `prestataire`.
 */
export const DECLARATION_FIELDS = {
	organization: "text",
	commitment: "text",
	schemeUrl: "url",
	actionPlanUrl: "url",
	serviceName: "text",
	auditBy: "auditBy",
	auditCompany: "text",
	reportUrl: "url",
	nonConformities: "lines",
	derogations: "lines",
	exemptions: "lines",
	establishedOn: "date",
	updatedOn: "date",
	technologies: "lines",
	testEnvironment: "lines",
	tools: "lines",
	contactFormUrl: "url",
	contactEntity: "text",
	contactPageUrl: "url",
} as const;
export type DeclarationField = keyof typeof DECLARATION_FIELDS;
/** Valeurs saisies ; un champ vide est absent. */
export type DeclarationFields = Partial<Record<DeclarationField, string>>;
export const AUDIT_BY = ["interne", "prestataire"] as const;
/** Bornes des champs de la déclaration, mêmes règles que les autres textes (ADR-0016). */
export const MAX_DECLARATION_TEXT = 1000;
export const MAX_DECLARATION_LINES = 10_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Date `AAAA-MM-JJ` qui existe au calendrier (pas de 31 février). */
export const isDay = (value: string) => {
	const date = new Date(`${value}T00:00:00Z`);
	return DAY.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
const isDeclarationField = (key: string): key is DeclarationField => Object.hasOwn(DECLARATION_FIELDS, key);
const declarationMax = (kind: string) =>
	kind === "lines" ? MAX_DECLARATION_LINES : kind === "url" ? MAX_URL : MAX_DECLARATION_TEXT;

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
	// Bornes à l'écriture (ADR-0016) : l'appelant les vérifie avant ; tout ce que le modèle produit se réimporte.
	if (session.pages.length >= MAX_PAGES) throw new Error(`Plus de ${MAX_PAGES} pages dans l’échantillon`);
	if (page.url.length > MAX_URL) throw new Error(`Adresse de plus de ${MAX_URL} caractères`);
	// Même nettoyage que l'import (`display`) : contrôles et bidi retirés (Trojan Source), espaces de bord retirés.
	const title = stripControl(page.title).trim();
	if (title.length > MAX_TITLE) throw new Error(`Nom de page de plus de ${MAX_TITLE} caractères`);
	let site = session.site;
	if (!site) {
		try {
			site = new URL(page.url).origin;
		} catch {}
	}
	return { ...session, site, updatedAt: at, pages: [...session.pages, { ...page, title, id }] };
}

/**
 * Processus de la page (ADR-0015 §5). La valeur est gardée telle que saisie (espaces compris, pour ne pas manger
 * l'espace en cours de frappe) ; le calcul du taux compare les noms sans espaces autour ni casse. Vide : aucun.
 */
export function setPageProcess(session: AuditSession, pageId: string, process: string, at = now()): AuditSession {
	const page = session.pages.find((p) => p.id === pageId);
	if (!page) throw new Error(`Page inconnue : ${pageId}`);
	const clean = stripControl(process);
	if (!fits(clean, MAX_PROCESS, page.process)) throw new Error(`Processus de plus de ${MAX_PROCESS} caractères`);
	return {
		...session,
		updatedAt: at,
		pages: session.pages.map((p) => {
			if (p.id !== pageId) return p;
			const { process: _old, ...rest } = p;
			return clean ? { ...rest, process: clean } : rest;
		}),
	};
}

/**
 * Texte dans sa borne. Un texte plus long écrit par une version précédente (relu sans borne) peut être corrigé, pas
 * allongé : l'interface pose `maxLength` au maximum de la borne et de la longueur actuelle.
 */
const fits = (text: string, max: number, previous = "") => text.length <= Math.max(max, previous.length);

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
	next.note = cleanNote(next.note);
	if ("note" in patch && !fits(next.note, MAX_NOTE, current.note))
		throw new Error(`Note de plus de ${MAX_NOTE} caractères`);
	return {
		...session,
		updatedAt: at,
		evaluations: {
			...session.evaluations,
			[criterionId]: { ...own(session.evaluations, criterionId), [pageId]: next },
		},
	};
}

/**
 * Saisie d'un champ de la déclaration (ADR-0017 §3). Nettoyée comme le reste à l'écriture (contrôles et bidi retirés,
 * sauts de ligne gardés dans un champ `lines`), bornée (ADR-0016) ; une valeur vide retire le champ. Pas de `trim` :
 * l'espace en cours de frappe reste, le rendu ignore les espaces de bord.
 */
export function setDeclarationField(
	session: AuditSession,
	field: DeclarationField,
	value: string,
	at = now(),
): AuditSession {
	if (!isDeclarationField(field)) throw new Error(`Champ de déclaration inconnu : ${field}`);
	const kind = DECLARATION_FIELDS[field];
	const current = session.declaration ?? {};
	const clean = kind === "lines" ? cleanNote(value) : stripControl(value);
	if (kind === "date" && clean !== "" && !isDay(clean)) throw new Error(`Date invalide : ${clean}`);
	if (kind === "auditBy" && clean !== "" && !(AUDIT_BY as readonly string[]).includes(clean))
		throw new Error(`Réalisation de l’audit inconnue : ${clean}`);
	const max = declarationMax(kind);
	if (!fits(clean, max, own(current, field))) throw new Error(`Champ de plus de ${max} caractères`);
	const { [field]: _old, ...rest } = current;
	const declaration: DeclarationFields = clean === "" ? rest : { ...rest, [field]: clean };
	const { declaration: _previous, ...base } = session;
	return { ...base, updatedAt: at, ...(Object.keys(declaration).length > 0 && { declaration }) };
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

/** Message d'un fichier refusé à l'import d'un audit (ADR-0016 §2) ; le détail technique suit, replié. */
export const INVALID_SESSION = "Ce fichier n’est pas un audit Rampe, ou il a été modifié. Rien n’a été importé.";
export const FUTURE_SESSION =
	"Cet audit a été créé par une version plus récente de Rampe : rechargez la page, puis importez-le à nouveau. Rien n’a été importé.";
/** Rapport de la CLI donné au champ de l'audit : on oriente vers le bon champ. */
export const REPORT_GIVEN_AS_SESSION =
	"Ce fichier est un rapport de la CLI Rampe, pas un audit complet : importez-le avec le champ « Importer un rapport de la CLI (JSON) », section « 1. Pages de l’échantillon ». Rien n’a été importé.";

/**
 * Session écrite par une version plus récente de Rampe (onglet resté sur l'ancienne version pendant un
 * déploiement) : ni lisible ni corrompue, elle ne doit surtout pas être écrasée.
 */
export const isFutureSession = (value: unknown): boolean =>
	isObject(value) && typeof value.schemaVersion === "number" && value.schemaVersion > SCHEMA_VERSION;

/** Fichier d'export (ADR-0016 §1) : la session complète, marquée par l'outil qui l'a écrite. */
export function serializeSession(session: AuditSession): string {
	const { schemaVersion, ...rest } = session;
	return JSON.stringify({ schemaVersion, tool: { name: SESSION_TOOL_NAME }, ...rest });
}

/** `<hôte>-<AAAA-MM-JJ>`, date locale ; caractères hors [a-z0-9.-] remplacés (IPv6, port). */
export function siteAndDay(session: AuditSession, date: Date): string {
	let host = "sans-site";
	try {
		host = new URL(session.site).hostname.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-|-$/g, "") || host;
	} catch {}
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${host}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `audit-<hôte>-<AAAA-MM-JJ>.json`. */
export const sessionFileName = (session: AuditSession, date: Date) => `audit-${siteAndDay(session, date)}.json`;

// Bornes des textes saisis par l'humain (ADR-0016 §2, en cohérence avec ADR-0014 §4) : un texte seulement affiché
// (titre, note, description de règle) est tronqué, jamais rejeté ; le processus, qui entre dans le calcul du taux
// (ADR-0015), est rejeté au-delà de sa borne plutôt que modifié. Les bornes dépassent celles de l'interface
// (maxLength) et des textes déjà tronqués par l'import de la CLI (300 + « … (tronqué) »), pour qu'un aller-retour
// export → import ne change rien.
export const MAX_TITLE = 1000;
export const MAX_NOTE = 10_000;
const MAX_HELP = 1000;
export const MAX_PROCESS = 200;
/** Dates écrites par `toISOString()` : seule forme acceptée à l'import d'un fichier. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Note sur plusieurs lignes : contrôles et bidi retirés, sauts de ligne et tabulations gardés. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ce qu'on retire.
export const cleanNote = (text: string) => stripBidi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/**
 * Valide une session importée d'un fichier (ADR-0016 §2), déjà désérialisée par `JSON.parse` seul. Liste blanche,
 * tout ou rien : lève une `ReportError` dont `detail` nomme le premier défaut. Propriétés inconnues ignorées, objets
 * reconstruits. `knownCriteria` : critères du référentiel (le modèle n'embarque pas les données RGAA). Une session v1
 * (sans `source` ni `findings`) est migrée sans perte : ses évaluations sont humaines. `tool` est facultatif : le
 * stockage local des versions précédentes n'en avait pas. Bornes de longueur et de nombre appliquées, textes
 * d'affichage nettoyés et tronqués.
 */
export function parseSessionStrict(json: unknown, knownCriteria: ReadonlySet<string>): AuditSession {
	return strictly(INVALID_SESSION, () => parseSessionWith(json, knownCriteria, true));
}

/**
 * Relit le stockage local (ADR-0016) : mêmes contrôles de structure et de type que `parseSessionStrict`, mais SANS
 * borne de longueur ni de nombre et SANS rien modifier. Une session écrite par une version précédente, aux textes
 * plus longs que les bornes d'aujourd'hui, est relue telle quelle : la relecture ne perd jamais rien.
 */
export function parseStoredSession(json: unknown, knownCriteria: ReadonlySet<string>): AuditSession {
	return strictly(INVALID_SESSION, () => parseSessionWith(json, knownCriteria, false));
}

/** `bounded` : import d'un fichier (bornes, nettoyage, troncature) ; sinon relecture du stockage (structure et types). */
function parseSessionWith(json: unknown, known: ReadonlySet<string>, bounded: boolean): AuditSession {
	const root = object(json, "fichier");
	// Avant tout autre contrôle : une session d'une version future n'est jamais traitée comme abîmée.
	if (isFutureSession(root)) throw new ReportError(FUTURE_SESSION);
	checkKeys(json, "fichier");
	const name = toolName(root);
	if (name === REPORT_TOOL_NAME) throw new ReportError(REPORT_GIVEN_AS_SESSION);
	if (field(root, "tool") !== undefined && name !== SESSION_TOOL_NAME)
		fail("tool.name", "ce fichier n’a pas été produit par l’audit guidé de Rampe");
	const version = field(root, "schemaVersion");
	if (version !== 1 && version !== 2 && version !== SCHEMA_VERSION)
		fail("schemaVersion", `version ${JSON.stringify(version) ?? "absente"} non prise en charge`);
	const v1 = version === 1;
	const limit = (max: number) => (bounded ? max : Number.POSITIVE_INFINITY);
	const date = (key: string) => {
		const value = string(field(root, key), key);
		if (Number.isNaN(Date.parse(value)) || (bounded && !ISO_DATE.test(value)))
			fail(key, "date invalide (attendu : AAAA-MM-JJTHH:MM:SS.sssZ)");
		return value;
	};
	const createdAt = date("createdAt");
	const updatedAt = date("updatedAt");
	const exportedAt = field(root, "exportedAt") === undefined ? undefined : date("exportedAt");
	const site = string(field(root, "site"), "site");
	if (site !== "") {
		let origin = "";
		try {
			origin = parseAuditUrl(site).origin;
		} catch {}
		if (origin !== site) fail("site", "origine http(s) attendue");
	}
	/** Texte affiché : nettoyé et tronqué à l'import ; tel quel à la relecture. */
	const text = (v: unknown, path: string, max: number) => (bounded ? display(v, path, max) : string(v, path));

	const ids = new Set<string>();
	const pages = array(field(root, "pages"), "pages", limit(MAX_PAGES)).map((raw, i): SessionPage => {
		const at = `pages[${i}]`;
		const page = object(raw, at);
		const id = string(field(page, "id"), `${at}.id`);
		if (!PAGE_ID.test(id)) fail(`${at}.id`, "identifiant de page qui n’est pas un UUID");
		if (ids.has(id)) fail(`${at}.id`, "identifiant de page en double");
		ids.add(id);
		const url = string(field(page, "url"), `${at}.url`);
		if (url.length > limit(MAX_URL)) fail(`${at}.url`, `adresse de plus de ${MAX_URL} caractères`);
		let parsed: URL;
		try {
			parsed = parseAuditUrl(url);
		} catch (e) {
			return fail(`${at}.url`, (e as Error).message.replace(/\.$/, ""));
		}
		if (parsed.origin !== site) fail(`${at}.url`, `autre site que « ${site} » : un audit porte sur un seul site`);
		if (parsed.username || parsed.password) fail(`${at}.url`, "identifiants dans l’adresse");
		const rawProcess = field(page, "process");
		const rawText = rawProcess === undefined ? "" : string(rawProcess, `${at}.process`);
		const process = bounded ? stripControl(rawText) : rawText;
		if (process.length > limit(MAX_PROCESS)) fail(`${at}.process`, `processus de plus de ${MAX_PROCESS} caractères`);
		// Relecture : `process` gardé tel quel, même vide ; import : un processus vide n'en est pas un.
		const keep = bounded ? process !== "" : rawProcess !== undefined;
		return { id, url, title: text(field(page, "title"), `${at}.title`, MAX_TITLE), ...(keep && { process }) };
	});

	/** `byCriterion[critère][pageId]` : critères du référentiel et pages de l'audit seulement. */
	function byCriterion<T>(path: string, parse: (v: unknown, at: string) => T) {
		const out: Record<string, Record<string, T>> = {};
		for (const [criterionId, raw] of Object.entries(object(field(root, path), path))) {
			if (!known.has(criterionId)) fail(path, `critère ${JSON.stringify(criterionId)} inexistant dans le référentiel`);
			const byPage: Record<string, T> = {};
			for (const [pageId, v] of Object.entries(object(raw, `${path}.${criterionId}`))) {
				if (!ids.has(pageId)) fail(`${path}.${criterionId}`, `page ${JSON.stringify(pageId)} absente de l’audit`);
				byPage[pageId] = parse(v, `${path}.${criterionId}.${pageId}`);
			}
			out[criterionId] = byPage;
		}
		return out;
	}

	const evaluations = byCriterion("evaluations", (v, at): Evaluation => {
		const e = object(v, at);
		const status = field(e, "status");
		if (!STATUSES.includes(status as Status)) fail(`${at}.status`, `statut inconnu ${JSON.stringify(status)}`);
		const source = v1 ? "humain" : field(e, "source");
		if (source !== "auto" && source !== "humain") fail(`${at}.source`, `source inconnue ${JSON.stringify(source)}`);
		const raw = string(field(e, "note"), `${at}.note`);
		const note = bounded ? truncate(cleanNote(raw), MAX_NOTE) : raw;
		return { status: status as Status, note, source: source as Source };
	});

	let count = 0;
	const findings = v1
		? {}
		: byCriterion("findings", (v, at) =>
				array(v, at, limit(MAX_FINDINGS)).map((raw, k): Finding => {
					const fat = `${at}[${k}]`;
					if (++count > limit(MAX_FINDINGS))
						fail(fat, `plus de ${MAX_FINDINGS.toLocaleString("fr-FR")} indices dans l’audit`);
					const f = object(raw, fat);
					const ruleId = string(field(f, "ruleId"), `${fat}.ruleId`);
					if (ruleId.length > limit(100) || !RULE_ID.test(ruleId))
						fail(`${fat}.ruleId`, "identifiant de règle mal formé");
					const kind = field(f, "kind");
					if (!RESULT_KINDS.includes(kind as ResultKind))
						fail(`${fat}.kind`, `classe inconnue ${JSON.stringify(kind)}`);
					const nodes = field(f, "nodes");
					if (!Number.isSafeInteger(nodes) || (nodes as number) < 0)
						fail(`${fat}.nodes`, "nombre entier positif attendu");
					const impact = field(f, "impact");
					if (impact !== undefined && !IMPACTS.includes(impact as string)) fail(`${fat}.impact`, "impact inconnu");
					const help = field(f, "help");
					return {
						ruleId,
						kind: kind as ResultKind,
						nodes: nodes as number,
						...(impact !== undefined && { impact: impact as string }),
						...(help !== undefined && { help: text(help, `${fat}.help`, MAX_HELP) }),
					};
				}),
			);

	// Déclaration (ADR-0017), absente avant la v3. Import : textes nettoyés et tronqués, adresse rejetée au-delà de
	// sa borne (comme une adresse de page) ; relecture : types seulement. Date et réalisation : forme vérifiée partout.
	const rawDeclaration = version === SCHEMA_VERSION ? field(root, "declaration") : undefined;
	let declaration: DeclarationFields | undefined;
	if (rawDeclaration !== undefined) {
		const d = object(rawDeclaration, "declaration");
		declaration = {};
		for (const [key, kind] of Object.entries(DECLARATION_FIELDS)) {
			const raw = field(d, key);
			if (raw === undefined) continue;
			const at = `declaration.${key}`;
			let value = string(raw, at);
			if (bounded && kind === "lines") value = truncate(cleanNote(value), MAX_DECLARATION_LINES);
			else if (bounded && kind === "text") value = truncate(stripControl(value), MAX_DECLARATION_TEXT);
			else if (bounded) value = stripControl(value);
			if (kind === "url" && value.length > limit(MAX_URL)) fail(at, `adresse de plus de ${MAX_URL} caractères`);
			if (kind === "date" && value !== "" && !isDay(value)) fail(at, "date invalide (attendu : AAAA-MM-JJ)");
			if (kind === "auditBy" && value !== "" && !(AUDIT_BY as readonly string[]).includes(value))
				fail(at, `valeur inconnue ${JSON.stringify(value)}`);
			if (value !== "" || !bounded) declaration[key as DeclarationField] = value;
		}
		if (bounded && Object.keys(declaration).length === 0) declaration = undefined;
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		site,
		createdAt,
		updatedAt,
		...(exportedAt !== undefined && { exportedAt }),
		pages,
		evaluations,
		findings,
		...(declaration !== undefined && { declaration }),
	};
}
