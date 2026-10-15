// Règles axe-core rattachées à chaque critère RGAA (ADR-0008), calculées au build.
// Module serveur : axe-core n'est jamais envoyé au navigateur (ADR-0010 §4).
import { classifyAxeRule } from "@rampe/core";
import axe from "axe-core";

export interface CriterionRule {
	ruleId: string;
	description: string;
	/** `rgaa` : étiquette RGAA native ; `wcag` : rattachement indirect via WCAG. */
	level: "rgaa" | "wcag";
	bestPractice: boolean;
	experimental: boolean;
}

export const axeVersion = axe.version;

const byCriterion = new Map<string, CriterionRule[]>();
for (const rule of axe.getRules()) {
	const m = classifyAxeRule(rule.tags);
	if (m.level === "hors-rgaa") continue;
	for (const id of m.criteria) {
		const list = byCriterion.get(id) ?? [];
		list.push({
			ruleId: rule.ruleId,
			description: rule.description,
			level: m.level,
			bestPractice: m.bestPractice,
			experimental: m.experimental,
		});
		byCriterion.set(id, list);
	}
}
for (const list of byCriterion.values())
	list.sort((a, b) => a.level.localeCompare(b.level) || a.ruleId.localeCompare(b.ruleId));

/** Règles du critère, rattachements directs (`rgaa`) d'abord. */
export const rulesFor = (criterionId: string): CriterionRule[] => byCriterion.get(criterionId) ?? [];
