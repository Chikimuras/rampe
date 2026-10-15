// Règles axe-core rattachées à chaque critère RGAA (ADR-0008), calculées au build.
// Module serveur : axe-core n'est jamais envoyé au navigateur (ADR-0010 §4).
import { classifyAxeRule, getCriterion, isDirectCheck } from "@rampe/core";
import axe from "axe-core";

interface RuleBase {
	ruleId: string;
	description: string;
	bestPractice: boolean;
	experimental: boolean;
}
/** Règle qui cite un test de ce critère (étiquette `RGAA-x.y.z`). */
export interface DirectRule extends RuleBase {
	tests: string[];
}
/** Règle liée au critère seulement via un critère de succès WCAG commun : signal faible. */
export interface IndirectRule extends RuleBase {
	wcag: string[];
}
export interface CriterionRules {
	/** Vérifications directes (`isDirectCheck`) : seules à compter comme « couverture ». */
	direct: DirectRule[];
	/** Citent un test du critère, mais bonnes pratiques ou expérimentales chez axe : à confirmer par un humain. */
	unconfirmed: DirectRule[];
	indirect: IndirectRule[];
}

export const axeVersion = axe.version;

const byCriterion = new Map<string, CriterionRules>();
const entry = (id: string) => {
	let e = byCriterion.get(id);
	if (!e) {
		e = { direct: [], unconfirmed: [], indirect: [] };
		byCriterion.set(id, e);
	}
	return e;
};

for (const rule of axe.getRules()) {
	const m = classifyAxeRule(rule.tags);
	// Règle dépréciée : vouée à disparaître, on ne la présente pas comme une vérification.
	if (m.level === "hors-rgaa" || m.deprecated) continue;
	const base = {
		ruleId: rule.ruleId,
		description: rule.description,
		bestPractice: m.bestPractice,
		experimental: m.experimental,
	};
	for (const id of m.criteria) {
		if (m.level === "rgaa")
			entry(id)[isDirectCheck(m) ? "direct" : "unconfirmed"].push({
				...base,
				tests: m.tests.filter((t) => t.startsWith(`${id}.`)),
			});
		else {
			const own = new Set(getCriterion(id)?.wcag.map((w) => w.sc));
			entry(id).indirect.push({ ...base, wcag: m.wcag.filter((sc) => own.has(sc)) });
		}
	}
}

const byId = (a: RuleBase, b: RuleBase) => a.ruleId.localeCompare(b.ruleId);
for (const e of byCriterion.values()) {
	e.direct.sort(byId);
	e.unconfirmed.sort(byId);
	e.indirect.sort(byId);
}

export const rulesFor = (criterionId: string): CriterionRules =>
	byCriterion.get(criterionId) ?? { direct: [], unconfirmed: [], indirect: [] };
