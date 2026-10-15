// Rattachement des règles axe-core au RGAA à partir de leurs étiquettes (ADR-0008).
import { rgaa } from "./rgaa.ts";

/** Informations portées par les trois niveaux. */
interface AxeRuleFlags {
	/** Étiquettes `RGAA-x.y.z` qui ne désignent aucun test du référentiel (ignorées pour le rattachement). */
	unknownRgaaTags: string[];
	/** Règle classée « best-practice » par axe : signalée, quel que soit le niveau. */
	bestPractice: boolean;
	/** Règle expérimentale d'axe. */
	experimental: boolean;
	/** Règle dépréciée par axe (étiquette `deprecated`) : vouée à disparaître, à ne plus présenter comme une vérification. */
	deprecated: boolean;
}

/**
 * Rattachement d'une règle axe au RGAA. Le niveau qualifie la PRÉCISION DU RATTACHEMENT,
 * pas la certitude du défaut : une bonne pratique ou une règle expérimentale d'axe peut être
 * au niveau `rgaa` ; elle est alors signalée par `bestPractice` / `experimental`.
 * Une règle dépréciée par axe garde aussi son niveau, avec `deprecated`.
 */
export type AxeRuleMapping =
	/** Étiquettes RGAA natives : rattachement direct aux tests. */
	| ({ level: "rgaa"; tests: string[]; criteria: string[] } & AxeRuleFlags)
	/** Pas d'étiquette RGAA valide : rattachement indirect via les critères de succès WCAG (`wcag` : ceux qui ont au moins un critère RGAA). */
	| ({ level: "wcag"; wcag: string[]; criteria: string[] } & AxeRuleFlags)
	/** Aucun rattachement RGAA possible ; `wcag` liste les critères de succès trouvés (ex. 2.5.8, absent du RGAA 4.1.2). */
	| ({ level: "hors-rgaa"; wcag: string[] } & AxeRuleFlags);

// `RGAA-1.1.2` → test "1.1.2".
const RGAA_TAG = /^RGAA-(\d+\.\d+\.\d+)$/;
// `wcag111` → "1.1.1", `wcag1410` → "1.4.10" : principe et directive sur un chiffre, critère sur un ou deux.
// Les étiquettes de niveau (`wcag2a`, `wcag21aa`…) se terminent par une lettre et ne correspondent pas.
const WCAG_TAG = /^wcag(\d)(\d)(\d{1,2})$/;

/** Tri par ordre naturel des identifiants numériques pointés (1.2 < 1.10), sans doublons. */
const sortIds = (ids: Iterable<string>): string[] =>
	[...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

const criterionOf = (testId: string) => testId.slice(0, testId.lastIndexOf("."));

const testIds = new Set(rgaa.criteria.flatMap((c) => c.tests.map((t) => t.id)));

// Critère de succès WCAG → critères RGAA qui le référencent.
const criteriaBySc = new Map<string, string[]>();
for (const c of rgaa.criteria) {
	for (const { sc } of c.wcag) criteriaBySc.set(sc, [...(criteriaBySc.get(sc) ?? []), c.id]);
}

/** Classe une règle axe-core d'après ses étiquettes (`rule.tags` ou `result.tags`). */
export function classifyAxeRule(tags: readonly string[]): AxeRuleMapping {
	const tests: string[] = [];
	const unknownRgaaTags: string[] = [];
	for (const t of tags) {
		const id = RGAA_TAG.exec(t)?.[1];
		if (id && testIds.has(id)) tests.push(id);
		else if (id) unknownRgaaTags.push(t);
	}
	const flags: AxeRuleFlags = {
		unknownRgaaTags: sortIds(unknownRgaaTags),
		bestPractice: tags.includes("best-practice"),
		experimental: tags.includes("experimental"),
		deprecated: tags.includes("deprecated"),
	};
	if (tests.length > 0)
		return { level: "rgaa", tests: sortIds(tests), criteria: sortIds(tests.map(criterionOf)), ...flags };

	const wcag = sortIds(
		tags.flatMap((t) => {
			const m = WCAG_TAG.exec(t);
			return m ? `${m[1]}.${m[2]}.${m[3]}` : [];
		}),
	);
	const mapped = wcag.filter((sc) => criteriaBySc.has(sc));
	if (mapped.length > 0)
		return {
			level: "wcag",
			wcag: mapped,
			criteria: sortIds(mapped.flatMap((sc) => criteriaBySc.get(sc) ?? [])),
			...flags,
		};

	return { level: "hors-rgaa", wcag, ...flags };
}
