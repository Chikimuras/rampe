// Critères du RGAA (ADR-0007) SANS glossaire ni méthodologies : ce que l'audit automatique utilise (CLI, extension).
// Point d'entrée léger pour l'extension (ADR-0019) ; rgaa.ts y ajoute méthodologies et glossaire.
import criteres from "../data/rgaa/criteres.json" with { type: "json" };

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

export interface BaseTest {
	/** ex. "1.1.1" */
	id: string;
	/** Énoncé (markdown) ; les éléments suivants sont les conditions à vérifier, s'il y en a. */
	text: string[];
}

/** Critère sans la méthodologie de ses tests (voir `Criterion` dans rgaa.ts). */
export interface BaseCriterion {
	/** ex. "1.1" */
	id: string;
	topic: number;
	/** Titre markdown d'origine, avec ses liens `[texte](#ancre)` vers le glossaire. */
	title: string;
	tests: BaseTest[];
	wcag: WcagRef[];
	techniques: string[];
	particularCases?: Note[];
	technicalNote?: Note[];
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

/** Analyse une référence telle qu'écrite dans le RGAA : "1.1.1 Non-text Content (A)". */
export function parseWcagRef(ref: string): WcagRef {
	const m = /^(\d+\.\d+\.\d+) (.+) \((A|AA|AAA)\)$/.exec(ref);
	if (!m) throw new Error(`Référence WCAG illisible : ${ref}`);
	return { sc: m[1] as string, name: m[2] as string, level: m[3] as WcagLevel };
}

export const topics: Topic[] = rawCriteres.topics.map((t) => ({ number: t.number, title: t.topic }));

export const baseCriteria: BaseCriterion[] = rawCriteres.topics.flatMap((t) =>
	t.criteria.map(({ criterium: c }): BaseCriterion => {
		const id = `${t.number}.${c.number}`;
		const criterion: BaseCriterion = {
			id,
			topic: t.number,
			title: c.title,
			tests: Object.entries(c.tests).flatMap(([n, text]) => (text ? [{ id: `${id}.${n}`, text }] : [])),
			wcag: c.references.flatMap((r) => r.wcag ?? []).map(parseWcagRef),
			techniques: c.references.flatMap((r) => r.techniques ?? []),
		};
		if (c.particularCases) criterion.particularCases = c.particularCases;
		if (c.technicalNote) criterion.technicalNote = c.technicalNote;
		return criterion;
	}),
);

const byId = new Map(baseCriteria.map((c) => [c.id, c]));
export const getBaseCriterion = (id: string): BaseCriterion | undefined => byId.get(id);
