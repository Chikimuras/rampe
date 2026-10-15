import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { classifyAxeRule, rgaa } from "./index.ts";

const rules = axe.getRules();
const testIds = new Set(rgaa.criteria.flatMap((c) => c.tests.map((t) => t.id)));

// Étiquettes `RGAA-x.y.z` d'axe qui ne désignent aucun test du référentiel. Toute nouvelle fait échouer.
const KNOWN_UNKNOWN_RGAA_TAGS: string[] = [];

describe("classifyAxeRule", () => {
	it("rattache aux tests RGAA quand la règle porte des étiquettes RGAA", () => {
		expect(
			classifyAxeRule(["cat.text-alternatives", "wcag2a", "wcag111", "RGAAv4", "RGAA-1.1.2", "RGAA-1.1.1"]),
		).toEqual({ level: "rgaa", tests: ["1.1.1", "1.1.2"], criteria: ["1.1"] });
	});

	it("se replie sur WCAG sans étiquette RGAA", () => {
		expect(classifyAxeRule(["wcag2aa", "wcag143", "EN-9.1.4.3"])).toEqual({
			level: "wcag",
			wcag: ["1.4.3"],
			criteria: ["3.2", "10.5"],
		});
	});

	it("découpe les critères de succès à deux chiffres", () => {
		expect(classifyAxeRule(["wcag1410"])).toMatchObject({ level: "wcag", wcag: ["1.4.10"] });
		expect(classifyAxeRule(["wcag1412"])).toMatchObject({ level: "wcag", wcag: ["1.4.12"] });
		// 2.4.11 (WCAG 2.2) n'existe pas dans le RGAA 4.1.2.
		expect(classifyAxeRule(["wcag22aa", "wcag2411"])).toEqual({ level: "hors-rgaa" });
	});

	it("ignore les étiquettes de niveau et des autres référentiels", () => {
		const tags = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa", "wcag2a-obsolete"];
		expect(classifyAxeRule([...tags, "EN-9.1.1.1", "TT11.a", "section508.22.a", "RGAAv4"])).toEqual({
			level: "hors-rgaa",
		});
		expect(classifyAxeRule(["best-practice", "cat.semantics"])).toEqual({ level: "hors-rgaa" });
	});

	it("trie dans l'ordre naturel, sans doublons", () => {
		expect(classifyAxeRule(["RGAA-11.13.1", "RGAA-11.2.1", "RGAA-11.9.1", "RGAA-11.2.1", "RGAA-1.1.1"])).toEqual({
			level: "rgaa",
			tests: ["1.1.1", "11.2.1", "11.9.1", "11.13.1"],
			criteria: ["1.1", "11.2", "11.9", "11.13"],
		});
	});
});

describe(`règles réelles d'axe-core ${axe.version}`, () => {
	it("n'utilise que des étiquettes RGAA désignant un test du référentiel", () => {
		const tags = rules.flatMap((r) => r.tags.filter((t) => t.startsWith("RGAA-")));
		expect(tags.length).toBeGreaterThan(0);
		expect([...new Set(tags.filter((t) => !testIds.has(t.slice(5))))].sort()).toEqual(KNOWN_UNKNOWN_RGAA_TAGS);
	});

	it("classe chaque règle dans exactement un niveau, avec des rattachements existants", () => {
		for (const r of rules) {
			const m = classifyAxeRule(r.tags);
			expect(["rgaa", "wcag", "hors-rgaa"], r.ruleId).toContain(m.level);
			if (m.level !== "hors-rgaa") {
				expect(m.criteria.length, r.ruleId).toBeGreaterThan(0);
				for (const id of m.criteria)
					expect(
						rgaa.criteria.some((c) => c.id === id),
						`${r.ruleId} → ${id}`,
					).toBe(true);
			}
		}
	});

	it("photographie : décompte par niveau (à revoir à chaque montée d'axe)", () => {
		const counts: Record<string, number> = {};
		for (const r of rules) {
			const { level } = classifyAxeRule(r.tags);
			counts[level] = (counts[level] ?? 0) + 1;
		}
		expect(counts).toEqual({ rgaa: 67, wcag: 8, "hors-rgaa": 30 });
	});
});
