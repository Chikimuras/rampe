// Auto-évaluation de Rampe par une IA (ADR-0021 §2) : validation stricte des fragments d'évaluation
// (docs/audit-rampe/evaluations/<thématique>.json) et construction déterministe de la session versionnée
// (docs/audit-rampe/session.json, format de l'ADR-0016). Les entrées/sorties sont dans scripts/auto-evaluation.mjs.
// Validation : mêmes briques que les imports (strict.ts) — OWASP Input Validation Cheat Sheet (liste blanche du
// type, de la forme et des bornes), OWASP Deserialization Cheat Sheet (aucune confiance dans le fichier lu).
import {
	type AuditSession,
	addPage,
	cleanNote,
	createSession,
	isDay,
	MAX_NOTE,
	type Status,
	serializeSession,
	setEvaluation,
} from "./audit-session.ts";
import { baseCriteria, topics } from "./criteres.ts";
import { array, checkKeys, fail, field, object, ReportError, strictly, string } from "./strict.ts";

/** Seul évaluateur admis : le cockpit affiche la mention « réalisée par une IA (Claude), non certifiée ». */
export const AUTO_EVALUATOR = "Claude (IA)";
/** Début de l'auto-évaluation : `createdAt` de la session, et son `updatedAt` tant qu'aucun fragment n'existe. */
export const AUTO_EVALUATION_START = "2026-10-16";
export const AUTO_STATUSES: readonly Status[] = ["C", "NC", "NA"];
export const INVALID_FRAGMENT = "Fragment d’auto-évaluation refusé : rien n’a été construit.";

export interface FragmentEntry {
	criterion: string;
	page: string;
	status: Status;
	note: string;
}

export interface Fragment {
	evaluator: typeof AUTO_EVALUATOR;
	date: string;
	entries: FragmentEntry[];
}

const ROOT_KEYS = ["evaluator", "date", "entries"];
const ENTRY_KEYS = ["criterion", "page", "status", "note"];
const byId = new Map(baseCriteria.map((c) => [c.id, c]));

/** Liste blanche des clés : un champ inattendu (faute de frappe, `statut`…) est une erreur, pas un oubli silencieux. */
function onlyKeys(o: Record<string, unknown>, keys: readonly string[], path: string) {
	for (const key of Object.keys(o)) if (!keys.includes(key)) fail(path, `clé inattendue « ${key} »`);
}

/** Justification minimale : au moins une phrase qui dit ce qui a été appliqué, au-delà du seul numéro de test. */
export const MIN_NOTE = 40;

/**
 * Valide le fragment de la thématique `topic`, tel que lu sur le disque (octets). Tout ou rien : lève une
 * `ReportError` dont `detail` nomme le premier défaut. `sample` : adresses de l'échantillon (`URL.href`) ; `today` :
 * date du jour `AAAA-MM-JJ` (une date de fragment postérieure est refusée).
 * - UTF-8 strict (une séquence invalide est refusée, pas remplacée par U+FFFD) ;
 * - forme canonique : le texte est exactement `JSON.stringify(valeur, null, "\t")` suivi d'un saut de ligne. Une clé
 *   en double (dont `JSON.parse` garderait la dernière en silence), une marque d'ordre des octets ou toute autre
 *   dérive de forme est refusée ; `pnpm auto-evaluation` ne réécrit jamais un fragment.
 */
export function parseFragment(bytes: Uint8Array, topic: number, sample: readonly string[], today: string): Fragment {
	return strictly(INVALID_FRAGMENT, () => {
		let raw = "";
		let json: unknown = null;
		try {
			raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			fail("fragment", "texte qui n’est pas en UTF-8 valide");
		}
		try {
			json = JSON.parse(raw);
		} catch {
			fail("fragment", "JSON illisible");
		}
		if (raw !== `${JSON.stringify(json, null, "\t")}\n`)
			fail(
				"fragment",
				"forme non canonique (attendu : JSON indenté par tabulations, clés uniques, saut de ligne final)",
			);
		checkKeys(json, "fragment");
		const root = object(json, "fragment");
		onlyKeys(root, ROOT_KEYS, "fragment");
		if (field(root, "evaluator") !== AUTO_EVALUATOR) fail("evaluator", `« ${AUTO_EVALUATOR} » attendu`);
		const date = string(field(root, "date"), "date");
		if (!isDay(date)) fail("date", "date AAAA-MM-JJ attendue");
		if (date > today) fail("date", `date future (${date}, aujourd’hui ${today})`);
		const seen = new Set<string>();
		const max = byId.size * sample.length;
		const entries = array(field(root, "entries"), "entries", max).map((raw, i): FragmentEntry => {
			const at = `entries[${i}]`;
			const e = object(raw, at);
			onlyKeys(e, ENTRY_KEYS, at);
			const criterion = string(field(e, "criterion"), `${at}.criterion`);
			const c =
				byId.get(criterion) ??
				fail(`${at}.criterion`, `critère ${JSON.stringify(criterion)} inexistant dans le référentiel`);
			if (c.topic !== topic) fail(`${at}.criterion`, `critère ${criterion} hors de la thématique ${topic}`);
			const page = string(field(e, "page"), `${at}.page`);
			if (!sample.includes(page)) fail(`${at}.page`, `adresse ${JSON.stringify(page)} absente de l’échantillon`);
			const key = `${criterion} ${page}`;
			if (seen.has(key)) fail(at, `évaluation en double du critère ${criterion} sur ${page}`);
			seen.add(key);
			const status = field(e, "status");
			if (!AUTO_STATUSES.includes(status as Status))
				fail(`${at}.status`, `statut ${JSON.stringify(status)} inconnu (C, NC ou NA attendu)`);
			const note = string(field(e, "note"), `${at}.note`);
			if (cleanNote(note) !== note) fail(`${at}.note`, "caractères de contrôle ou de direction");
			if (note.trim().length < MIN_NOTE) fail(`${at}.note`, `justification de moins de ${MIN_NOTE} caractères`);
			if (note.length > MAX_NOTE) fail(`${at}.note`, `justification de plus de ${MAX_NOTE} caractères`);
			// La justification cite au moins un test officiel du critère (« 1.1.1 »), pas un préfixe d'un autre numéro
			// (« 1.1.10 », « 1.1.1.2 ») ; un point final de phrase reste permis. Contrôle syntaxique seulement.
			if (!c.tests.some((t) => new RegExp(`(^|[^\\d.])${t.id.replaceAll(".", "\\.")}(?!\\.?\\d)`).test(note)))
				fail(`${at}.note`, `justification qui ne cite aucun test du critère ${criterion}`);
			return { criterion, page, status: status as Status, note };
		});
		return { evaluator: AUTO_EVALUATOR, date, entries };
	});
}

/**
 * Fichiers du dossier des fragments (`readdirSync(…, { withFileTypes: true })`) : `<thématique>.json` seulement, en
 * fichier ordinaire (un lien symbolique pourrait lire hors du dépôt, un dossier serait ignoré en silence). Seul nom
 * toléré en plus, et ignoré : `.DS_Store`, que le Finder de macOS dépose dans les dossiers. Lève une `Error` claire.
 */
export function fragmentFiles(
	entries: readonly { name: string; isFile(): boolean }[],
): { name: string; topic: number }[] {
	return entries
		.filter((e) => e.name !== ".DS_Store")
		.map((e) => {
			if (!e.isFile()) throw new Error(`${e.name} : pas un fichier ordinaire (lien symbolique, dossier…) : refusé`);
			const topic = topics.find((t) => e.name === `${t.number}.json`)?.number;
			if (topic === undefined) throw new Error(`${e.name} : fichier inattendu (attendu : <thématique 1 à 13>.json)`);
			return { name: e.name, topic };
		})
		.sort((a, b) => a.topic - b.topic);
}

/**
 * Id de page stable et déterministe : UUID version 8 (RFC 9562 §5.8) tiré des 128 premiers bits du SHA-256 de
 * l'adresse (`URL.href`). Même adresse, même id, d'une exécution et d'une machine à l'autre ; il a la forme UUID
 * exigée par l'import de session (ADR-0016 §2).
 */
export async function pageIdFor(href: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(href))).slice(0, 16);
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Session de l'auto-évaluation, construite par les opérations de la session (ADR-0013) : les pages de l'échantillon
 * dans son ordre (titre : chemin de l'adresse), puis chaque évaluation dans l'ordre du référentiel et de l'échantillon,
 * quel que soit l'ordre des fragments. Dates fixes (début de l'auto-évaluation, date du fragment le plus récent) :
 * deux constructions des mêmes fragments donnent le même fichier, octet pour octet.
 */
export async function buildAutoSession(
	sample: readonly string[],
	fragments: readonly Fragment[],
): Promise<AuditSession> {
	const day = (d: string) => `${d}T00:00:00.000Z`;
	const createdAt = day(AUTO_EVALUATION_START);
	const latest = fragments
		.map((f) => f.date)
		.sort()
		.at(-1);
	const at = latest && latest > AUTO_EVALUATION_START ? day(latest) : createdAt;
	let session = createSession(createdAt);
	const ids = new Map<string, string>();
	for (const href of sample) {
		const id = await pageIdFor(href);
		ids.set(href, id);
		session = addPage(session, { url: href, title: new URL(href).pathname }, at, id);
	}
	const entries = new Map(fragments.flatMap((f) => f.entries).map((e) => [`${e.criterion} ${e.page}`, e]));
	if (entries.size !== fragments.reduce((n, f) => n + f.entries.length, 0))
		throw new ReportError(INVALID_FRAGMENT, "évaluation en double entre deux fragments");
	for (const c of baseCriteria)
		for (const href of sample) {
			const e = entries.get(`${c.id} ${href}`);
			if (e) session = setEvaluation(session, c.id, ids.get(href) as string, { status: e.status, note: e.note }, at);
		}
	return { ...session, updatedAt: at };
}

/** Fichier versionné : la session exportée (ADR-0016 §1), indentée pour des diffs lisibles. */
export const serializeAutoSession = (session: AuditSession) =>
	`${JSON.stringify(JSON.parse(serializeSession(session)), null, "\t")}\n`;
