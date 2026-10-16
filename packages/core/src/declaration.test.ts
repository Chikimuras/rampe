import { describe, expect, it } from "vitest";
import official from "../test/fixtures/declaration-format-officiel.json" with { type: "json" };
import {
	type AuditSession,
	addPage,
	createSession,
	type DeclarationFields,
	type Status,
	setEvaluatedBy,
	setEvaluation,
	takeOverAudit,
} from "./audit-session.ts";
import { type Conformity, computeConformity } from "./conformity.ts";
import {
	conformityState,
	declarationBlocks,
	declarationFileName,
	NON_CONFORMITY_REASONS,
	renderDeclaration,
	safeUrl,
} from "./declaration.ts";
import { rgaa } from "./rgaa.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const DATE = new Date(2026, 9, 15, 12);
const [P1, P2, P3] = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string];
const ALL = rgaa.criteria.map((c) => c.id);
// Titres en texte brut : les liens Markdown du référentiel (vers le glossaire) gardent leur texte seulement.
const TITLES = Object.fromEntries(rgaa.criteria.map((c) => [c.id, c.title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")]));
const OPTIONS = { date: DATE, rgaaVersion: rgaa.version, criterionTitles: TITLES };
const PCT = " %";

/** Échantillon de 3 pages, tout NA sauf `statuses` (exemple chiffré de conformity.test.ts et de l'e2e). */
function audit(statuses: Record<string, [Status, Status, Status]> = {}, fill: Status = "NA"): AuditSession {
	let s = createSession(NOW);
	s = addPage(s, { url: "https://exemple.fr/", title: "Accueil" }, NOW, P1);
	s = addPage(s, { url: "https://exemple.fr/panier", title: "Panier" }, NOW, P2);
	s = addPage(s, { url: "https://exemple.fr/paiement", title: "Paiement" }, NOW, P3);
	for (const c of ALL) {
		const row = statuses[c] ?? [fill, fill, fill];
		for (const [i, p] of [P1, P2, P3].entries()) s = setEvaluation(s, c, p, { status: row[i] }, NOW);
	}
	return s;
}
const EXAMPLE = { "1.1": ["C", "C", "NC"], "3.2": ["C", "C", "C"], "8.3": ["NC", "NA", "C"] } as const satisfies Record<
	string,
	[Status, Status, Status]
>;

const render = (
	s: AuditSession,
	fields: DeclarationFields = s.declaration ?? {},
	format: "html" | "markdown" = "markdown",
) => renderDeclaration(s, computeConformity(s, ALL), fields, { ...OPTIONS, format });

/** Conformité complète fabriquée : seuls `validated` et `applicable` comptent pour l'état. */
const complete = (validated: number, applicable: number): Conformity => ({
	complete: true,
	pages: [],
	criteria: [],
	validated,
	invalidated: applicable - validated,
	notApplicable: 0,
	applicable,
	globalRate: null,
	averageRate: null,
});

describe("conformityState : règle officielle, décidée sur les entiers exacts", () => {
	it.each([
		["tous les critères respectés", 106, 106, "totalement"],
		["un seul critère, respecté", 1, 1, "totalement"],
		["exactement la moitié (1/2)", 1, 2, "partiellement"],
		["exactement la moitié (53/106)", 53, 106, "partiellement"],
		["juste au-dessus de la moitié (2/3)", 2, 3, "partiellement"],
		["un de moins que tous (105/106)", 105, 106, "partiellement"],
		["juste sous la moitié (52/106 = 49,05 %)", 52, 106, "non"],
		["juste sous la moitié (1/3)", 1, 3, "non"],
		["aucun respecté (0/1)", 0, 1, "non"],
		// 49,996 % : l'arrondi à deux décimales donnerait 50,00 % ; la règle porte sur la valeur exacte.
		["49,996 % (12 499/25 000), jamais arrondi à 50 %", 12_499, 25_000, "non"],
		["50 % exactement sur un grand nombre (12 500/25 000)", 12_500, 25_000, "partiellement"],
		["un de plus que la moitié d'un impair (54/107)", 54, 107, "partiellement"],
		["un de moins que la moitié d'un impair (53/107)", 53, 107, "non"],
	])("%s → %s", (_, v, a, expected) => {
		expect(conformityState(complete(v, a)).state).toBe(expected);
	});

	it("moins de 50 % : motif « moins de 50 % »", () => {
		expect(conformityState(complete(0, 1))).toEqual({ state: "non", reason: "below-half" });
	});

	it("aucun critère applicable : « non », motif dédié (rien n'a pu être mesuré, pas de « totalement » à vide)", () => {
		expect(conformityState(complete(0, 0))).toEqual({ state: "non", reason: "no-applicable" });
		expect(conformityState(computeConformity(audit(), ALL))).toEqual({ state: "non", reason: "no-applicable" });
	});

	it("audit incomplet : toujours « non », quels que soient les statuts déjà saisis", () => {
		expect(conformityState({ complete: false, remaining: 1, toConfirm: 0 })).toEqual({
			state: "non",
			reason: "incomplete",
		});
		// Tout conforme sauf une évaluation non testée, ou un statut automatique à confirmer.
		const allC = audit({}, "C");
		const missing = setEvaluation(allC, "13.12", P3, { status: "NT" }, NOW);
		expect(conformityState(computeConformity(missing, ALL)).state).toBe("non");
		const auto = setEvaluation(allC, "13.12", P3, { status: "C", source: "auto" }, NOW);
		expect(conformityState(computeConformity(auto, ALL)).state).toBe("non");
		expect(conformityState(computeConformity(createSession(NOW), ALL)).state).toBe("non");
		expect(conformityState(computeConformity(allC, ALL)).state).toBe("totalement");
	});

	it("aléatoire : un audit incomplet ne produit jamais « totalement » ni « partiellement », dans aucun format", () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed % n;
		};
		const statuses: Status[] = ["C", "C", "C", "NC", "NA"];
		for (let run = 0; run < 30; run++) {
			let s = audit({}, "C");
			for (let k = 0; k < 20; k++)
				s = setEvaluation(s, ALL[rand(ALL.length)] as string, [P1, P2, P3][rand(3)] as string, {
					status: statuses[rand(statuses.length)],
				});
			// Une seule évaluation manquante suffit.
			s = setEvaluation(s, ALL[rand(ALL.length)] as string, P2, { status: "NT" }, NOW);
			for (const format of ["html", "markdown"] as const) {
				const out = render(s, {}, format);
				expect(out).not.toMatch(/totalement conforme|partiellement conforme/);
				expect(out).toContain("non conforme avec");
				expect(out).not.toContain(PCT);
			}
		}
	});
});

// Copie brute de la section « La déclaration d'accessibilité adopte obligatoirement ce format », avec son commit
// DINUM (le même que celui noté dans declaration.ts). Ce qui n'est pas entre crochets est imposé : chaque segment doit figurer, dans l'ordre.
const OFFICIAL = official.text;
/** Espaces ASCII réduits ; les espaces insécables du gabarit (« que\u00a0: ») comptent, eux. */
const norm = (s: string) => s.replace(/[ \t\r\n]+/g, " ").trim();
const SEGMENTS = OFFICIAL.split(/\[[^\]]*\]/)
	.map(norm)
	.filter(Boolean);
const PLACEHOLDERS = [...OFFICIAL.matchAll(/\[[^\]]*\]/g)].map((m) => m[0]);
/** Texte d'un HTML produit par nous : balises retirées, entités décodées. */
const htmlText = (html: string) =>
	html
		.replace(/<\/?a\b[^>]*>/g, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
/** Segment imposé sans sa syntaxe Markdown (titres, puces, <br>), pour le comparer au texte du HTML. */
const plain = (segment: string) => norm(segment.replace(/<br>/g, " ").replace(/(^|\s)(#{1,6}|-)(?=\s|$)/g, " "));

function expectInOrder(haystack: string, needles: string[]) {
	let from = 0;
	for (const needle of needles) {
		if (!needle) continue;
		const at = haystack.indexOf(needle, from);
		expect(at, `phrase imposée absente ou déplacée : « ${needle} »`).toBeGreaterThanOrEqual(0);
		from = at + needle.length;
	}
}

const FULL_FIELDS: DeclarationFields = {
	organization: "Boulangerie Dupont",
	commitment: "son site internet",
	schemeUrl: "https://exemple.fr/schema",
	actionPlanUrl: "https://exemple.fr/plan",
	serviceName: "exemple.fr",
	auditBy: "prestataire",
	auditCompany: "Acces SARL",
	reportUrl: "https://exemple.fr/grille.ods",
	nonConformities: "La vidéo n’a pas de transcription ; contactez-nous.",
	derogations: "Archives PDF avant 2010",
	exemptions: "Cartes interactives\nVidéos en direct",
	establishedOn: "2026-10-01",
	updatedOn: "2026-10-14",
	technologies: "HTML5\nCSS\nJavaScript",
	testEnvironment: "Firefox et NVDA\nSafari et VoiceOver",
	tools: "Rampe\nColour Contrast Analyser",
	contactFormUrl: "https://exemple.fr/contact",
	contactEntity: "Service client",
	contactPageUrl: "contact@exemple.fr",
};

describe("fidélité au gabarit officiel", () => {
	it("la copie du gabarit est bien la section officielle (garde-fou sur la fixture)", () => {
		expect(official.commit).toBe("ca4019f95073b6cbd2482a16e9f12b52d8de678d");
		expect(OFFICIAL.startsWith("[Nom de l’organisme concerné] s’engage à rendre")).toBe(true);
		expect(OFFICIAL.trimEnd().endsWith("75342 Paris CEDEX 07")).toBe(true);
		expect(SEGMENTS.length).toBeGreaterThan(20);
		expect(PLACEHOLDERS).toHaveLength(26);
	});

	const cases: [string, AuditSession, DeclarationFields][] = [
		["audit complet, champs remplis", audit(EXAMPLE), FULL_FIELDS],
		["audit complet, champs vides", audit(EXAMPLE), {}],
		["audit incomplet, champs vides", createSession(NOW), {}],
		["tout conforme, champs remplis", audit({}, "C"), FULL_FIELDS],
	];
	for (const [name, session, fields] of cases) {
		it(`Markdown : chaque phrase imposée, mot pour mot et dans l'ordre (${name})`, () => {
			expectInOrder(norm(render(session, fields, "markdown")), SEGMENTS);
		});
		it(`HTML : chaque phrase imposée, mot pour mot et dans l'ordre (${name})`, () => {
			expectInOrder(norm(htmlText(render(session, fields, "html"))), SEGMENTS.map(plain));
		});
	}

	it("même structure de titres que le gabarit (##, ###), sous un titre « Déclaration d’accessibilité »", () => {
		const headings = (md: string) => md.split("\n").filter((l) => /^#{1,6} /.test(l));
		const official = headings(OFFICIAL).map((h) => h.replace(/\[[^\]]*\]/, "…"));
		expect(headings(render(audit(EXAMPLE), FULL_FIELDS)).map((h) => h.replace(/du site web$/, "…"))).toEqual([
			"# Déclaration d’accessibilité",
			...official,
		]);
	});
});

/**
 * Test « golden » : la sortie Markdown est le texte officiel lui-même, après une liste FERMÉE de remplacements. Tout
 * ajout, retrait ou reformulation hors de cette liste le fait échouer (la fidélité segment par segment, plus haut, ne
 * voit pas un ajout).
 *
 * Seule normalisation des blancs, documentée : une tabulation en début de ligne du gabarit (adresse postale) est
 * écrite comme deux espaces, l'indentation des autres lignes de cet élément de liste. Le titre de la page officielle
 * est ajouté en tête (h1) : le gabarit n'en a pas.
 */
function golden(replacements: [placeholder: string, value: string][]): string {
	let expected = `# Déclaration d’accessibilité\n\n${OFFICIAL.replace(/^\t/gm, "  ")}`;
	for (const [from, to] of replacements) {
		const at = expected.indexOf(from);
		expect(at, `remplacement introuvable : ${from}`).toBeGreaterThanOrEqual(0);
		expected = expected.slice(0, at) + to + expected.slice(at + from.length);
	}
	return expected;
}
const STATE_SLOT =
	"[totalement / partiellement / non] conforme avec [pour les sites : le référentiel général d’amélioration de l’accessibilité / autre protocole de test utilisé ; pour les autres services de communication : protocole de test utilisé]";
const REFERENTIAL = "le référentiel général d’amélioration de l’accessibilité (RGAA), version 4.1.2";
const SITE_CHOICES: [string, string][] = [
	["[Du site web / De l’application mobile / Du service…]", "du site web"],
	["[site internet / application mobile / Autre service]", "site internet"],
];

describe("golden : le texte officiel, à une liste fermée de remplacements près", () => {
	it("champs vides, audit incomplet (sans page)", () => {
		const md = render(createSession(NOW), {});
		expect(md).toBe(
			golden([
				[STATE_SLOT, `non conforme avec ${REFERENTIAL}`],
				[
					"[Détailler ici les résultats des tests ou insérer un lien vers le rapport de test]",
					NON_CONFORMITY_REASONS.incomplete,
				],
				["établie le [JJ mois AAAA]", "établie le 15 octobre 2026"],
				...SITE_CHOICES,
			]),
		);
	});

	it("audit complet, tous les champs remplis", () => {
		const md = render(audit(EXAMPLE), FULL_FIELDS);
		const NB = " ";
		expect(md).toBe(
			golden([
				["[Nom de l’organisme concerné]", "Boulangerie Dupont"],
				[
					"[son (ses) site(s) internet, intranet, extranet et son (ses) application(s) mobile(s), etc.]",
					"son site internet",
				],
				[
					"[liens vers le schéma pluriannuel et vers le plan d’action de l’année en cours incluant le bilan des actions réalisées l’année précédente]",
					"[schéma pluriannuel](https://exemple.fr/schema) et [plan d’action de l’année en cours](https://exemple.fr/plan)",
				],
				[
					"[Nom du site web de l’application mobile, ou d’un autre service auquel la déclaration s’applique]",
					"exemple\\.fr",
				],
				["[Nom du site web, de l’application mobile, ou d’un autre service concerné]", "exemple\\.fr"],
				[STATE_SLOT, `non conforme avec ${REFERENTIAL}`],
				["[en interne / par la société NNN]", "par la société Acces SARL"],
				["[pourcentage de critères RGAA respectés]", `33,33 %`],
				[
					"[Facultatif] Le taux moyen de conformité du service en ligne s’élève à [taux moyen de conformité du service en ligne]",
					`Le taux moyen de conformité du service en ligne s’élève à 77,77 %`,
				],
				[
					"[Détailler ici les résultats des tests ou insérer un lien vers le rapport de test]",
					"[https\\:\\/\\/exemple\\.fr\\/grille\\.ods](https://exemple.fr/grille.ods)",
				],
				[
					"- [Lister la/les non-conformité(s) du/de la/des site(s) internet/application(s) mobile(s) et/ou décrire quels section(s)/contenu(s)/fonction(s) ne sont pas encore conformes, indiquer les alternatives s’il y a lieu].",
					[
						`- Critère 1.1${NB}: ${TITLES["1.1"]?.replace(/[-?]/g, "\\$&")} Page concernée${NB}: Paiement.`,
						`- Critère 8.3${NB}: ${TITLES["8.3"]?.replace(/[-?,]/g, "\\$&")} Page concernée${NB}: Accueil.`,
						"- La vidéo n’a pas de transcription \\; contactez\\-nous\\.",
					].join("\n"),
				],
				[
					"- [Lister la/le/les section(s)/contenu(s)/fonction(s) non accessible(s) pour laquelle/lequel/lesquels la dérogation pour charge disproportionnée est temporairement invoquée, indiquer les alternatives s’il y a lieu].",
					"- Archives PDF avant 2010.",
				],
				[
					"- [Lister la/le/les section(s)/contenu(s)/fonction(s) non accessible(s) qui n’entre(nt) pas dans le champ d’application de la législation applicable, indiquer les alternatives s’il y a lieu].",
					"- Cartes interactives\n- Vidéos en direct.",
				],
				["établie le [JJ mois AAAA]", "établie le 01 octobre 2026"],
				["mise à jour le [JJ mois AAAA]", "mise à jour le 14 octobre 2026"],
				...SITE_CHOICES.slice(0, 1),
				["- [Liste des technologies utilisées]", "- HTML5\n- CSS\n- JavaScript"],
				[
					"- [Indiquer les combinaisons utilisées pour effectuer les vérifications de conformité]",
					"- Firefox et NVDA\n- Safari et VoiceOver",
				],
				["- [Indiquer les outils utilisés]", "- Rampe\n- Colour Contrast Analyser"],
				[
					"- [Indiquer la liste des pages qui ont été testées]",
					[
						`- Accueil${NB}: [https\\:\\/\\/exemple\\.fr\\/](https://exemple.fr/)`,
						`- Panier${NB}: [https\\:\\/\\/exemple\\.fr\\/panier](https://exemple.fr/panier)`,
						`- Paiement${NB}: [https\\:\\/\\/exemple\\.fr\\/paiement](https://exemple.fr/paiement)`,
					].join("\n"),
				],
				...SITE_CHOICES.slice(1),
				["[url du formulaire en ligne]", "[https\\:\\/\\/exemple\\.fr\\/contact](https://exemple.fr/contact)"],
				["[Nom de l’entité responsable du service en ligne]", "Service client"],
				["[url d’une page avec les coordonnées de l’entité]", "[contact\\@exemple\\.fr](mailto:contact@exemple.fr)"],
			]),
		);
	});
});

describe("audit réalisé par une IA (ADR-0022 §3)", () => {
	const ia = setEvaluatedBy(audit(EXAMPLE), "Claude", NOW);
	const IA = "par une IA (Claude), auto-évaluation non certifiée";

	it("golden : le passage « réalisé […] » est rempli par l'attribution, seul remplacement en plus", () => {
		expect(render(ia, FULL_FIELDS)).toBe(
			render(audit(EXAMPLE), FULL_FIELDS).replace("réalisé par la société Acces SARL révèle", `réalisé ${IA} révèle`),
		);
		// Champs vides : le passage n'est pas « à compléter », il est imposé.
		const md = render(ia, {});
		expect(md).toContain(`L’audit de conformité réalisé ${IA} révèle que\u00a0:`);
		expect(md).not.toContain("[en interne / par la société NNN]");
	});

	it("verrouillé : la saisie « en interne » ou « prestataire » ne l'emporte pas, en Markdown comme en HTML", () => {
		for (const fields of [{ auditBy: "interne" }, { auditBy: "prestataire", auditCompany: "Acces SARL" }] as const) {
			expect(render(ia, fields)).toContain(`réalisé ${IA} révèle`);
			expect(render(ia, fields, "html")).toContain(`réalisé ${IA} révèle`);
			expect(render(ia, fields)).not.toMatch(/en interne|Acces SARL/);
		}
	});

	it("reprise par l'humain : la saisie de l'utilisateur revient", () => {
		expect(render(takeOverAudit(ia, NOW), { auditBy: "interne" })).toContain("réalisé en interne révèle");
	});
});

describe("ce que Rampe remplit (ADR-0017 §2)", () => {
	it("audit complet : état, pourcentage, taux moyen, critères non conformes avec titre et pages, pages, date", () => {
		// Calcul à la main (conformity.test.ts) : 1 validé (3.2) sur 3 applicables → 33,33 % ; partiellement ? non :
		// 1 × 2 < 3. Taux moyen : (2/3 + 1 + 2/3) ÷ 3 = 77,77 %.
		const md = render(audit(EXAMPLE), {});
		expect(md).toContain("[Nom du site web, de l’application mobile, ou d’un autre service concerné] est  \n");
		expect(md).toContain(
			" est  \nnon conforme avec le référentiel général d’amélioration de l’accessibilité (RGAA), version 4.1.2.",
		);
		expect(md).toContain(`- 33,33${PCT} des critères RGAA sont respectés.`);
		expect(md).toContain(`- Le taux moyen de conformité du service en ligne s’élève à 77,77${PCT}.`);
		expect(md).not.toContain("[Facultatif]");
		expect(md).toContain(
			"- Critère 1.1\u00a0: Chaque image porteuse d’information a\\-t\\-elle une alternative textuelle\u00a0\\? Page concernée\u00a0: Paiement.",
		);
		expect(md).toMatch(/- Critère 8\.3\u00a0: .+ Page concernée\u00a0: Accueil\./);
		expect(md).not.toMatch(/Critère 3\.2/);
		expect(md).toContain(
			"- Accueil\u00a0: [https\\:\\/\\/exemple\\.fr\\/](https://exemple.fr/)\n- Panier\u00a0: [https\\:\\/\\/exemple\\.fr\\/panier](https://exemple.fr/panier)",
		);
		expect(md).toContain(
			"Cette déclaration a été établie le 15 octobre 2026. Elle a été mise à jour le [JJ mois AAAA].",
		);
		// Moins de 50 % : pas de motif à la place du détail des tests (le pourcentage parle de lui-même).
		expect(md).toContain("[Détailler ici les résultats des tests ou insérer un lien vers le rapport de test]");
	});

	it("au moins 50 % : « partiellement » ; tout conforme : « totalement »", () => {
		const half = audit({ "1.1": ["C", "C", "C"], "8.3": ["NC", "NA", "C"] });
		expect(render(half, {})).toContain(`est  \npartiellement conforme avec`);
		expect(render(half, {})).toContain(`- 50${PCT} des critères RGAA sont respectés.`);
		expect(render(audit({}, "C"), {})).toContain(`est  \ntotalement conforme avec`);
		expect(render(audit({}, "C"), {})).toContain(`- 100${PCT} des critères RGAA sont respectés.`);
	});

	it("audit incomplet : « non conforme », motif à la place du détail des tests, aucun chiffre ni critère listé", () => {
		const s = setEvaluation(audit(EXAMPLE), "1.1", P1, { status: "NT" }, NOW);
		const md = render(s, {});
		expect(md).toContain("non conforme avec");
		expect(md).toContain(`\n\n${NON_CONFORMITY_REASONS.incomplete}\n\n`);
		expect(md).toContain("- [pourcentage de critères RGAA respectés] des critères RGAA sont respectés.");
		expect(md).toContain(
			"- [Facultatif] Le taux moyen de conformité du service en ligne s’élève à [taux moyen de conformité du service en ligne].",
		);
		expect(md).not.toMatch(/Critère \d/);
		expect(md).not.toContain(PCT);
		// Les pages vérifiées sont connues, elles.
		expect(md).toContain("- Paiement\u00a0: ");
	});

	it("aucun critère applicable : « non conforme » avec son motif, et le lien du rapport s'il est saisi", () => {
		const md = render(audit(), { reportUrl: "https://exemple.fr/grille.ods" });
		expect(md).toContain("non conforme avec");
		expect(md).toContain(
			`${NON_CONFORMITY_REASONS["no-applicable"]} [https\\:\\/\\/exemple\\.fr\\/grille\\.ods](https://exemple.fr/grille.ods)`,
		);
		expect(md).toContain("- [pourcentage de critères RGAA respectés] des critères RGAA sont respectés.");
	});

	it("champs vides : chaque passage à compléter reste visible entre crochets, tel que dans le gabarit", () => {
		// Ce que Rampe remplit lui-même, même sans saisie : état, référentiel, nature du service, date d'établissement,
		// pages, détail (motif d'un audit incomplet).
		const filledByRampe = new Set([
			"[totalement / partiellement / non]",
			"[pour les sites\u00a0: le référentiel général d’amélioration de l’accessibilité / autre protocole de test utilisé\u00a0; pour les autres services de communication\u00a0: protocole de test utilisé]",
			"[Du site web / De l’application mobile / Du service…]",
			"[site internet / application mobile / Autre service]",
			"[Indiquer la liste des pages qui ont été testées]",
			"[Détailler ici les résultats des tests ou insérer un lien vers le rapport de test]",
		]);
		const expected = PLACEHOLDERS.filter((p) => !filledByRampe.has(p));
		for (const format of ["markdown", "html"] as const) {
			const out = format === "html" ? htmlText(render(audit({}, "NT"), {}, format)) : render(audit({}, "NT"), {});
			for (const placeholder of expected) expect(out).toContain(placeholder);
			// « [JJ mois AAAA] » : la date d'établissement est remplie, pas celle de mise à jour.
			expect(out.match(/\[JJ mois AAAA\]/g)).toHaveLength(1);
		}
	});

	it("champs remplis : saisies à leur place, URL en liens, une ligne par élément de liste", () => {
		const md = render(audit(EXAMPLE), FULL_FIELDS);
		expect(md).toContain(
			"Boulangerie Dupont s’engage à rendre son site internet accessibles conformément à l’article 47",
		);
		expect(md).toContain(
			"les actions suivantes [schéma pluriannuel](https://exemple.fr/schema) et [plan d’action de l’année en cours](https://exemple.fr/plan).",
		);
		expect(md).toContain("Cette déclaration d’accessibilité s’applique à exemple\\.fr.");
		expect(md).toContain("L’audit de conformité réalisé par la société Acces SARL révèle que\u00a0:");
		expect(md).toContain("- Cartes interactives\n- Vidéos en direct");
		expect(md).toContain("établie le 01 octobre 2026. Elle a été mise à jour le 14 octobre 2026.");
		expect(md).toContain("### Technologies utilisées pour la réalisation du site web\n\n- HTML5\n- CSS\n- JavaScript");
		expect(md).toContain("- Contacter Service client [contact\\@exemple\\.fr](mailto:contact@exemple.fr)");
		// Les non-conformités de l'audit d'abord, puis le complément saisi.
		expect(md).toMatch(/- Critère 8\.3\u00a0: [^\n]+\n- La vidéo n’a pas de transcription \\; contactez\\-nous\\./);
		const html = render(audit(EXAMPLE), { ...FULL_FIELDS, auditBy: "interne" }, "html");
		expect(html).toContain("<p>L’audit de conformité réalisé en interne révèle que\u00a0:</p>");
		expect(html).toContain('<a href="mailto:contact@exemple.fr">contact@exemple.fr</a>');
	});

	it("une seule des deux adresses de stratégie : l'autre reste à compléter", () => {
		expect(render(audit(), { actionPlanUrl: "https://exemple.fr/plan" })).toContain(
			"suivantes [lien vers le schéma pluriannuel] et [plan d’action de l’année en cours](https://exemple.fr/plan).",
		);
	});

	it("page complète : document HTML autonome, en français, titré", () => {
		const s = audit(EXAMPLE);
		const page = renderDeclaration(s, computeConformity(s, ALL), {}, { ...OPTIONS, format: "html", standalone: true });
		expect(page).toMatch(/^<!doctype html>\n<html lang="fr">/);
		expect(page).toContain("<title>Déclaration d’accessibilité</title>");
		expect(page).toContain("<main>\n<h1>Déclaration d’accessibilité</h1>");
	});

	it("HTML à coller : fragment qui commence au h2, sections en h3 et h4 ; la page complète garde h1 à h3", () => {
		const s = audit(EXAMPLE);
		const fragment = render(s, {}, "html");
		expect(fragment.startsWith("<h2>Déclaration d’accessibilité</h2>")).toBe(true);
		expect(fragment).toContain("<h3>État de conformité</h3>");
		expect(fragment).toContain("<h4>Résultat des tests</h4>");
		expect(fragment).not.toMatch(/<h1|<h5/);
		const page = renderDeclaration(s, computeConformity(s, ALL), {}, { ...OPTIONS, format: "html", standalone: true });
		expect(page).toContain("<h2>État de conformité</h2>");
		expect(page).toContain("<h3>Résultat des tests</h3>");
	});

	it("nom de fichier : declaration-accessibilite-<hôte>-<AAAA-MM-JJ>", () => {
		expect(declarationFileName(audit(), new Date(2026, 9, 5), "md")).toBe(
			"declaration-accessibilite-exemple.fr-2026-10-05.md",
		);
	});
});

describe("saisies hostiles neutralisées (OWASP XSS Prevention Cheat Sheet, « Output Encoding »)", () => {
	const HOSTILE: DeclarationFields = {
		organization: '<script>alert(1)</script>"><img src=x onerror=alert(2)>',
		commitment: "[x](javascript:alert(3)) ![i](https://evil.example/p.png) <b>gras</b>",
		serviceName: "‮moc.live‬ &lt;entité&gt; *gras* _it_ `code`",
		schemeUrl: "javascript:alert(4)",
		actionPlanUrl: "JaVaScRiPt:alert(5)",
		reportUrl: "data:text/html,<script>alert(6)</script>",
		contactFormUrl: 'https://exemple.fr/"onmouseover="alert(7)',
		contactPageUrl: "https://exemple.fr/a)(b<c>",
		contactEntity: "# Titre\n- puce",
		nonConformities: "1. liste\n<iframe src=//evil></iframe>\n[lien][ref]\n[ref]: javascript:alert(8)",
		technologies: "    code indenté\n> citation\n| table |",
		auditBy: "prestataire",
		auditCompany: "&amp; <svg onload=alert(9)>",
	};
	const s = audit(EXAMPLE);
	// Le titre d'une page vient aussi de l'utilisateur (ou d'une page auditée).
	const withPage = { ...s, pages: s.pages.map((p, i) => (i === 0 ? { ...p, title: "<script>x</script>‮" } : p)) };

	it("HTML : seules les balises du gabarit, seuls des liens http(s) ou mailto, saisies visibles mais inertes", () => {
		const html = render(withPage, HOSTILE, "html");
		const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)];
		for (const [whole, name, attributes] of tags) {
			expect(["h2", "h3", "h4", "p", "ul", "li", "a", "br"], whole).toContain(name);
			if (name === "a" && !whole.startsWith("</"))
				expect(attributes, whole).toMatch(/^ href="(https?:\/\/|mailto:)[^"<>\s]*"$/);
			else expect(attributes, whole).toBe("");
		}
		expect(html).not.toMatch(/href="(?!https?:\/\/|mailto:)/i);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
		expect(html).toContain("&amp;amp; &lt;svg onload=alert(9)&gt;");
		// Adresses refusées : passage à compléter, pas de lien.
		expect(html).toContain("[liens vers le schéma pluriannuel et vers le plan d’action");
		expect(html).toContain('<a href="https://exemple.fr/%22onmouseover=%22alert%287%29">');
		expect(html).toContain('<a href="https://exemple.fr/a%29%28b%3Cc%3E">');
	});

	it("Markdown : aucune saisie n'ouvre un lien, une image, une balise, un titre, une liste ou une entité", () => {
		const md = render(withPage, HOSTILE, "markdown");
		expect(md).not.toMatch(/javascript:|data:text/i);
		expect(md).toContain(
			"\\[x\\]\\(javascript\\:alert\\(3\\)\\) \\!\\[i\\]\\(https\\:\\/\\/evil\\.example\\/p\\.png\\)",
		);
		expect(md).toContain("\\<script\\>alert\\(1\\)\\<\\/script\\>");
		expect(md).toContain("\\&lt\\;entité\\&gt\\; \\*gras\\* \\_it\\_ \\`code\\`");
		expect(md).toContain(
			"- 1\\. liste\n- \\<iframe src\\=\\/\\/evil\\>\\<\\/iframe\\>\n- \\[lien\\]\\[ref\\]\n- \\[ref\\]\\: javascript",
		);
		// Espaces de bord ignorés : pas de bloc de code indenté.
		expect(md).toContain("- code indenté\n- \\> citation\n- \\| table \\|");
		expect(md).toContain("Contacter \\# Titre\\- puce ");
		// Seules balises : les <br> de l'adresse postale du gabarit.
		expect(md.replace(/<br>/g, "")).not.toMatch(/(^|[^\\])<[a-z!/?]/im);
		// Liens : uniquement ceux que Rampe construit, vers http(s) ou mailto.
		for (const [, href] of md.matchAll(/\]\(([^)]*)\)/g)) expect(href).toMatch(/^(https?:\/\/|mailto:)/);
	});

	it("contrôles bidi et caractères de contrôle retirés, dans les deux formats", () => {
		for (const format of ["html", "markdown"] as const) {
			const out = render(withPage, HOSTILE, format);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: c'est précisément ce qu'on cherche.
			expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\x00-\x08\x0b-\x1f]/);
		}
	});

	it("safeUrl : http(s) et mailto seulement ; adresse e-mail seule acceptée ; le reste refusé", () => {
		expect(safeUrl("https://exemple.fr/contact")).toEqual({
			href: "https://exemple.fr/contact",
			label: "https://exemple.fr/contact",
		});
		expect(safeUrl(" contact@exemple.fr ")).toEqual({ href: "mailto:contact@exemple.fr", label: "contact@exemple.fr" });
		expect(safeUrl("mailto:contact@exemple.fr")?.href).toBe("mailto:contact@exemple.fr");
		for (const bad of [
			"",
			"   ",
			"javascript:alert(1)",
			" javascript:alert(1)",
			"java\tscript:alert(1)",
			"jav&#x09;ascript:alert(1)",
			"vbscript:x",
			"data:text/html,x",
			"file:///etc/passwd",
			"exemple.fr/contact",
			"//evil.example",
			"mailto:",
			"mailto:javascript:alert(1)",
			"https://",
		])
			expect(safeUrl(bad), bad).toBeNull();
	});

	it("le modèle intermédiaire garde les saisies à part du gabarit (l'aperçu de l'îlot les échappe par Preact)", () => {
		const blocks = declarationBlocks(withPage, computeConformity(withPage, ALL), HOSTILE, OPTIONS);
		const inputs = JSON.stringify(blocks.flatMap((b) => (b.kind === "list" ? b.items.flat() : b.content)));
		expect(inputs).toContain('{"kind":"input","text":"<script>alert(1)</script>\\"><img src=x onerror=alert(2)>"}');
	});
});
