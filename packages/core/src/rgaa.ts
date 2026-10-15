// Modèle normalisé du référentiel RGAA (ADR-0007). Le reste du code ne lit jamais le JSON brut.
import criteres from "../data/rgaa/criteres.json" with { type: "json" };
import glossaire from "../data/rgaa/glossaire.json" with { type: "json" };
import methodologies from "../data/rgaa/methodologies.json" with { type: "json" };
import source from "../data/rgaa/source.json" with { type: "json" };

export type WcagLevel = "A" | "AA" | "AAA";

/** Référence à un critère de succès WCAG, ex. `{ sc: "1.1.1", name: "Non-text Content", level: "A" }`. */
export interface WcagRef {
	sc: string;
	name: string;
	level: WcagLevel;
}

/** Paragraphe (markdown) ou liste à puces, tels que fournis par la source officielle. */
export type Note = string | { ul: string[] };

export interface Topic {
	number: number;
	title: string;
}

export interface Test {
	/** ex. "1.1.1" */
	id: string;
	/** Énoncé (markdown) ; les éléments suivants sont les conditions à vérifier, s'il y en a. */
	text: string[];
	/** Méthodologie de test (markdown). */
	methodology: string;
}

export interface Criterion {
	/** ex. "1.1" */
	id: string;
	topic: number;
	/** Titre markdown d'origine, avec ses liens `[texte](#ancre)` vers le glossaire. */
	title: string;
	tests: Test[];
	wcag: WcagRef[];
	techniques: string[];
	particularCases?: Note[];
	technicalNote?: Note[];
}

export interface GlossaryEntry {
	anchor: string;
	title: string;
	/** Définition (HTML d'origine). */
	body: string;
}

// Forme des fichiers officiels : la vérification de type échoue si elle ne correspond plus.
interface RawCriteres {
	topics: {
		topic: string;
		number: number;
		criteria: {
			criterium: {
				number: number;
				title: string;
				tests: Partial<Record<string, string[]>>;
				references: { wcag?: string[]; techniques?: string[] }[];
				particularCases?: Note[];
				technicalNote?: Note[];
			};
		}[];
	}[];
}

const rawCriteres: RawCriteres = criteres;
const rawMethodologies: Record<string, string> = methodologies;

/** Analyse une référence telle qu'écrite dans le RGAA : "1.1.1 Non-text Content (A)". */
export function parseWcagRef(ref: string): WcagRef {
	const m = /^(\d+\.\d+\.\d+) (.+) \((A|AA|AAA)\)$/.exec(ref);
	if (!m) throw new Error(`Référence WCAG illisible : ${ref}`);
	return { sc: m[1] as string, name: m[2] as string, level: m[3] as WcagLevel };
}

/**
 * Ancre d'une entrée du glossaire, dérivée de son titre comme sur accessibilite.numerique.gouv.fr :
 * accents retirés, minuscules, toute suite de caractères non alphanumériques remplacée par un tiret.
 * Ex. "Image porteuse d’information" → "image-porteuse-d-information".
 */
function slugify(title: string): string {
	return title
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

const topics: Topic[] = rawCriteres.topics.map((t) => ({ number: t.number, title: t.topic }));

const criteria: Criterion[] = rawCriteres.topics.flatMap((t) =>
	t.criteria.map(({ criterium: c }): Criterion => {
		const id = `${t.number}.${c.number}`;
		const criterion: Criterion = {
			id,
			topic: t.number,
			title: c.title,
			tests: Object.entries(c.tests).flatMap(([n, text]) =>
				text ? [{ id: `${id}.${n}`, text, methodology: rawMethodologies[`${id}.${n}`] ?? "" }] : [],
			),
			wcag: c.references.flatMap((r) => r.wcag ?? []).map(parseWcagRef),
			techniques: c.references.flatMap((r) => r.techniques ?? []),
		};
		if (c.particularCases) criterion.particularCases = c.particularCases;
		if (c.technicalNote) criterion.technicalNote = c.technicalNote;
		return criterion;
	}),
);

const glossary: GlossaryEntry[] = glossaire.glossary.map((e) => ({ anchor: slugify(e.title), ...e }));

export const rgaa = {
	version: source.rgaaVersion,
	wcagVersion: source.wcagVersion,
	source,
	topics,
	criteria,
	glossary,
} as const;

const criteriaById = new Map(criteria.map((c) => [c.id, c]));
const glossaryByAnchor = new Map(glossary.map((e) => [e.anchor, e]));

export function getCriterion(id: string): Criterion | undefined {
	return criteriaById.get(id);
}

export function getGlossaryEntry(anchor: string): GlossaryEntry | undefined {
	return glossaryByAnchor.get(anchor);
}
