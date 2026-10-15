// Taux de conformité (ADR-0015) : la formule de la méthode RGAA, à la lettre, sans aucun arrondi dans le calcul.
// Source : DISIC/accessibilite.numerique.gouv.fr, src/obligations/evaluation-conformite.md, sections « Test des pages »
// et « Taux de conformité à la norme ». Pur et sans données : l'îlot de /audit/ l'importe.
import { type AuditSession, getEvaluation, type Status } from "./audit-session.ts";

export type CriterionResult = "validé" | "non validé" | "non applicable";

export interface PageConformity {
	pageId: string;
	validated: number;
	invalidated: number;
	notApplicable: number;
	/** Plancher de validés ÷ (validés + non validés), en centièmes de point (5618 = 56,18 %) ; `null` sans critère applicable. */
	rate: number | null;
}

export type Conformity =
	| {
			/** ADR-0015 §2-3 : aucun taux tant qu'il reste du « non testé », un statut à confirmer, ou sans page. */
			complete: false;
			remaining: number;
			toConfirm: number;
	  }
	| {
			complete: true;
			pages: PageConformity[];
			criteria: { criterion: string; status: CriterionResult }[];
			validated: number;
			invalidated: number;
			notApplicable: number;
			/** validés + non validés : applicables sur au moins une page. */
			applicable: number;
			/** Pourcentage de critères respectés, validés ÷ applicables, en centièmes (plancher exact) ; `null` sans applicable. */
			globalRate: number | null;
			/**
			 * Moyenne des taux EXACTS des pages qui en ont un (pas de leurs planchers), en centièmes (plancher exact) ;
			 * `null` si aucune page n'en a.
			 */
			averageRate: number | null;
	  };

/**
 * Nom de processus comparable : « Commande », « commande », « Prise  de rdv » / « Prise de rdv », ou « Café » saisi
 * décomposé (NFD) ou composé (NFC), désignent le même parcours. `null` : aucun processus.
 */
export const processKey = (process: string | undefined) =>
	process?.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase() || null;

/**
 * Taux exacts (ADR-0015 §1) : aucun flottant. Plancher de `10000 × v ÷ a` en centièmes de point, en entiers : ici
 * `v ≤ a ≤ 106`, tout reste très loin de 2^53.
 */
export const floorHundredths = (v: number, a: number) => (v * 10000 - ((v * 10000) % a)) / a;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * Plancher exact de la moyenne des fractions `v/a`, en centièmes : somme rationnelle en BigInt (réduite à chaque pas,
 * le dénominateur reste un diviseur du PPCM de 1…106), puis `⌊10000 × Σ ÷ N⌋`.
 */
export function floorAverageHundredths(fractions: readonly [v: number, a: number][]): number {
	let num = 0n;
	let den = 1n;
	for (const [v, a] of fractions) {
		num = num * BigInt(a) + BigInt(v) * den;
		den *= BigInt(a);
		const g = gcd(num, den);
		num /= g;
		den /= g;
	}
	return Number((10000n * num) / (den * BigInt(fractions.length)));
}

export function computeConformity(session: AuditSession, criterionIds: readonly string[]): Conformity {
	let remaining = 0;
	let toConfirm = 0;
	for (const c of criterionIds)
		for (const p of session.pages) {
			const e = getEvaluation(session, c, p.id);
			if (e.status === "NT") remaining++;
			if (e.source === "auto") toConfirm++;
		}
	if (session.pages.length === 0 || remaining > 0 || toConfirm > 0) return { complete: false, remaining, toConfirm };

	const pages: PageConformity[] = session.pages.map((p) => ({
		pageId: p.id,
		validated: 0,
		invalidated: 0,
		notApplicable: 0,
		rate: null,
	}));
	const criteria: { criterion: string; status: CriterionResult }[] = [];
	for (const c of criterionIds) {
		const statuses = session.pages.map((p) => getEvaluation(session, c, p.id).status);
		// Processus dont au moins une page invalide le critère.
		const failing = new Set(session.pages.filter((_, i) => statuses[i] === "NC").map((p) => processKey(p.process)));
		session.pages.forEach((p, i) => {
			const key = processKey(p.process);
			let status = statuses[i] as Status;
			// « Un critère est validé pour une page du processus uniquement s'il est validé pour toutes les pages du
			// processus. » Interprétation (ADR-0015) : une page NA du processus n'invalide pas les autres (elle n'a pas
			// le contenu visé, rien n'y est invalidé), et reste elle-même NA (le critère ne s'applique pas à son
			// contenu). C'est la même lecture que pour l'échantillon, où un critère est validé s'il n'est invalidé
			// sur aucune page, NA ne comptant pas comme invalidation.
			if (status === "C" && key !== null && failing.has(key)) status = "NC";
			const page = pages[i] as PageConformity;
			if (status === "C") page.validated++;
			else if (status === "NC") page.invalidated++;
			else page.notApplicable++;
		});
		criteria.push({
			criterion: c,
			status: statuses.includes("NC") ? "non validé" : statuses.includes("C") ? "validé" : "non applicable",
		});
	}
	const fractions: [number, number][] = [];
	for (const p of pages) {
		const applicable = p.validated + p.invalidated;
		if (applicable === 0) continue;
		p.rate = floorHundredths(p.validated, applicable);
		fractions.push([p.validated, applicable]);
	}
	const count = (s: CriterionResult) => criteria.filter((c) => c.status === s).length;
	const validated = count("validé");
	const invalidated = count("non validé");
	const applicable = validated + invalidated;
	return {
		complete: true,
		pages,
		criteria,
		validated,
		invalidated,
		notApplicable: count("non applicable"),
		applicable,
		globalRate: applicable > 0 ? floorHundredths(validated, applicable) : null,
		averageRate: fractions.length > 0 ? floorAverageHundredths(fractions) : null,
	};
}

/**
 * Affichage d'un taux reçu en centièmes ENTIERS (déjà arrondis vers le bas : 99,996 ne devient jamais « 100 % ») :
 * virgule décimale, zéros finaux retirés, espace fine insécable (U+202F) avant « % », comme le référentiel.
 */
export function formatRate(hundredths: number): string {
	const cents = hundredths % 100;
	const decimals = cents === 0 ? "" : `,${String(cents).padStart(2, "0").replace(/0$/, "")}`;
	return `${(hundredths - cents) / 100}${decimals}\u202f%`;
}
