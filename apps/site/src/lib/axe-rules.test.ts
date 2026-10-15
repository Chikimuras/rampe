import { criteriaWithDirectRule, rgaa } from "@rampe/core";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { rulesFor } from "./axe-rules";

const all = rgaa.criteria.map((c) => ({ id: c.id, ...rulesFor(c.id) }));

describe(`règles axe-core ${axe.version} par critère`, () => {
	it("n'affiche aucune règle dépréciée", () => {
		const deprecated = new Set(
			axe
				.getRules()
				.filter((r) => r.tags.includes("deprecated"))
				.map((r) => r.ruleId),
		);
		expect(deprecated.size).toBeGreaterThan(0);
		const shown = all.flatMap((c) => [...c.direct, ...c.unconfirmed, ...c.indirect]).map((r) => r.ruleId);
		expect(shown.filter((id) => deprecated.has(id))).toEqual([]);
	});

	it("cite pour chaque règle directe ou à confirmer au moins un test du critère", () => {
		for (const c of all)
			for (const r of [...c.direct, ...c.unconfirmed]) expect(r.tests.length, `${c.id} ${r.ruleId}`).toBeGreaterThan(0);
	});

	it("ne range parmi les directes ni bonne pratique ni règle expérimentale", () => {
		const direct = all.flatMap((c) => c.direct);
		expect(direct.filter((r) => r.bestPractice || r.experimental)).toEqual([]);
		expect(all.flatMap((c) => c.unconfirmed).every((r) => r.bestPractice || r.experimental)).toBe(true);
	});

	it("compte la même couverture que la CLI (criteriaWithDirectRule de @rampe/core)", () => {
		const covered = criteriaWithDirectRule(axe.getRules().map((r) => r.tags));
		expect(all.filter((c) => c.direct.length > 0).map((c) => c.id)).toEqual([...covered]);
	});

	it("cite pour chaque règle indirecte le critère WCAG commun", () => {
		for (const c of all) for (const r of c.indirect) expect(r.wcag.length, `${c.id} ${r.ruleId}`).toBeGreaterThan(0);
	});

	// Photographie : à revoir à chaque montée d'axe, le changement se lit dans le diff.
	it("photographie : critères couverts directement / à confirmer / seulement indirectement", () => {
		const direct = all.filter((c) => c.direct.length > 0).map((c) => c.id);
		const indirectOnly = all.filter((c) => c.direct.length === 0 && c.indirect.length > 0).map((c) => c.id);
		const unconfirmed = all
			.filter((c) => c.unconfirmed.length > 0)
			.map((c) => `${c.id} ${c.unconfirmed.map((r) => r.ruleId)}`);
		expect({ direct: direct.length, indirectOnly, unconfirmed }).toMatchInlineSnapshot(`
			{
			  "direct": 27,
			  "indirectOnly": [
			    "1.2",
			    "1.3",
			    "1.9",
			    "4.13",
			    "5.3",
			    "7.2",
			    "9.1",
			    "10.12",
			    "12.6",
			    "13.3",
			    "13.4",
			  ],
			  "unconfirmed": [
			    "5.2 table-duplicate-name",
			    "5.4 table-fake-caption",
			    "5.7 td-has-header",
			    "9.1 p-as-heading",
			    "9.2 region",
			    "12.7 skip-link",
			    "12.8 focus-order-semantics",
			    "13.9 css-orientation-lock",
			  ],
			}
		`);
	});
});
