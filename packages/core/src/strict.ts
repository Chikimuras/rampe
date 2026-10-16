// Validation stricte à la frontière, partagée par l'import du rapport de la CLI (ADR-0014 §4) et celui d'une session
// (ADR-0016 §2). OWASP Input Validation Cheat Sheet : liste blanche du type, de la forme et des bornes ;
// OWASP Deserialization Cheat Sheet : ne jamais faire confiance à une structure désérialisée.
import { stripControl, truncate } from "./sample-file.ts";

/** Refus d'import : `message` est une phrase claire pour un non-expert, `detail` le premier défaut technique. */
export class ReportError extends Error {
	// Pas de propriété de paramètre : la CLI exécute ce fichier par simple suppression des types (Node ≥ 22.18).
	readonly detail?: string;
	constructor(message: string, detail?: string) {
		super(message);
		this.detail = detail;
	}
}

/** Premier défaut trouvé ; `strictly` le transforme en `ReportError` avec la phrase claire de l'appelant. */
class Defect extends Error {}

/** Exécute `parse` ; un défaut devient une `ReportError(message, détail)`. Les autres erreurs passent telles quelles. */
export function strictly<T>(message: string, parse: () => T): T {
	try {
		return parse();
	} catch (e) {
		if (e instanceof Defect) throw new ReportError(message, e.message);
		throw e;
	}
}

// Détail borné : jamais de texte importé non borné dans un message.
export const fail = (path: string, problem: string): never => {
	throw new Defect(`${path} : ${problem}.`.slice(0, 500));
};

export const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// Bornes communes aux deux imports (ADR-0014 §4, ADR-0016 §2).
/** Taille maximale d'un fichier importé, vérifiée par l'appelant AVANT lecture. */
export const MAX_REPORT_BYTES = 20 * 1024 * 1024;
/**
 * Taille maximale d'un audit importé : ce que l'export peut produire aux bornes (50 000 indices aux descriptions
 * tronquées à 311 caractères, CJK compris, soit environ 3 octets par caractère : près de 50 Mo), avec de la marge.
 */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_PAGES = 1000;
/** Total d'indices : au-delà, l'audit ne tiendrait plus dans le stockage du navigateur. */
export const MAX_FINDINGS = 50_000;
export const MAX_URL = 2048;
export const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IMPACTS = ["minor", "moderate", "serious", "critical"];
/**
 * `tool.name` admis dans un rapport automatique : nom du paquet qui l'a écrit, la CLI (ADR-0011) ou l'extension
 * navigateur (ADR-0019). Liste fermée (ADR-0014 §4).
 */
export const REPORT_TOOL_NAMES = ["@rampe/cli", "@rampe/extension"] as const;
export type ReportToolName = (typeof REPORT_TOOL_NAMES)[number];
export const isReportToolName = (name: unknown): name is ReportToolName =>
	(REPORT_TOOL_NAMES as readonly unknown[]).includes(name);
/** `tool.name` écrit par l'export de l'audit guidé (ADR-0016 §1). */
export const SESSION_TOOL_NAME = "@rampe/site";

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

/** Refuse les clés dangereuses partout dans le fichier, et une imbrication anormale (pile bornée). */
export function checkKeys(value: unknown, path: string, depth = 0): void {
	if (typeof value !== "object" || value === null) return;
	if (depth > MAX_DEPTH) fail(path, "structure trop profonde");
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_KEYS.includes(key)) fail(path, `clé interdite « ${key} »`);
		checkKeys((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
	}
}

export const field = (o: Record<string, unknown>, key: string) => (Object.hasOwn(o, key) ? o[key] : undefined);
export const object = (v: unknown, path: string) => (isObject(v) ? v : fail(path, "objet attendu"));
export const array = (v: unknown, path: string, max: number) => {
	if (!Array.isArray(v)) return fail(path, "liste attendue");
	return v.length > max ? fail(path, `plus de ${max} éléments`) : v;
};
export const string = (v: unknown, path: string) => (typeof v === "string" ? v : fail(path, "texte attendu"));
/** Texte affiché : nettoyé puis tronqué, jamais rejeté pour sa longueur. */
export const display = (v: unknown, path: string, max: number) => truncate(stripControl(string(v, path)).trim(), max);
export const displayOrNull = (v: unknown, path: string, max: number) => (v === null ? null : display(v, path, max));

/** `tool.name` s'il est lisible, pour reconnaître un fichier donné au mauvais champ. */
export const toolName = (root: Record<string, unknown>) => {
	const tool = field(root, "tool");
	return isObject(tool) ? field(tool, "name") : undefined;
};
