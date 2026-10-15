import { describe, expect, it } from "vitest";
import {
	type Collected,
	drawRandom,
	formatSampleFile,
	formatSampleSummary,
	mulberry32,
	normalizeText,
	normalizeUrl,
	parseSampleFile,
	proposeSample,
	type RawLink,
	type Sample,
	searchResultsUrl,
} from "../src/echantillon.ts";

const O = "https://exemple.fr";
const link = (path: string, text: string, zone: RawLink["zone"] = "contenu", topNav = false): RawLink => ({
	href: `${O}${path}`,
	text,
	zone,
	topNav,
});
const site = (links: RawLink[], extra: Partial<Collected> = {}): Collected => ({
	requestedUrl: `${O}/`,
	homeUrl: `${O}/`,
	links,
	navLabel: null,
	search: null,
	...extra,
});
/** URL retenue pour un type, d'après les notes de l'échantillon. */
const urlOf = (sample: Sample, type: string) =>
	sample.entries.find((e) => e.notes.some((n) => n.startsWith(`${type} — `)))?.url;
const noteOf = (sample: Sample, type: string) =>
	sample.entries.flatMap((e) => e.notes).find((n) => n.startsWith(`${type} — `));

describe("normalizeText", () => {
	it("retire accents, casse et espaces superflus, unifie les apostrophes", () => {
		expect(normalizeText("  Déclaration   d’Accessibilité ")).toBe("declaration d'accessibilite");
	});
});

describe("normalizeUrl", () => {
	it("garde la même origine, sans fragment ni identifiants", () => {
		expect(normalizeUrl(`${O}/a?b=1#haut`, O)).toBe(`${O}/a?b=1`);
		expect(normalizeUrl("https://alice:secret@exemple.fr/a", O)).toBe(`${O}/a`);
	});

	it.each([
		"https://autre.fr/contact",
		"http://exemple.fr/contact",
		"mailto:contact@exemple.fr",
		"tel:+33100000000",
		"javascript:void(0)",
		`${O}/doc/rapport.PDF`,
		`${O}/sitemap.xml`,
		"pas une url",
	])("écarte %s", (href) => {
		expect(normalizeUrl(href, O)).toBeNull();
	});
});

describe("repérage des pages types", () => {
	it("site français typique : chaque type avec sa raison", () => {
		const s = proposeSample(
			site([
				link("/", "Accueil", "en-tete"),
				link("/connexion", "Se connecter", "en-tete"),
				link("/contact", "Contact", "pied-de-page"),
				link("/mentions-legales.html", "Mentions légales", "pied-de-page"),
				link("/accessibilite", "Accessibilité : partiellement conforme", "pied-de-page"),
				link("/plan", "Plan du site", "pied-de-page"),
				link("/questions", "FAQ", "pied-de-page"),
			]),
			50,
			1,
		);
		expect(urlOf(s, "accueil")).toBe(`${O}/`);
		expect(urlOf(s, "contact")).toBe(`${O}/contact`);
		expect(urlOf(s, "mentions légales")).toBe(`${O}/mentions-legales.html`);
		expect(urlOf(s, "accessibilité")).toBe(`${O}/accessibilite`);
		expect(urlOf(s, "plan du site")).toBe(`${O}/plan`);
		expect(urlOf(s, "aide")).toBe(`${O}/questions`);
		expect(urlOf(s, "authentification")).toBe(`${O}/connexion`);
		expect(noteOf(s, "contact")).toBe(
			"contact — lien « Contact », texte reconnu, adresse « /contact » reconnue, dans le pied de page",
		);
		expect(noteOf(s, "plan du site")).toBe("plan du site — lien « Plan du site », texte reconnu, dans le pied de page");
		expect(s.warnings).toEqual([]);
	});

	it("site anglais : contact, legal notice, accessibility, sitemap, help, sign in", () => {
		const s = proposeSample(
			site([
				link("/en/contact-us", "Contact us", "pied-de-page"),
				link("/en/legal", "Legal notice", "pied-de-page"),
				link("/en/a11y", "Accessibility statement", "pied-de-page"),
				link("/en/map", "Sitemap", "pied-de-page"),
				link("/en/support", "Help center", "en-tete"),
				link("/en/session", "Sign in", "en-tete"),
			]),
			50,
			1,
		);
		expect(urlOf(s, "contact")).toBe(`${O}/en/contact-us`);
		expect(urlOf(s, "mentions légales")).toBe(`${O}/en/legal`);
		expect(urlOf(s, "accessibilité")).toBe(`${O}/en/a11y`);
		expect(urlOf(s, "plan du site")).toBe(`${O}/en/map`);
		expect(urlOf(s, "aide")).toBe(`${O}/en/support`);
		expect(urlOf(s, "authentification")).toBe(`${O}/en/session`);
	});

	it("« Contactez-nous pour un devis » dans un paragraphe n'est pas la page contact, le lien du pied de page l'est", () => {
		const s = proposeSample(
			site([link("/devis", "Contactez-nous pour un devis"), link("/nous-ecrire", "Contactez-nous", "pied-de-page")]),
			50,
			1,
		);
		expect(urlOf(s, "contact")).toBe(`${O}/nous-ecrire`);
		const seul = proposeSample(site([link("/devis", "Contactez-nous pour un devis")]), 50, 1);
		expect(urlOf(seul, "contact")).toBeUndefined();
		expect(seul.todo).toContain("contact — non trouvée automatiquement : à ajouter si elle existe");
	});

	it("un lien de paragraphe vers /contact reste reconnu par son adresse", () => {
		const s = proposeSample(site([link("/contact", "écrivez-nous ici")]), 50, 1);
		expect(noteOf(s, "contact")).toBe("contact — lien « écrivez-nous ici », adresse « /contact » reconnue");
	});

	it("reconnaît un segment d'adresse à tout niveau (cas réel : « Contacter Service Public » → /contact/accueil)", () => {
		const s = proposeSample(site([link("/contact/accueil", "Contacter Service Public", "en-tete", true)]), 50, 1);
		expect(noteOf(s, "contact")).toBe(
			"contact — lien « Contacter Service Public », adresse « /contact/accueil » reconnue, dans l’en-tête",
		);
	});

	it("préfère le lien le mieux indiqué (texte + adresse + pied de page)", () => {
		const s = proposeSample(site([link("/contact", "par ici"), link("/contact/", "Contact", "pied-de-page")]), 50, 1);
		expect(urlOf(s, "contact")).toBe(`${O}/contact/`);
	});

	it("« Aide à domicile » est une offre, pas une page d'aide", () => {
		const s = proposeSample(site([link("/services/aide-a-domicile", "Aide à domicile", "en-tete", true)]), 50, 1);
		expect(urlOf(s, "aide")).toBeUndefined();
		expect(s.todo).toContain("aide — non trouvée automatiquement : à ajouter si elle existe");
	});

	it("« Mentions légales & CGU » et « Besoin d'aide ? » sont reconnus", () => {
		const s = proposeSample(
			site([link("/cgu", "Mentions légales & CGU", "pied-de-page"), link("/x", "Besoin d’aide ?", "en-tete")]),
			50,
			1,
		);
		expect(urlOf(s, "mentions légales")).toBe(`${O}/cgu`);
		expect(urlOf(s, "aide")).toBe(`${O}/x`);
	});

	it("la position seule ne suffit pas, et un lien d'une autre origine est ignoré", () => {
		const s = proposeSample(
			site([
				link("/qui", "Qui sommes-nous", "pied-de-page"),
				{ href: "https://autre.fr/contact", text: "Contact", zone: "pied-de-page", topNav: false },
			]),
			50,
			1,
		);
		expect(urlOf(s, "contact")).toBeUndefined();
	});

	it("met en avant l'absence de page accessibilité", () => {
		const s = proposeSample(site([]), 50, 1);
		expect(s.warnings[0]).toMatch(/^ATTENTION : aucune page « accessibilité »/);
		expect(formatSampleSummary(s, "e.txt")).toMatch(/ATTENTION : aucune page « accessibilité »/);
		expect(formatSampleFile(s)).toMatch(/# ATTENTION : aucune page « accessibilité »/);
	});

	it("liste toujours processus et contenus particuliers comme à compléter", () => {
		const s = proposeSample(site([]), 50, 1);
		expect(s.todo.some((t) => t.startsWith("processus — "))).toBe(true);
		expect(s.todo.some((t) => t.startsWith("contenus particuliers — "))).toBe(true);
		expect(s.todo.some((t) => t.startsWith("documents téléchargeables — "))).toBe(true);
	});
});

describe("recherche", () => {
	const form = { reason: 'formulaire dans une zone role="search"', method: "get", field: "q" };

	it("construit l'adresse de la page de résultats d'un formulaire GET", () => {
		expect(
			searchResultsUrl(
				{
					...form,
					action: `${O}/recherche?ancien=1`,
					params: [
						["q", ""],
						["lang", "fr"],
					],
				},
				O,
			),
		).toBe(`${O}/recherche?q=contact&lang=fr`);
	});

	it.each([
		["POST", { ...form, method: "post", action: `${O}/recherche`, params: [] }],
		["sans formulaire", { ...form, action: null, params: [] }],
		["sans champ", { ...form, field: null, action: `${O}/recherche`, params: [] }],
		["autre origine", { ...form, action: "https://moteur.fr/s", params: [] }],
	] as const)("non déterminable : %s", (_, search) => {
		expect(searchResultsUrl({ ...search, params: [...search.params] }, O)).toBeNull();
		const s = proposeSample(site([], { search: { ...search, params: [...search.params] } }), 50, 1);
		expect(s.todo.find((t) => t.startsWith("recherche — "))).toMatch(/pas déterminable : à ajouter à la main/);
	});

	it("ajoute la page de résultats à l'échantillon, ou signale l'absence de recherche", () => {
		const s = proposeSample(site([], { search: { ...form, action: `${O}/recherche`, params: [["q", ""]] } }), 50, 1);
		expect(noteOf(s, "recherche")).toBe(
			'recherche — formulaire dans une zone role="search", page de résultats pour « contact »',
		);
		expect(urlOf(s, "recherche")).toBe(`${O}/recherche?q=contact`);
		expect(proposeSample(site([]), 50, 1).todo).toContain(
			"recherche — non trouvée automatiquement : à ajouter si elle existe",
		);
	});
});

describe("rubriques et tirage au hasard", () => {
	const many = Array.from({ length: 30 }, (_, i) => link(`/article-${i}`, `Article ${i}`));
	const nav = ["Services", "Réalisations", "Blog", "À propos"].map((t, i) =>
		link(`/rubrique-${i}`, t, "en-tete", true),
	);

	it("prend les liens de premier niveau de la navigation principale", () => {
		const s = proposeSample(
			site([...nav, link("/rubrique-0/sous", "Sous-page", "en-tete")], { navLabel: "Menu principal" }),
			50,
			1,
		);
		const rubriques = s.entries.filter((e) => e.notes.some((n) => n.startsWith("rubrique — ")));
		expect(rubriques.map((e) => e.url)).toEqual(nav.map((l) => l.href));
		expect(rubriques[0]?.notes[0]).toBe("rubrique — lien « Services » de la navigation principale « Menu principal »");
	});

	it("tire au moins 10 % de l'échantillon, au moins une page, parmi les autres liens", () => {
		const s = proposeSample(site([...nav, ...many]), 50, 42);
		const random = s.entries.filter((e) => e.notes.some((n) => n.startsWith("hasard — ")));
		expect(random.length).toBeGreaterThanOrEqual(1);
		expect(random.length / s.entries.length).toBeGreaterThanOrEqual(0.1);
		expect(random.every((e) => e.url.includes("/article-"))).toBe(true);
		expect(random[0]?.notes[0]).toBe("hasard — tirée au hasard (graine 42)");
	});

	it("est reproductible avec la même graine, et change avec une autre", () => {
		const a = proposeSample(site([...nav, ...many]), 50, 42);
		const b = proposeSample(site([...nav, ...[...many].reverse()]), 50, 42);
		expect(b.entries).toEqual(a.entries);
		const draws = new Set(
			[1, 2, 3, 4, 5].map((g) =>
				drawRandom(
					many.map((l) => l.href),
					3,
					g,
				).join(),
			),
		);
		expect(draws.size).toBeGreaterThan(1);
	});

	it("signale quand il ne reste aucune page à tirer", () => {
		const s = proposeSample(site(nav), 50, 1);
		expect(s.todo.some((t) => t.startsWith("tirage au hasard — "))).toBe(true);
	});

	it("respecte --max en gardant l'accueil et la part du hasard", () => {
		const big = Array.from({ length: 80 }, (_, i) => link(`/r${i}`, `R${i}`, "en-tete", true));
		const s = proposeSample(site([...big, ...many]), 20, 7);
		expect(s.entries).toHaveLength(20);
		expect(s.entries[0]?.url).toBe(`${O}/`);
		const random = s.entries.filter((e) => e.notes.some((n) => n.startsWith("hasard — ")));
		expect(random.length / s.entries.length).toBeGreaterThanOrEqual(0.1);
		expect(s.todo).toContain(
			`écartée pour respecter --max : ${O}/r79 (rubrique — lien « R79 » de la navigation principale)`,
		);
	});
});

describe("mulberry32 et drawRandom", () => {
	it("donne la même suite pour la même graine, dans [0, 1[", () => {
		const a = mulberry32(123);
		const b = mulberry32(123);
		const xs = Array.from({ length: 5 }, () => a());
		expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
		expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
		// Valeur figée : un changement d'algorithme casserait les graines déjà publiées dans des fichiers.
		expect(mulberry32(42)()).toBeCloseTo(0.6011037519201636, 12);
	});

	it("tire sans doublon et jamais plus que disponible", () => {
		expect(drawRandom(["a", "b", "a"], 5, 1).sort()).toEqual(["a", "b"]);
	});
});

describe("fichier d'échantillon", () => {
	const s = proposeSample(
		site([link("/contact", "Contact\u001b[2J\nhttps://pirate.fr/", "pied-de-page"), link("/x", "X")]),
		50,
		9,
	);
	const text = formatSampleFile(s);

	it("une URL par ligne, raisons en commentaire, graine et à compléter en en-tête et en pied", () => {
		expect(text).toMatch(/^# Échantillon RGAA proposé par Rampe pour https:\/\/exemple\.fr\/ \(graine 9\)/);
		expect(text).toMatch(/# accueil — page indiquée en entrée\nhttps:\/\/exemple\.fr\/\n/);
		expect(text).toMatch(/# À COMPLÉTER PAR VOUS :\n(# {3}.*\n)*# {3}accessibilité — non trouvée automatiquement/);
	});

	it("ne laisse aucun texte de la page injecter une ligne ou un caractère de contrôle", () => {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: on vérifie leur absence.
		expect(text.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(parseSampleFile(text).urls.map((u) => u.href)).toEqual(s.entries.map((e) => e.url));
	});

	it("relit le fichier : ignore commentaires et lignes vides, retire les doublons", () => {
		expect(parseSampleFile(`# x\n\n  ${O}/a  \r\n${O}/b\n${O}/a\n`).urls.map((u) => u.href)).toEqual([
			`${O}/a`,
			`${O}/b`,
		]);
	});

	it.each([
		[`${O}/a\nhttps://autre.fr/b`, /ligne 2 : https:\/\/autre\.fr\/b n’est pas sur la même origine/],
		[`${O}/a\nfile:///etc/passwd`, /ligne 2 : Seules les adresses http/],
		["# rien\n", /Échantillon vide/],
		["exemple.fr", /ligne 1 : URL invalide/],
	])("refuse clairement %j", (input, message) => {
		expect(() => parseSampleFile(input)).toThrow(message);
	});

	it("masque les identifiants dans les erreurs", () => {
		expect(() => parseSampleFile(`${O}/a\nhttps://alice:secret@autre.fr/`)).toThrow(/\*\*\*:\*\*\*@autre\.fr/);
	});
});

describe("corrections de relecture", () => {
	const nav = ["Services", "Réalisations", "Blog", "À propos"].map((t, i) =>
		link(`/rubrique-${i}`, t, "en-tete", true),
	);
	const many = Array.from({ length: 30 }, (_, i) => link(`/article-${i}`, `Article ${i}`));

	it("3. ignore les liens vers l'accueil lui-même (ancres, évitement) pour les types et les rubriques", () => {
		const s = proposeSample(
			site([link("/#contact", "Contact", "en-tete", true), link("/#contenu", "Aller au contenu", "en-tete", true)]),
			50,
			1,
		);
		expect(s.entries[0]?.notes).toEqual(["accueil — page indiquée en entrée"]);
		expect(urlOf(s, "contact")).toBeUndefined();
	});

	it("4. une page écartée par --max ne revient pas par le tirage au hasard", () => {
		const big = Array.from({ length: 30 }, (_, i) => link(`/r${i}`, `R${i}`, "en-tete", true));
		for (const seed of [1, 2, 3, 4, 5]) {
			const s = proposeSample(site(big), 10, seed);
			const random = s.entries.filter((e) => e.notes.some((n) => n.startsWith("hasard — ")));
			expect(random).toEqual([]);
			expect(s.todo).toContain(
				"tirage au hasard — pas assez d’autres pages de même origine sur l’accueil pour atteindre 10 % de l’échantillon : à compléter",
			);
		}
	});

	it("5. avertit en tête quand --max écarte des pages obligatoires (types, recherche)", () => {
		const s = proposeSample(
			site(
				[
					link("/contact", "Contact", "pied-de-page"),
					link("/mentions-legales", "Mentions légales", "pied-de-page"),
					link("/accessibilite", "Accessibilité", "pied-de-page"),
					...many,
				],
				{ search: { reason: "r", action: `${O}/recherche`, method: "get", field: "q", params: [] } },
			),
			3,
			1,
		);
		const warning =
			"ATTENTION : --max 3 a écarté des pages obligatoires. Échantillon non conforme à la méthode tant que ces pages obligatoires n’y sont pas : mentions légales, accessibilité, recherche.";
		expect(s.warnings).toContain(warning);
		expect(formatSampleFile(s)).toContain(`# ${warning}`);
		expect(formatSampleSummary(s, "e.txt")).toMatch(/^Échantillon proposé .*\n\nATTENTION : --max 3/);
		// Rubriques seules écartées : pas d'avertissement.
		expect(proposeSample(site([...nav, ...many]), 3, 1).warnings.some((w) => w.includes("--max"))).toBe(false);
	});

	it("6. conseille le tirage au hasard dans le fichier, et avertit à la relecture si moins de 10 %", () => {
		const s = proposeSample(site([...nav, ...many]), 50, 1);
		expect(formatSampleFile(s)).toContain(
			"# Tirage au hasard : si vous ajoutez des pages, ajoutez-en au hasard pour garder au moins 10 % de l’échantillon (1 pour 9).",
		);
		expect(parseSampleFile(formatSampleFile(s)).warnings).toEqual([]);
		const ten = Array.from({ length: 10 }, (_, i) => `${O}/p${i}`).join("\n");
		expect(parseSampleFile(`${ten}\n# hasard — tirée au hasard (graine 1)\n${O}/h\n`).warnings).toEqual([
			"Seulement 1 page notée « hasard » pour 10 autres : il en faut au moins 2 pour que le tirage au hasard fasse 10 % de l’échantillon (méthode RGAA).",
		]);
		expect(parseSampleFile(`${O}/a\n# hasard — x\n${O}/h\n`).warnings).toEqual([]);
		expect(parseSampleFile(`${O}/a\n`).warnings[0]).toMatch(/^Seulement 0 page notée « hasard » pour 1 autre :/);
	});

	it("7. sans navigation principale, les rubriques sont à compléter", () => {
		expect(proposeSample(site(many), 50, 1).todo).toContain(
			"rubriques — navigation principale non trouvée automatiquement : à ajouter (une page par rubrique de premier niveau)",
		);
		expect(proposeSample(site(nav), 50, 1).todo.some((t) => t.startsWith("rubriques — "))).toBe(false);
	});

	it("exclut les adresses qui déclenchent une action à la visite", () => {
		for (const path of [
			"/logout",
			"/compte/déconnexion",
			"/sign-out",
			"/panier/delete?id=1",
			"/supprimer",
			"/unsubscribe",
			"/desinscription",
		])
			expect(normalizeUrl(`${O}${path}`, O), path).toBeNull();
		const s = proposeSample(site([link("/deconnexion", "Se déconnecter", "en-tete"), ...nav]), 50, 1);
		expect(s.entries.some((e) => e.url.includes("deconnexion"))).toBe(false);
	});

	it("avertit, dans le fichier aussi, quand l'accueil redirige vers une autre origine", () => {
		const s = proposeSample(site(nav, { requestedUrl: "https://alice:secret@ancien.fr/", homeUrl: `${O}/` }), 50, 1);
		const warning =
			"ATTENTION : l’accueil demandé (https://***:***@ancien.fr/) redirige vers une autre origine : l’échantillon est construit sur https://exemple.fr.";
		expect(s.warnings).toContain(warning);
		expect(formatSampleFile(s)).toContain(`# ${warning}`);
	});

	it("relecture : plafonds de longueur de ligne et de nombre d'adresses, dédoublonnage normalisé", () => {
		expect(() => parseSampleFile(`${O}/a\n${O}/${"x".repeat(3000)}`)).toThrow(
			/^Échantillon, ligne 2 : ligne trop longue \(plus de 2048 caractères\) : « https:\/\/exemple\.fr\/x+ »$/,
		);
		const many = Array.from({ length: 1001 }, (_, i) => `${O}/p${i}`).join("\n");
		expect(() => parseSampleFile(many)).toThrow(/ligne 1001 : plus de 1000 adresses/);
		expect(parseSampleFile(`${O}/a#x\nhttps://u:p@exemple.fr/a\n${O}/a`).urls).toHaveLength(1);
	});

	it("accorde « 1 page »", () => {
		const s = proposeSample(site([]), 50, 1);
		expect(formatSampleSummary(s, "e.txt")).toMatch(/: 1 page \(graine 1\)/);
	});
});
