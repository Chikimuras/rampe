// Taux de conformité (ADR-0015). Toutes les valeurs attendues sont calculées À LA MAIN dans les commentaires,
// jamais recalculées par le code testé.
import { describe, expect, it } from "vitest";
import { type AuditSession, addPage, createSession, type Status, setEvaluation } from "./audit-session.ts";
import { computeConformity, floorAverageHundredths, floorHundredths, formatRate, processKey } from "./conformity.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const P3 = "00000000-0000-4000-8000-000000000003";

/** Session de pages `[id, process?]`, puis statuts `{ critère: [statut page 1, statut page 2, …] }`. */
function build(pages: [string, string?][], statuses: Record<string, Status[]>): AuditSession {
	let s = createSession(NOW);
	for (const [id, process] of pages) s = addPage(s, { url: `https://exemple.fr/${id}`, title: id, process }, NOW, id);
	for (const [criterion, list] of Object.entries(statuses))
		list.forEach((status, i) => {
			s = setEvaluation(s, criterion, pages[i]?.[0] ?? "", { status }, NOW);
		});
	return s;
}

const complete = (s: AuditSession, ids: string[]) => {
	const r = computeConformity(s, ids);
	if (!r.complete) throw new Error("audit attendu complet");
	return r;
};

describe("computeConformity", () => {
	it("1 page, tout conforme : 100", () => {
		const r = complete(build([[P1]], { "1.1": ["C"], "1.2": ["C"] }), ["1.1", "1.2"]);
		// Taux en centièmes de point : 10000 = 100 %.
		expect(r.globalRate).toBe(10000);
		expect(r.averageRate).toBe(10000);
		expect(r.pages).toEqual([{ pageId: P1, validated: 2, invalidated: 0, notApplicable: 0, rate: 10000 }]);
	});

	it("1 NC sur 1 page sur 3 : le critère n'est pas validé", () => {
		const r = complete(build([[P1], [P2], [P3]], { "1.1": ["C", "NC", "C"] }), ["1.1"]);
		expect(r.criteria).toEqual([{ criterion: "1.1", status: "non validé" }]);
		// 0 validé ÷ 1 applicable.
		expect(r.globalRate).toBe(0);
	});

	it("NA sur toutes les pages : non applicable, exclu du taux global", () => {
		const r = complete(build([[P1], [P2]], { "1.1": ["NA", "NA"], "1.2": ["C", "NA"] }), ["1.1", "1.2"]);
		expect(r.criteria).toEqual([
			{ criterion: "1.1", status: "non applicable" },
			{ criterion: "1.2", status: "validé" },
		]);
		expect(r).toMatchObject({ validated: 1, invalidated: 0, notApplicable: 1, applicable: 1, globalRate: 10000 });
	});

	it("page où tout est NA : taux null, exclue de la moyenne", () => {
		// P1 : 1 validé, 1 non validé → 50 ; P2 : tout NA → sans taux. Moyenne = 50 (et non 25).
		const r = complete(build([[P1], [P2]], { "1.1": ["C", "NA"], "1.2": ["NC", "NA"] }), ["1.1", "1.2"]);
		expect(r.pages[1]).toEqual({ pageId: P2, validated: 0, invalidated: 0, notApplicable: 2, rate: null });
		expect(r.averageRate).toBe(5000);
	});

	it("tout NA partout : ni taux global ni taux moyen", () => {
		const r = complete(build([[P1]], { "1.1": ["NA"] }), ["1.1"]);
		expect(r.globalRate).toBeNull();
		expect(r.averageRate).toBeNull();
	});

	it("processus de 2 pages, C sur l'une et NC sur l'autre : non validé sur les deux pages", () => {
		const r = complete(
			build(
				[
					[P1, "Commande"],
					[P2, "Commande"],
				],
				{ "1.1": ["C", "NC"], "1.2": ["C", "C"] },
			),
			["1.1", "1.2"],
		);
		// Chaque page : 1.2 validé, 1.1 non validé → 1 ÷ 2 = 50.
		expect(r.pages.map((p) => [p.validated, p.invalidated, p.rate])).toEqual([
			[1, 1, 5000],
			[1, 1, 5000],
		]);
	});

	it("hors processus, la même saisie laisse la page conforme à 100", () => {
		const r = complete(build([[P1], [P2]], { "1.1": ["C", "NC"], "1.2": ["C", "C"] }), ["1.1", "1.2"]);
		expect(r.pages.map((p) => p.rate)).toEqual([10000, 5000]);
	});

	it("nom de processus comparé sans tenir compte des espaces autour ni de la casse ; vide = aucun processus", () => {
		const same = complete(
			build(
				[
					[P1, " commande "],
					[P2, "Commande"],
				],
				{ "1.1": ["C", "NC"] },
			),
			["1.1"],
		);
		expect(same.pages[0]?.rate).toBe(0);
		const none = complete(
			build(
				[
					[P1, " "],
					[P2, ""],
				],
				{ "1.1": ["C", "NC"] },
			),
			["1.1"],
		);
		expect(none.pages[0]?.rate).toBe(10000);
	});

	it("nom de processus normalisé : NFC, espaces internes réduits, casse", () => {
		expect(processKey("Prise  de rdv")).toBe(processKey("Prise de rdv"));
		expect(processKey(" Prise\tde\u00a0RDV ")).toBe("prise de rdv");
		const nfd = "Cafe\u0301";
		const nfc = "Caf\u00e9";
		expect(nfd).not.toBe(nfc);
		expect(processKey(nfd)).toBe(processKey(nfc));
		expect(processKey("  ")).toBeNull();
		// Bout en bout : « Café » NFD et NFC forment un seul processus, donc le NC de P2 invalide P1.
		const r = complete(
			build(
				[
					[P1, nfd],
					[P2, nfc],
				],
				{ "1.1": ["C", "NC"] },
			),
			["1.1"],
		);
		expect(r.pages[0]?.rate).toBe(0);
	});

	it("processus : une page NA n'invalide pas les autres et reste NA (interprétation ADR-0015)", () => {
		// P1 : C, P2 : NA, P3 : NC (hors processus). Dans « Commande », aucune page n'invalide 1.1.
		const r = complete(build([[P1, "Commande"], [P2, "Commande"], [P3]], { "1.1": ["C", "NA", "NC"] }), ["1.1"]);
		expect(r.pages.map((p) => [p.validated, p.invalidated, p.notApplicable])).toEqual([
			[1, 0, 0],
			[0, 0, 1],
			[0, 1, 0],
		]);
	});

	it("NT restant : incomplet, aucun taux", () => {
		const r = computeConformity(build([[P1], [P2]], { "1.1": ["C", "C"], "1.2": ["C"] }), ["1.1", "1.2"]);
		expect(r).toEqual({ complete: false, remaining: 1, toConfirm: 0 });
	});

	it("statut automatique à confirmer : incomplet, même s'il n'y a plus de NT", () => {
		let s = build([[P1]], { "1.1": ["C"] });
		s = setEvaluation(s, "1.2", P1, { status: "NC", note: "Détecté automatiquement", source: "auto" }, NOW);
		expect(computeConformity(s, ["1.1", "1.2"])).toEqual({ complete: false, remaining: 0, toConfirm: 1 });
	});

	it("taux moyen exact : moyenne des fractions, pas des taux arrondis (cas du relecteur) → 56,18 %", () => {
		// [validés, applicables] par page ; chaque page : v critères C, a - v critères NC, le reste NA.
		const pages: [number, number][] = [
			[53, 64],
			[51, 79],
			[20, 47],
			[9, 72],
			[36, 49],
			[7, 53],
			[54, 58],
			[45, 76],
			[13, 91],
			[66, 105],
			[47, 63],
			[90, 92],
			[14, 41],
			[45, 74],
			[18, 104],
			[91, 95],
		];
		const ids = Array.from({ length: 106 }, (_, i) => `${Math.floor(i / 99) + 1}.${(i % 99) + 1}`);
		const page = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
		const statuses: Record<string, Status[]> = {};
		ids.forEach((id, k) => {
			statuses[id] = pages.map(([v, a]) => (k < v ? "C" : k < a ? "NC" : "NA"));
		});
		const r = complete(
			build(
				pages.map((_, i) => [page(i)]),
				statuses,
			),
			ids,
		);
		expect(r.pages.map((p) => [p.validated, p.validated + p.invalidated])).toEqual(pages);
		expect(formatRate(r.averageRate ?? -1)).toBe("56,18\u202f%");
	});

	it("0 page : incomplet", () => {
		expect(computeConformity(createSession(NOW), ["1.1"])).toEqual({ complete: false, remaining: 0, toConfirm: 0 });
	});

	it("exemple complet calculé à la main : 3 pages × 4 critères, avec un processus", () => {
		// Pages : P1 Accueil (sans processus), P2 Panier et P3 Paiement (processus « Commande »).
		//          P1   P2   P3
		//   1.1    C    C    NC   → P2 non validé par la règle du processus ; échantillon : non validé
		//   3.2    C    C    C    → validé
		//   8.3    NC   NA   C    → P3 reste validé (P2 NA n'invalide pas) ; échantillon : non validé
		//   11.1   NA   NA   NA   → non applicable
		// P1 : V = 1.1, 3.2 (2) ; NV = 8.3 (1) ; NA = 11.1 (1) → 2/3 = 66,666… %
		// P2 : V = 3.2 (1) ; NV = 1.1 (1) ; NA = 8.3, 11.1 (2) → 1/2 = 50 %
		// P3 : V = 3.2, 8.3 (2) ; NV = 1.1 (1) ; NA = 11.1 (1) → 2/3 = 66,666… %
		// Global : 1 validé (3.2) ÷ 3 applicables (1.1, 3.2, 8.3) = 33,333… %
		// Moyen : (66,666… + 50 + 66,666…) ÷ 3 = 183,333… ÷ 3 = 61,111… %
		const s = build([[P1], [P2, "Commande"], [P3, "Commande"]], {
			"1.1": ["C", "C", "NC"],
			"3.2": ["C", "C", "C"],
			"8.3": ["NC", "NA", "C"],
			"11.1": ["NA", "NA", "NA"],
		});
		const r = complete(s, ["1.1", "3.2", "8.3", "11.1"]);
		expect(r.pages.map((p) => [p.validated, p.invalidated, p.notApplicable, formatRate(p.rate ?? -1)])).toEqual([
			[2, 1, 1, "66,66\u202f%"],
			[1, 1, 2, "50\u202f%"],
			[2, 1, 1, "66,66\u202f%"],
		]);
		expect(r.criteria.map((c) => c.status)).toEqual(["non validé", "validé", "non validé", "non applicable"]);
		expect(r).toMatchObject({ validated: 1, invalidated: 2, notApplicable: 1, applicable: 3 });
		expect(formatRate(r.globalRate ?? -1)).toBe("33,33\u202f%");
		expect(formatRate(r.averageRate ?? -1)).toBe("61,11\u202f%");
	});
});

describe("floorHundredths / formatRate : arrondi exact, sans flottant", () => {
	it("format : virgule, zéros finaux retirés, espace fine insécable U+202F", () => {
		expect(formatRate(9999)).toBe("99,99\u202f%");
		expect(formatRate(10000)).toBe("100\u202f%");
		expect(formatRate(0)).toBe("0\u202f%");
		expect(formatRate(1250)).toBe("12,5\u202f%");
		expect(formatRate(2905)).toBe("29,05\u202f%");
	});

	it("99,996 % reste 99,99 % ; 0,29 donne 29 %", () => {
		// 24999 ÷ 25000 = 0,99996 → 99,996 % → plancher 99,99.
		expect(formatRate(floorHundredths(24999, 25000))).toBe("99,99\u202f%");
		// 29 ÷ 100 : en flottant, 0.29 * 100 = 28.999999999999996 ; ici, exactement 2900 centièmes.
		expect(formatRate(floorHundredths(29, 100))).toBe("29\u202f%");
	});

	it("toutes les fractions v/a, a ≤ 106 : plancher exact (h·a ≤ 10000·v < (h+1)·a) et affichage fidèle", () => {
		for (let a = 1; a <= 106; a++)
			for (let v = 0; v <= a; v++) {
				const h = floorHundredths(v, a);
				expect(Number.isInteger(h) && h * a <= v * 10000 && v * 10000 < (h + 1) * a, `${v}/${a}`).toBe(true);
				const [int = "", dec = ""] = formatRate(h).replace("\u202f%", "").split(",");
				expect(Number(int) * 100 + Number(dec.padEnd(2, "0")), `${v}/${a}`).toBe(h);
			}
	});

	it("moyenne exacte : plancher de la vraie moyenne", () => {
		// (2/3 + 1/2 + 2/3) ÷ 3 = 11/18 = 0,61111… → 6111 ; 1/3 seul → 3333 ; aucune page applicable n'arrive ici.
		expect(
			floorAverageHundredths([
				[2, 3],
				[1, 2],
				[2, 3],
			]),
		).toBe(6111);
		expect(floorAverageHundredths([[1, 3]])).toBe(3333);
		expect(
			floorAverageHundredths([
				[0, 5],
				[5, 5],
			]),
		).toBe(5000);
	});
});
