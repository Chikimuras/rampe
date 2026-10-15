// Rattachement des règles axe-core au RGAA à partir de leurs étiquettes (ADR-0008).
import { rgaa } from "./rgaa.ts";

/** Niveau de rattachement d'une règle axe, du plus précis au moins précis. */
export type AxeRuleMapping =
	/** Étiquettes RGAA natives : rattachement direct aux tests. */
	| { level: "rgaa"; tests: string[]; criteria: string[] }
	/** Pas d'étiquette RGAA : rattachement indirect via les critères de succès WCAG. */
	| { level: "wcag"; wcag: string[]; criteria: string[] }
	/** Bonne pratique hors référentiel : jamais comptée dans la conformité. */
	| { level: "hors-rgaa" };

// `RGAA-1.1.2` → test "1.1.2".
const RGAA_TAG = /^RGAA-(\d+\.\d+\.\d+)$/;
// `wcag111` → "1.1.1", `wcag1410` → "1.4.10" : principe et directive sur un chiffre, critère sur un ou deux.
// Les étiquettes de niveau (`wcag2a`, `wcag21aa`…) se terminent par une lettre et ne correspondent pas.
const WCAG_TAG = /^wcag(\d)(\d)(\d{1,2})$/;

/** Tri par ordre naturel des identifiants numériques pointés (1.2 < 1.10), sans doublons. */
const sortIds = (ids: Iterable<string>): string[] =>
	[...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

const criterionOf = (testId: string) => testId.slice(0, testId.lastIndexOf("."));

// Critère de succès WCAG → critères RGAA qui le référencent.
const criteriaBySc = new Map<string, string[]>();
for (const c of rgaa.criteria) {
	for (const { sc } of c.wcag) criteriaBySc.set(sc, [...(criteriaBySc.get(sc) ?? []), c.id]);
}

/** Classe une règle axe-core d'après ses étiquettes (`rule.tags` ou `result.tags`). */
export function classifyAxeRule(tags: readonly string[]): AxeRuleMapping {
	const tests = tags.flatMap((t) => RGAA_TAG.exec(t)?.[1] ?? []);
	if (tests.length > 0) return { level: "rgaa", tests: sortIds(tests), criteria: sortIds(tests.map(criterionOf)) };

	const wcag = tags.flatMap((t) => {
		const m = WCAG_TAG.exec(t);
		return m ? `${m[1]}.${m[2]}.${m[3]}` : [];
	});
	const criteria = wcag.flatMap((sc) => criteriaBySc.get(sc) ?? []);
	if (criteria.length > 0) return { level: "wcag", wcag: sortIds(wcag), criteria: sortIds(criteria) };

	return { level: "hors-rgaa" };
}
