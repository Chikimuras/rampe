// Lecture d'un fichier d'échantillon (ADR-0012 §3), partagée par la CLI et l'audit guidé du site (ADR-0013) :
// même logique des deux côtés. Code pur, sans dépendance à Node ni au référentiel.

/** N'accepte que http: et https: (ADR-0011 §6). Lève une erreur au message lisible sinon. */
export function parseAuditUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`URL invalide : « ${input} ». Exemple attendu : https://exemple.fr/`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`Seules les adresses http:// et https:// sont acceptées (reçu : ${url.protocol}).`);
	return url;
}

/** Masque identifiant et mot de passe de toute URL http(s) du texte (audits de préproduction derrière authentification). */
export const redact = (text: string): string => text.replace(/\b(https?:\/\/)[^\s/?#@]+@/gi, "$1***:***@");

/**
 * Contrôles de direction bidirectionnelle (U+202A–202E, U+2066–2069) et marques de direction (U+200E, U+200F,
 * U+061C) : un titre de page qui en contient pourrait retourner visuellement le texte de Rampe qui le suit
 * (attaque dite « Trojan Source »).
 */
export const stripBidi = (text: string): string => text.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "");

export const TRUNCATED = "… (tronqué)";
/** Tronque à `max` unités UTF-16 sans couper une paire de substitution, avec une marque visible. */
export function truncate(text: string, max: number): string {
	// Idempotente : un texte déjà tronqué (marque comprise) qui tient dans la borne n'est pas tronqué une seconde fois.
	if (text.length <= max || (text.endsWith(TRUNCATED) && text.length <= max + TRUNCATED.length)) return text;
	const cut = text.slice(0, max);
	return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}${TRUNCATED}`;
}

/** Retire les caractères de contrôle (séquences d'échappement de terminal, contrôles bidi) venus de la page auditée. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ce qu'on retire.
export const stripControl = (text: string): string => stripBidi(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");

export const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

export const quote = (text: string) => {
	const clean = stripControl(text.replace(/\s+/g, " ")).trim();
	return `« ${clean.length > 80 ? `${clean.slice(0, 79)}…` : clean} »`;
};

export const MAX_SAMPLE_URLS = 1000;
const MAX_LINE = 2048;

/** Clé de dédoublonnage et de rapprochement : adresse sans fragment ni identifiants. */
export const urlKey = (url: URL) => {
	const u = new URL(url.href);
	u.hash = "";
	u.username = "";
	u.password = "";
	return u.href;
};

/**
 * Lit un fichier d'échantillon : http(s) uniquement, même origine que la première adresse, doublons retirés.
 * Avertit si les pages notées « hasard » font moins de 10 % de l'échantillon (r ≥ n / 9).
 */
export function parseSampleFile(text: string): { urls: URL[]; warnings: string[] } {
	const urls: URL[] = [];
	const keys = new Set<string>();
	let random = 0;
	let isRandom = false;
	for (const [i, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		const where = `Échantillon, ligne ${i + 1}`;
		if (line.length > MAX_LINE)
			throw new Error(`${where} : ligne trop longue (plus de ${MAX_LINE} caractères) : ${quote(line.slice(0, 80))}`);
		if (line.startsWith("# hasard — ")) isRandom = true;
		if (line === "" || line.startsWith("#")) continue;
		let url: URL;
		try {
			url = parseAuditUrl(line);
		} catch (e) {
			throw new Error(`${where} : ${(e as Error).message}`);
		}
		const first = urls[0];
		if (first && url.origin !== first.origin)
			throw new Error(
				`${where} : ${redact(url.href)} n’est pas sur la même origine que la première adresse (${first.origin}). Un échantillon porte sur un seul site.`,
			);
		const key = urlKey(url);
		if (!keys.has(key)) {
			if (urls.length === MAX_SAMPLE_URLS)
				throw new Error(
					`${where} : plus de ${MAX_SAMPLE_URLS} adresses ; découpez l’échantillon en plusieurs fichiers.`,
				);
			keys.add(key);
			urls.push(url);
			if (isRandom) random++;
		}
		isRandom = false;
	}
	if (urls.length === 0) throw new Error("Échantillon vide : aucune adresse trouvée dans le fichier.");
	const others = urls.length - random;
	const needed = Math.ceil(others / 9);
	const warnings =
		random < needed
			? [
					`Seulement ${plural(random, "page")} notée${random > 1 ? "s" : ""} « hasard » pour ${others} autre${others > 1 ? "s" : ""} : il en faut au moins ${needed} pour que le tirage au hasard fasse 10 % de l’échantillon (méthode RGAA).`,
				]
			: [];
	return { urls, warnings };
}
