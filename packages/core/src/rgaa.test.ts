import { describe, expect, it } from "vitest";
import { getCriterion, getGlossaryEntry, parseWcagRef, rgaa } from "./index.ts";

// Liens markdown internes `[texte](#ancre)`.
const anchorsIn = (texts: string[]) =>
	texts.flatMap((t) => [...t.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string));

// Ancres présentes dans les données officielles qui ne pointent pas vers le glossaire
// (lien vers une section de la spécification HTML, mort hors de son contexte d'origine).
const KNOWN_DANGLING_ANCHORS = ["table-descriptions-techniques"];

describe("référentiel RGAA", () => {
	it("est le RGAA 4.1.2 basé sur WCAG 2.1, importé d'un commit identifié", () => {
		expect(rgaa.version).toBe("4.1.2");
		expect(rgaa.wcagVersion).toBe("2.1");
		expect(rgaa.source.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it("compte 13 thématiques et 106 critères", () => {
		expect(rgaa.topics).toHaveLength(13);
		expect(rgaa.topics.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
		expect(rgaa.criteria).toHaveLength(106);
	});

	it("a des identifiants de critères et de tests uniques et bien formés", () => {
		const criterionIds = rgaa.criteria.map((c) => c.id);
		expect(new Set(criterionIds).size).toBe(criterionIds.length);
		for (const c of rgaa.criteria) {
			expect(c.id).toMatch(/^\d{1,2}\.\d{1,2}$/);
			expect(c.id.startsWith(`${c.topic}.`)).toBe(true);
			expect(c.tests.length).toBeGreaterThan(0);
			for (const t of c.tests) expect(t.id.startsWith(`${c.id}.`)).toBe(true);
		}
		const testIds = rgaa.criteria.flatMap((c) => c.tests.map((t) => t.id));
		expect(new Set(testIds).size).toBe(testIds.length);
		for (const id of testIds) expect(id).toMatch(/^\d{1,2}\.\d{1,2}\.\d{1,2}$/);
	});

	it("donne à chaque test un énoncé et une méthodologie non vides", () => {
		for (const t of rgaa.criteria.flatMap((c) => c.tests)) {
			expect(t.text.length, t.id).toBeGreaterThan(0);
			expect(t.methodology.trim(), t.id).not.toBe("");
		}
	});

	it("donne à chaque critère au moins une référence WCAG valide", () => {
		for (const c of rgaa.criteria) {
			expect(c.wcag.length, c.id).toBeGreaterThan(0);
			for (const ref of c.wcag) {
				expect(ref.sc).toMatch(/^\d\.\d{1,2}\.\d{1,2}$/);
				expect(ref.name).not.toBe("");
				expect(["A", "AA", "AAA"]).toContain(ref.level);
			}
		}
	});

	it("analyse une référence WCAG", () => {
		expect(parseWcagRef("1.1.1 Non-text Content (A)")).toEqual({ sc: "1.1.1", name: "Non-text Content", level: "A" });
		expect(() => parseWcagRef("n'importe quoi")).toThrow();
	});

	it("résout chaque lien de glossaire des titres et des tests", () => {
		const texts = rgaa.criteria.flatMap((c) => [c.title, ...c.tests.flatMap((t) => t.text)]);
		const anchors = anchorsIn(texts);
		expect(anchors.length).toBeGreaterThan(0);
		expect(anchors.filter((a) => !getGlossaryEntry(a))).toEqual([]);
	});

	it("résout les liens des notes, à la liste d'exceptions connue près", () => {
		const notes = rgaa.criteria.flatMap((c) =>
			[...(c.particularCases ?? []), ...(c.technicalNote ?? [])].flatMap((n) => (typeof n === "string" ? [n] : n.ul)),
		);
		const dangling = [...new Set(anchorsIn(notes).filter((a) => !getGlossaryEntry(a)))];
		expect(dangling).toEqual(KNOWN_DANGLING_ANCHORS);
	});

	it("indexe le glossaire par ancre unique", () => {
		const anchors = rgaa.glossary.map((e) => e.anchor);
		expect(new Set(anchors).size).toBe(anchors.length);
		expect(getGlossaryEntry("image-porteuse-d-information")?.title).toBe("Image porteuse d’information");
		expect(getGlossaryEntry("inexistant")).toBeUndefined();
	});

	it("retrouve un critère par identifiant", () => {
		const c = getCriterion("1.1");
		expect(c?.title).toBe(
			"Chaque [image porteuse d’information](#image-porteuse-d-information) a-t-elle une [alternative textuelle](#alternative-textuelle-image)\u00a0?", // espace insécable avant « ? »
		);
		expect(c?.wcag).toContainEqual({ sc: "1.1.1", name: "Non-text Content", level: "A" });
		expect(c?.tests[0]?.id).toBe("1.1.1");
		expect(getCriterion("99.1")).toBeUndefined();
	});
});
