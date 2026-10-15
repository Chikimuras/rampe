import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { classifyAxeRule, criteriaWithDirectRule, getCriterion, isDirectCheck } from "./index.ts";

const rules = axe.getRules();
const noFlags = { unknownRgaaTags: [], bestPractice: false, experimental: false, deprecated: false };

describe("classifyAxeRule", () => {
	it("rattache aux tests RGAA quand la règle porte des étiquettes RGAA", () => {
		expect(
			classifyAxeRule(["cat.text-alternatives", "wcag2a", "wcag111", "RGAAv4", "RGAA-1.1.2", "RGAA-1.1.1"]),
		).toEqual({ level: "rgaa", tests: ["1.1.1", "1.1.2"], criteria: ["1.1"], ...noFlags });
	});

	it("se replie sur WCAG sans étiquette RGAA", () => {
		expect(classifyAxeRule(["wcag2aa", "wcag143", "EN-9.1.4.3"])).toEqual({
			level: "wcag",
			wcag: ["1.4.3"],
			criteria: ["3.2", "10.5"],
			...noFlags,
		});
	});

	it("ne garde au niveau wcag que les critères de succès présents dans le RGAA", () => {
		expect(classifyAxeRule(["wcag111", "wcag258"])).toMatchObject({ level: "wcag", wcag: ["1.1.1"] });
	});

	it("découpe les critères de succès à deux chiffres", () => {
		expect(classifyAxeRule(["wcag1410"])).toMatchObject({ level: "wcag", wcag: ["1.4.10"] });
		expect(classifyAxeRule(["wcag1412"])).toMatchObject({ level: "wcag", wcag: ["1.4.12"] });
		// 2.4.11 (WCAG 2.2) n'existe pas dans le RGAA 4.1.2.
		expect(classifyAxeRule(["wcag22aa", "wcag2411"])).toEqual({ level: "hors-rgaa", wcag: ["2.4.11"], ...noFlags });
	});

	it("ignore les étiquettes de niveau et des autres référentiels", () => {
		const tags = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa", "wcag2a-obsolete"];
		expect(classifyAxeRule([...tags, "EN-9.1.1.1", "TT11.a", "section508.22.a", "RGAAv4"])).toEqual({
			level: "hors-rgaa",
			wcag: [],
			...noFlags,
		});
	});

	it("écarte les étiquettes RGAA inconnues du référentiel en les signalant", () => {
		expect(classifyAxeRule(["RGAA-1.1.9"])).toEqual({
			...noFlags,
			level: "hors-rgaa",
			wcag: [],
			unknownRgaaTags: ["RGAA-1.1.9"],
		});
		expect(classifyAxeRule(["RGAA-1.1.9", "wcag111"])).toMatchObject({
			level: "wcag",
			unknownRgaaTags: ["RGAA-1.1.9"],
		});
		expect(classifyAxeRule(["RGAA-99.1.1"])).toMatchObject({ level: "hors-rgaa", unknownRgaaTags: ["RGAA-99.1.1"] });
		expect(classifyAxeRule(["RGAA-99.1.1", "RGAA-1.1.1"])).toMatchObject({ level: "rgaa", tests: ["1.1.1"] });
	});

	it("signale bonnes pratiques et règles expérimentales sans changer le niveau", () => {
		expect(classifyAxeRule(["best-practice", "experimental", "RGAA-12.7.1"])).toMatchObject({
			level: "rgaa",
			bestPractice: true,
			experimental: true,
		});
		expect(classifyAxeRule(["best-practice", "cat.semantics"])).toEqual({
			...noFlags,
			level: "hors-rgaa",
			wcag: [],
			bestPractice: true,
		});
	});

	it("signale les règles dépréciées sans changer le niveau", () => {
		expect(classifyAxeRule(["deprecated", "wcag2a-obsolete", "wcag411"])).toMatchObject({
			level: "wcag",
			deprecated: true,
		});
	});

	it("trie dans l'ordre naturel, sans doublons", () => {
		expect(classifyAxeRule(["RGAA-11.13.1", "RGAA-11.2.1", "RGAA-11.9.1", "RGAA-11.2.1", "RGAA-1.1.1"])).toMatchObject({
			level: "rgaa",
			tests: ["1.1.1", "11.2.1", "11.9.1", "11.13.1"],
			criteria: ["1.1", "11.2", "11.9", "11.13"],
		});
	});
});

describe(`règles réelles d'axe-core ${axe.version}`, () => {
	const classified = rules.map((r) => ({ id: r.ruleId, m: classifyAxeRule(r.tags) }));

	it("n'utilise que des étiquettes RGAA désignant un test du référentiel", () => {
		expect(rules.flatMap((r) => r.tags).some((t) => t.startsWith("RGAA-"))).toBe(true);
		expect(classified.flatMap(({ m }) => m.unknownRgaaTags)).toEqual([]);
	});

	it("ne rattache qu'à des critères existants", () => {
		for (const { id, m } of classified) {
			if (m.level === "hors-rgaa") continue;
			expect(m.criteria.length, id).toBeGreaterThan(0);
			for (const c of m.criteria) expect(getCriterion(c), `${id} → ${c}`).toBeDefined();
		}
	});

	// Photographies : à revoir à chaque montée d'axe, le changement se lit dans le diff.
	it("photographie : décompte par niveau", () => {
		const counts: Record<string, number> = {};
		for (const { m } of classified) counts[m.level] = (counts[m.level] ?? 0) + 1;
		expect(counts).toEqual({ rgaa: 67, wcag: 8, "hors-rgaa": 30 });
	});

	it("photographie : règles de niveau wcag", () => {
		const sc412 = [
			"1.2",
			"1.3",
			"1.9",
			"2.1",
			"2.2",
			"4.13",
			"5.3",
			"7.1",
			"7.2",
			"8.2",
			"9.1",
			"10.8",
			"11.1",
			"11.9",
			"12.6",
			"13.3",
			"13.4",
		];
		const wcag = (sc: string, criteria: string[], deprecated = false) => ({
			level: "wcag",
			wcag: [sc],
			criteria,
			...noFlags,
			deprecated,
		});
		expect(Object.fromEntries(classified.filter(({ m }) => m.level === "wcag").map(({ id, m }) => [id, m]))).toEqual({
			"aria-braille-equivalent": wcag("4.1.2", sc412),
			"aria-roledescription": wcag("4.1.2", sc412, true),
			"aria-tooltip-name": wcag("4.1.2", sc412),
			"audio-caption": wcag("1.2.1", ["4.1", "4.2"], true),
			"avoid-inline-spacing": wcag("1.4.12", ["10.12"]),
			"duplicate-id-active": wcag("4.1.1", ["8.1", "8.2"], true),
			"duplicate-id": wcag("4.1.1", ["8.1", "8.2"], true),
			"summary-name": wcag("4.1.2", sc412),
		});
	});

	it("photographie : règles dépréciées", () => {
		expect(classified.filter(({ m }) => m.deprecated).map(({ id }) => id)).toEqual([
			"aria-roledescription",
			"audio-caption",
			"duplicate-id-active",
			"duplicate-id",
			"landmark-complementary-is-top-level",
		]);
	});

	it("isDirectCheck écarte bonnes pratiques, expérimentales et dépréciées", () => {
		expect(isDirectCheck(classifyAxeRule(["RGAA-1.1.1"]))).toBe(true);
		for (const flag of ["best-practice", "experimental", "deprecated"])
			expect(isDirectCheck(classifyAxeRule([flag, "RGAA-1.1.1"]))).toBe(false);
		expect(isDirectCheck(classifyAxeRule(["wcag111"]))).toBe(false);
	});

	it("photographie : bonnes pratiques d'axe rattachées au niveau rgaa", () => {
		const ids = classified.filter(({ m }) => m.level === "rgaa" && m.bestPractice).map(({ id }) => id);
		expect(ids).toEqual(["focus-order-semantics", "region", "skip-link", "table-duplicate-name"]);
	});
});

describe("criteriaWithDirectRule", () => {
	it("ne compte que les vérifications directes : ni bonne pratique, ni expérimentale, ni dépréciée", () => {
		const covered = criteriaWithDirectRule([
			["RGAA-1.1.1"],
			["RGAA-8.3.1", "RGAA-8.4.1"],
			["deprecated", "RGAA-11.1.1"],
			["best-practice", "RGAA-9.2.1"],
			["experimental", "RGAA-12.7.1"],
			["wcag143"],
			["best-practice"],
		]);
		expect([...covered]).toEqual(["1.1", "8.3", "8.4"]);
	});

	it("photographie : critères vérifiés directement par axe-core 4.14.0", () => {
		// 106 - 27 = 79 critères sans aucune vérification automatique directe.
		expect(criteriaWithDirectRule(rules.map((r) => r.tags)).size).toBe(27);
	});
});
