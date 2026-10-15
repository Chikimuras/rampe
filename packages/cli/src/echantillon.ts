// Logique pure de l'échantillon (ADR-0012) : repérage des pages types, tirage reproductible, fichier modifiable.
import { MAX_SAMPLE_URLS, parseSampleFile, quote } from "@rampe/core";
import { plural, redact, stripControl } from "./audit.ts";

export { MAX_SAMPLE_URLS, parseSampleFile };

/** Lien collecté sur la page d'accueil, tel que vu par le navigateur. */
export interface RawLink {
	/** Adresse absolue (`a.href`). */
	href: string;
	/** Nom du lien : `aria-label`, texte, `alt` d'une image ou `title`. */
	text: string;
	zone: "en-tete" | "pied-de-page" | "contenu";
	/** Lien de premier niveau de la navigation principale. */
	topNav: boolean;
}

/** Formulaire de recherche repéré sur l'accueil. `action` est nul s'il n'y a pas de formulaire (recherche en JavaScript). */
export interface RawSearch {
	reason: string;
	action: string | null;
	method: string;
	/** Nom du champ de saisie de la recherche. */
	field: string | null;
	/** Champs du formulaire avec leurs valeurs par défaut (champs cachés compris). */
	params: [string, string][];
}

export interface Collected {
	/** URL demandée par l'utilisateur. */
	requestedUrl: string;
	/** URL finale de l'accueil, après redirections. */
	homeUrl: string;
	links: RawLink[];
	/** Nom de la navigation principale (`aria-label` ou `id`), s'il y en a un. */
	navLabel: string | null;
	search: RawSearch | null;
}

export interface SampleEntry {
	url: string;
	/** Une note par raison d'être dans l'échantillon : « type — raison ». */
	notes: string[];
}

export interface Sample {
	site: string;
	seed: number;
	entries: SampleEntry[];
	/** Ce que Rampe n'a pas pu deviner : à compléter par l'humain (ADR-0012 §2). */
	todo: string[];
	/** Avertissements mis en tête du résumé et du fichier (page accessibilité absente, pages obligatoires écartées…). */
	warnings: string[];
}

/** Terme cherché pour obtenir une page de résultats (un mot présent sur presque tous les sites). */
export const SEARCH_TERM = "contact";

/** Minuscules, sans accents, apostrophes et espaces unifiés. */
export const normalizeText = (s: string): string =>
	s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();

// Fichiers qu'axe ne peut pas analyser comme des pages HTML.
const NOT_A_PAGE =
	/\.(pdf|docx?|xlsx?|pptx?|od[tsp]|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|mp3|mp4|webm|avi|mov|xml|json|csv|txt|ics|rss|atom)$/i;

// Adresses dont la simple visite déclenche une action (déconnexion, suppression, désinscription) : jamais visitées.
const ACTION = /log-?out|deconnexion|sign-?out|delete|supprimer|unsubscribe|desinscri/;

/** Adresse http(s) de même origine, sans fragment ni identifiants, ni action à la visite ; `null` sinon (ADR-0012 §4). */
export function normalizeUrl(href: string, origin: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (!/^https?:$/.test(url.protocol) || url.origin !== origin || NOT_A_PAGE.test(url.pathname)) return null;
	let path = `${url.pathname}${url.search}`;
	try {
		path = decodeURIComponent(path);
	} catch {}
	if (ACTION.test(normalizeText(path))) return null;
	url.hash = "";
	url.username = "";
	url.password = "";
	return url.href;
}

interface TypeRule {
	type: string;
	/** Intitulés reconnus (sources de regex sur le texte normalisé). */
	text: string[];
	/** Segments d'adresse reconnus, à n'importe quel niveau du chemin (sans extension). */
	slug: string[];
}

// Heuristiques essentiellement francophones, avec quelques intitulés anglais (ADR-0012, Conséquences).
// « Aide à domicile » n'est pas une page d'aide : la méthode vise l'aide à l'utilisation du site, pas une offre commerciale.
const TYPE_RULES: TypeRule[] = [
	{
		type: "contact",
		text: ["contact", "contacts", "contactez[- ]nous", "nous contacter", "formulaire de contact", "contact us"],
		slug: ["contact", "contacts", "contactez-nous", "nous-contacter", "formulaire-de-contact", "contact-us"],
	},
	{
		type: "mentions légales",
		text: ["mentions legales", "informations legales", "legal notices?", "legal", "imprint"],
		slug: ["mentions-legales", "mentionslegales", "informations-legales", "legal", "legal-notices?", "imprint"],
	},
	{
		type: "accessibilité",
		text: ["accessibilite", "declaration d'accessibilite", "accessibility", "accessibility statement"],
		slug: [
			"accessibilite",
			"declaration-(d-?)?accessibilite",
			"declaration-de-conformite",
			"accessibility",
			"accessibility-statement",
		],
	},
	{
		type: "plan du site",
		text: ["plan du site", "plan de site", "sitemap", "site map"],
		slug: ["plan-du-site", "plandusite", "plan-de-site", "sitemap", "site-map"],
	},
	{
		type: "aide",
		text: [
			"aide",
			"aide en ligne",
			"centre d'aide",
			"besoin d'aide ?\\??",
			"faq",
			"foire aux questions",
			"questions frequentes",
			"help",
			"help cent(er|re)",
		],
		slug: ["aide", "aide-en-ligne", "centre-d-?aide", "besoin-d-?aide", "faq", "foire-aux-questions", "help"],
	},
	{
		type: "authentification",
		text: [
			"connexion",
			"se connecter",
			"me connecter",
			"identification",
			"s'identifier",
			"mon compte",
			"espace client",
			"espace membre",
			"log ?in",
			"sign ?in",
			"my account",
		],
		slug: ["connexion", "se-connecter", "identification", "login", "log-in", "sign-?in", "mon-compte", "my-account"],
	},
];

// L'intitulé doit être tout le texte du lien, ou suivi d'un séparateur (« Accessibilité : partiellement conforme »,
// « Mentions légales & CGU ») : « Contactez-nous pour un devis » n'est pas un lien de contact.
const textRegex = (phrases: string[]) => new RegExp(`^(?:${phrases.join("|")})(?:$|\\s*[:&(|/,–-]|\\s+et\\s)`);
const slugRegex = (slugs: string[]) => new RegExp(`^(?:${slugs.join("|")})$`);

/** Segments du chemin, normalisés et sans extension (`/Contact/accueil.html` → `contact`, `accueil`). */
const segments = (href: string): string[] =>
	new URL(href).pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			let decoded = segment;
			try {
				decoded = decodeURIComponent(segment);
			} catch {}
			return normalizeText(decoded).replace(/\.(html?|php|aspx?|jsp)$/, "");
		});

const ZONE_LABEL = { "en-tete": "en-tête", "pied-de-page": "pied de page", contenu: null } as const;

/**
 * Repère la page d'un type parmi les liens déjà normalisés. Indices : texte reconnu (3), adresse reconnue (2),
 * en-tête ou pied de page (1). Il faut le texte ou l'adresse : la position seule ne suffit jamais.
 */
export function detectPageType(rule: TypeRule, links: RawLink[]): { url: string; reason: string } | null {
	const text = textRegex(rule.text);
	const slug = slugRegex(rule.slug);
	let best: { score: number; link: RawLink; byText: boolean; bySlug: boolean } | null = null;
	for (const link of links) {
		const byText = text.test(normalizeText(link.text));
		const bySlug = segments(link.href).some((seg) => slug.test(seg));
		if (!byText && !bySlug) continue;
		const score = (byText ? 3 : 0) + (bySlug ? 2 : 0) + (ZONE_LABEL[link.zone] ? 1 : 0);
		if (!best || score > best.score) best = { score, link, byText, bySlug };
	}
	if (!best) return null;
	const { link, byText, bySlug } = best;
	const zone = ZONE_LABEL[link.zone];
	const reason = [
		`lien ${quote(link.text || "(sans texte)")}`,
		byText && "texte reconnu",
		bySlug && `adresse ${quote(new URL(link.href).pathname)} reconnue`,
		zone && `dans ${zone === "en-tête" ? "l’en-tête" : "le pied de page"}`,
	]
		.filter(Boolean)
		.join(", ");
	return { url: link.href, reason };
}

/** URL de la page de résultats d'un formulaire GET de même origine ; `null` si elle n'est pas déterminable. */
export function searchResultsUrl(search: RawSearch, origin: string, term = SEARCH_TERM): string | null {
	if (!search.action || search.method.toLowerCase() !== "get" || !search.field) return null;
	let url: URL;
	try {
		url = new URL(search.action);
	} catch {
		return null;
	}
	// Un envoi GET remplace la requête de l'action par les champs du formulaire.
	const params = new URLSearchParams(search.params);
	params.set(search.field, term);
	url.search = params.toString();
	return normalizeUrl(url.href, origin);
}

/** Générateur pseudo-aléatoire mulberry32 : même graine, même suite (échantillon reproductible). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Tire `count` éléments distincts. Les candidats sont triés d'abord : le résultat ne dépend pas de l'ordre de la page. */
export function drawRandom(candidates: string[], count: number, seed: number): string[] {
	const pool = [...new Set(candidates)].sort();
	const random = mulberry32(seed);
	const n = Math.min(count, pool.length);
	for (let i = 0; i < n; i++) {
		const j = i + Math.floor(random() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j] as string, pool[i] as string];
	}
	return pool.slice(0, n);
}

/** Pages tirées au hasard pour qu'elles fassent au moins 10 % de l'échantillon : r ≥ n / 9, au moins 1. */
const randomShare = (n: number) => Math.max(1, Math.ceil(n / 9));

export const NOT_FOUND = "non trouvée automatiquement : à ajouter si elle existe";

/** Propose l'échantillon de la méthode RGAA (ADR-0012 §1 et §2). */
export function proposeSample(
	{ requestedUrl, homeUrl, links, navLabel, search }: Collected,
	max: number,
	seed: number,
): Sample {
	const origin = new URL(homeUrl).origin;
	const home = normalizeUrl(homeUrl, origin) ?? homeUrl;
	const warnings: string[] = [];
	if (new URL(requestedUrl).origin !== origin)
		warnings.push(
			`ATTENTION : l’accueil demandé (${redact(requestedUrl)}) redirige vers une autre origine : l’échantillon est construit sur ${origin}.`,
		);
	// Liens vers l'accueil lui-même (ancres, liens d'évitement) écartés : ils ne désignent aucune autre page.
	const valid = links.flatMap((l) => {
		const href = normalizeUrl(l.href, origin);
		return href && href !== home ? [{ ...l, href }] : [];
	});

	const entries: SampleEntry[] = [];
	const add = (url: string, note: string) => {
		const found = entries.find((e) => e.url === url);
		if (found) found.notes.push(note);
		else entries.push({ url, notes: [note] });
	};
	const todo: string[] = [];

	add(home, "accueil — page indiquée en entrée");
	for (const rule of TYPE_RULES) {
		const hit = detectPageType(rule, valid);
		if (hit) add(hit.url, `${rule.type} — ${hit.reason}`);
		else todo.push(`${rule.type} — ${NOT_FOUND}`);
	}
	if (todo.some((t) => t.startsWith("accessibilité"))) warnings.push(ACCESSIBILITY_WARNING);

	if (!search) todo.push(`recherche — ${NOT_FOUND}`);
	else {
		const url = searchResultsUrl(search, origin);
		const reason = stripControl(search.reason);
		if (url) add(url, `recherche — ${reason}, page de résultats pour « ${SEARCH_TERM} »`);
		else
			todo.push(
				`recherche — ${reason}, mais l’adresse de la page de résultats n’est pas déterminable : à ajouter à la main`,
			);
	}

	const nav = navLabel ? ` ${quote(navLabel)}` : "";
	const topNav = valid.filter((l) => l.topNav);
	if (topNav.length === 0)
		todo.push(
			"rubriques — navigation principale non trouvée automatiquement : à ajouter (une page par rubrique de premier niveau)",
		);
	for (const link of topNav)
		add(link.href, `rubrique — lien ${quote(link.text || "(sans texte)")} de la navigation principale${nav}`);

	// Limite --max : on écarte d'abord les dernières rubriques, en gardant la place du tirage au hasard.
	const dropped: SampleEntry[] = [];
	while (entries.length > 1 && entries.length + randomShare(entries.length) > max)
		dropped.unshift(entries.pop() as SampleEntry);

	// Pages obligatoires (types et recherche) écartées par --max : l'échantillon n'est plus conforme à la méthode.
	const mandatory = dropped
		.flatMap((e) => e.notes.map((n) => n.split(" — ")[0] ?? ""))
		.filter((type) => type !== "rubrique");
	if (mandatory.length > 0)
		warnings.push(
			`ATTENTION : --max ${max} a écarté des pages obligatoires. Échantillon non conforme à la méthode tant que ces pages obligatoires n’y sont pas : ${mandatory.join(", ")}.`,
		);

	// Les pages écartées par --max ne reviennent pas par le tirage au hasard.
	const taken = new Set([...entries, ...dropped].map((e) => e.url));
	const candidates = valid.map((l) => l.href).filter((h) => !taken.has(h));
	const wanted = randomShare(entries.length);
	const room = max - entries.length;
	const drawn = drawRandom(candidates, Math.min(wanted, room), seed);
	for (const url of drawn) add(url, `hasard — tirée au hasard (graine ${seed})`);
	if (drawn.length < wanted)
		todo.push(
			room < wanted
				? `tirage au hasard — --max ${max} ne laisse pas la place d’atteindre 10 % de l’échantillon : à compléter`
				: "tirage au hasard — pas assez d’autres pages de même origine sur l’accueil pour atteindre 10 % de l’échantillon : à compléter",
		);

	for (const e of dropped) todo.push(`écartée pour respecter --max : ${e.url} (${e.notes.join(" ; ")})`);
	todo.push(
		"processus — toutes les pages d’un processus (formulaire ou transaction en plusieurs étapes : commande, inscription, demande…) : à ajouter",
		"contenus particuliers — des pages au contenu sensiblement différent (tableaux, multimédia, formulaires, documents…) : à ajouter",
		"documents téléchargeables — au moins un document pertinent par type de service, le cas échéant : à évaluer à la main (Rampe n’audite que des pages web)",
	);
	return { site: home, seed, entries, todo, warnings };
}

export const RANDOM_ADVICE =
	"Tirage au hasard : si vous ajoutez des pages, ajoutez-en au hasard pour garder au moins 10 % de l’échantillon (1 pour 9).";

const ACCESSIBILITY_WARNING =
	"ATTENTION : aucune page « accessibilité » trouvée automatiquement. La déclaration d’accessibilité est une obligation légale : vérifiez qu’elle existe et ajoutez-la à l’échantillon.";

/** Fichier texte modifiable : une URL par ligne, précédée de ses raisons en commentaire (ADR-0012 §3). */
export function formatSampleFile(sample: Sample): string {
	const out = [
		`# Échantillon RGAA proposé par Rampe pour ${sample.site} (graine ${sample.seed})`,
		"# Une adresse par ligne. Les lignes vides et celles qui commencent par # sont ignorées.",
		"# Rampe propose, vous décidez : ajoutez, retirez ou remplacez des pages, puis lancez",
		"#   rampe audit --echantillon <ce fichier>",
		`# ${RANDOM_ADVICE}`,
		"",
	];
	if (sample.warnings.length > 0) out.push(...sample.warnings.map((w) => `# ${w}`), "");
	for (const e of sample.entries) out.push(...e.notes.map((n) => `# ${n}`), e.url, "");
	out.push("# À COMPLÉTER PAR VOUS :", ...sample.todo.map((t) => `#   ${t}`), "");
	return out.join("\n");
}

/** Résumé console de l'échantillon proposé. */
export function formatSampleSummary(sample: Sample, file: string): string {
	const out = [
		`Échantillon proposé pour ${sample.site} : ${plural(sample.entries.length, "page")} (graine ${sample.seed})`,
		"",
	];
	if (sample.warnings.length > 0) out.push(...sample.warnings, "");
	for (const e of sample.entries) out.push(`  ${e.url}`, ...e.notes.map((n) => `      ${n}`));
	out.push("");
	out.push("À compléter par vous :", ...sample.todo.map((t) => `  - ${t}`), "");
	out.push(
		`Fichier écrit : ${file}`,
		`Relisez-le et modifiez-le, puis lancez : rampe audit --echantillon ${file}`,
		`Même tirage au hasard : --graine ${sample.seed}`,
		RANDOM_ADVICE,
	);
	return out.join("\n");
}
