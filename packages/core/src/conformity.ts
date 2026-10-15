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
	/** validés ÷ (validés + non validés) × 100 ; `null` si aucun critère n'est applicable sur la page. */
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
			/** Pourcentage de critères respectés : validés ÷ applicables × 100 ; `null` si aucun n'est applicable. */
			globalRate: number | null;
			/** Moyenne des taux des pages qui en ont un ; `null` si aucune page n'en a. */
			averageRate: number | null;
	  };

/** Nom de processus comparable : « Commande », « commande » et « Commande  » désignent le même parcours. */
const processKey = (process: string | undefined) => process?.trim().toLowerCase() || null;

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
	for (const p of pages) {
		const applicable = p.validated + p.invalidated;
		// Multiplier avant de diviser : 29 × 100 ÷ 100 = 29 tout juste, alors que 29 ÷ 100 × 100 = 28,999…
		p.rate = applicable > 0 ? (p.validated * 100) / applicable : null;
	}
	const count = (s: CriterionResult) => criteria.filter((c) => c.status === s).length;
	const validated = count("validé");
	const invalidated = count("non validé");
	const applicable = validated + invalidated;
	const rates = pages.flatMap((p) => (p.rate === null ? [] : [p.rate]));
	return {
		complete: true,
		pages,
		criteria,
		validated,
		invalidated,
		notApplicable: count("non applicable"),
		applicable,
		globalRate: applicable > 0 ? (validated * 100) / applicable : null,
		averageRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
	};
}

/**
 * Affichage d'un taux (ADR-0015 §1) : deux décimales VERS LE BAS (99,996 ne devient jamais « 100 % »), virgule
 * décimale, espace insécable avant « % ». La tolérance (1e-9 centième, soit 1e-11 point) corrige l'erreur binaire (28,999999999999996 pour
 * 29). Un taux de page ou global est une fraction de dénominateur ≤ 106 : s'il n'est pas sur une borne, il en est à
 * plus de 1e-4 point. Pour le taux moyen, un écart réel de moins de 1e-11 point sous une borne serait arrondi au-dessus.
 */
export const formatRate = (rate: number) => `${String(Math.floor(rate * 100 + 1e-9) / 100).replace(".", ",")} %`;
