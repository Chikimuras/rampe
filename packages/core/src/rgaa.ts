// Modèle normalisé du référentiel RGAA (ADR-0007). Le reste du code ne lit jamais le JSON brut.

import glossaire from "../data/rgaa/glossaire.json" with { type: "json" };
import methodologies from "../data/rgaa/methodologies.json" with { type: "json" };
import source from "../data/rgaa/source.json" with { type: "json" };
import { type BaseCriterion, type BaseTest, baseCriteria, topics } from "./criteres.ts";

export * from "./criteres.ts";

export interface Test extends BaseTest {
	/** Méthodologie de test (markdown). */
	methodology: string;
}

export interface Criterion extends BaseCriterion {
	tests: Test[];
}

export interface GlossaryEntry {
	anchor: string;
	title: string;
	/** Définition (HTML d'origine). */
	body: string;
}

const rawMethodologies: Record<string, string> = methodologies;

/**
 * Ancre d'une entrée du glossaire, dérivée de son titre : accents retirés, minuscules,
 * toute suite de caractères non alphanumériques remplacée par un tiret.
 * Règle vérifiée par les tests : tous les liens du référentiel résolvent.
 * Ex. "Image porteuse d’information" → "image-porteuse-d-information".
 */
function slugify(title: string): string {
	return title
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

const criteria: Criterion[] = baseCriteria.map((c) => ({
	...c,
	tests: c.tests.map((t) => ({ ...t, methodology: rawMethodologies[t.id] ?? "" })),
}));

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
