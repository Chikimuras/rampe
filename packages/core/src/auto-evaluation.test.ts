import { describe, expect, it } from "vitest";
import { getEvaluation, parseSessionStrict, progress } from "./audit-session.ts";
import {
	AUTO_EVALUATOR,
	buildAutoSession,
	type Fragment,
	pageIdFor,
	parseFragment,
	serializeAutoSession,
} from "./auto-evaluation.ts";
import { computeConformity } from "./conformity.ts";
import { baseCriteria } from "./criteres.ts";
import { ReportError } from "./strict.ts";

const A = "https://chikimuras.github.io/rampe/";
const B = "https://chikimuras.github.io/rampe/audit/";
const sample = [A, B];
const known = new Set(baseCriteria.map((c) => c.id));
const entry = (over: Record<string, unknown> = {}) => ({
	criterion: "1.1",
	page: A,
	status: "C",
	note: "Test 1.1.1 : les 3 images <img> de la page ont un attribut alt.",
	...over,
});
const fragment = (over: Record<string, unknown> = {}) => ({
	evaluator: AUTO_EVALUATOR,
	date: "2026-10-17",
	entries: [entry()],
	...over,
});
const detail = (json: unknown, topic = 1) => {
	try {
		parseFragment(json, topic, sample);
	} catch (e) {
		if (e instanceof ReportError) return e.detail;
		throw e;
	}
	return "accepté";
};

describe("parseFragment : validation stricte", () => {
	it("accepte un fragment valide", () => {
		expect(parseFragment(fragment(), 1, sample).entries).toEqual([entry()]);
	});

	it.each<[string, unknown, RegExp]>([
		["pas un objet", [], /objet attendu/],
		["clé interdite", JSON.parse('{"__proto__": 1}'), /clé interdite « __proto__ »/],
		["clé interdite imbriquée", fragment({ entries: [JSON.parse(`{"constructor": 1}`)] }), /clé interdite/],
		["clé inattendue", fragment({ statut: "C" }), /clé inattendue « statut »/],
		["clé inattendue dans une entrée", fragment({ entries: [entry({ source: "auto" })] }), /clé inattendue/],
		["autre évaluateur", fragment({ evaluator: "Alexandre" }), /evaluator/],
		["date invalide", fragment({ date: "2026-02-31" }), /date/],
		["entries absent", fragment({ entries: undefined }), /liste attendue/],
		["critère inexistant", fragment({ entries: [entry({ criterion: "1.99" })] }), /inexistant/],
		["critère d'une autre thématique", fragment({ entries: [entry({ criterion: "3.1" })] }), /hors de la thématique/],
		["URL hors échantillon", fragment({ entries: [entry({ page: `${A}cockpit/` })] }), /absente de l’échantillon/],
		["URL non normalisée", fragment({ entries: [entry({ page: "https://chikimuras.github.io/rampe" })] }), /absente/],
		["statut inconnu", fragment({ entries: [entry({ status: "NT" })] }), /statut "NT" inconnu/],
		["note absente", fragment({ entries: [entry({ note: undefined })] }), /texte attendu/],
		["note vide", fragment({ entries: [entry({ note: "   " })] }), /justification vide/],
		["note trop longue", fragment({ entries: [entry({ note: `1.1.1 ${"x".repeat(10_000)}` })] }), /plus de 10000/],
		["note sans test cité", fragment({ entries: [entry({ note: "Les images ont un alt." })] }), /aucun test/],
		["test d'un autre critère", fragment({ entries: [entry({ note: "Test 1.10.1 appliqué." })] }), /aucun test/],
		["caractère bidi", fragment({ entries: [entry({ note: "Test 1.1.1 ‮ ok" })] }), /contrôle/],
		[
			"doublon (critère, page)",
			fragment({ entries: [entry(), entry({ status: "NC" })] }),
			/en double du critère 1.1 sur https/,
		],
	])("refuse : %s", (_, json, expected) => {
		expect(detail(json)).toMatch(expected);
	});
});

describe("buildAutoSession", () => {
	const f1: Fragment = parseFragment(
		fragment({ entries: [entry({ page: B, status: "NA", note: "Test 1.1.1 : aucune image." }), entry()] }),
		1,
		sample,
	);
	const f3: Fragment = parseFragment(
		{ ...fragment({ date: "2026-10-20" }), entries: [entry({ criterion: "3.1", note: "Test 3.1.1 : ok." })] },
		3,
		sample,
	);

	it("ids de page stables, dérivés de l'adresse, au format UUID", async () => {
		expect(await pageIdFor(A)).toBe(await pageIdFor(A));
		expect(await pageIdFor(A)).not.toBe(await pageIdFor(B));
		expect(await pageIdFor(A)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("déterministe : même fichier octet pour octet, quel que soit l'ordre des fragments et des entrées", async () => {
		const once = serializeAutoSession(await buildAutoSession(sample, [f1, f3]));
		const reversed = { ...f1, entries: [...f1.entries].reverse() };
		expect(serializeAutoSession(await buildAutoSession(sample, [f3, reversed]))).toBe(once);
		expect(serializeAutoSession(await buildAutoSession(sample, [f1, f3]))).toBe(once);
	});

	it("dates : celle du fragment le plus récent", async () => {
		const s = await buildAutoSession(sample, [f1, f3]);
		expect([s.createdAt, s.updatedAt]).toEqual(["2026-10-16T00:00:00.000Z", "2026-10-20T00:00:00.000Z"]);
	});

	it("aller-retour : le fichier se réimporte dans l'audit guidé sans perte", async () => {
		const session = await buildAutoSession(sample, [f1, f3]);
		const back = parseSessionStrict(JSON.parse(serializeAutoSession(session)), known);
		expect(back).toEqual(session);
		expect(getEvaluation(back, "1.1", await pageIdFor(B))).toEqual({
			status: "NA",
			note: "Test 1.1.1 : aucune image.",
			source: "humain",
		});
	});

	it("doublon entre deux fragments refusé", async () => {
		await expect(buildAutoSession(sample, [f1, f1])).rejects.toThrow(ReportError);
	});

	it("aucun taux tant que l'auto-évaluation est incomplète", async () => {
		const empty = await buildAutoSession(sample, []);
		expect(progress(empty, baseCriteria).total).toMatchObject({ remaining: 212, total: 212 });
		const partial = await buildAutoSession(sample, [f1, f3]);
		expect(progress(partial, baseCriteria).total.remaining).toBe(209);
		expect(computeConformity(partial, [...known])).toEqual({ complete: false, remaining: 209, toConfirm: 0 });
	});

	it("complète : taux calculé", async () => {
		const all = baseCriteria.map((c) =>
			sample.map((page) => ({ criterion: c.id, page, status: "C" as const, note: `Test ${c.id}.1 : ok.` })),
		);
		const fragments = [...new Set(baseCriteria.map((c) => c.topic))].map((topic) => ({
			evaluator: AUTO_EVALUATOR,
			date: "2026-10-17",
			entries: all.flat().filter((e) => e.criterion.startsWith(`${topic}.`)),
		}));
		const parsed = fragments.map((f, i) => parseFragment(f, i + 1, sample));
		const c = computeConformity(await buildAutoSession(sample, parsed), [...known]);
		expect(c).toMatchObject({ complete: true, globalRate: 10000, averageRate: 10000 });
	});
});
