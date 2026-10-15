// Génère les fixtures de non-régression de la relecture du stockage local (ADR-0016) : des sessions aux valeurs
// limites, écrites par le code TEL QU'IL ÉTAIT avant les bornes. Ne pas régénérer avec le code courant.
//
//   T=$(mktemp -d); mkdir $T/main $T/v1
//   for f in audit-session audit-report sample-file axe; do git show 58a7058:packages/core/src/$f.ts > $T/main/$f.ts; done
//   for f in audit-session sample-file; do git show 3591df6:packages/core/src/$f.ts > $T/v1/$f.ts; done
//   cp packages/core/test/fixtures/generer-sessions-limites.mjs $T/ && node $T/generer-sessions-limites.mjs packages/core/test/fixtures
//
// 58a7058 : main avant l'export/import (session v2) ; 3591df6 : première version de l'audit guidé (session v1).
import { writeFileSync } from "node:fs";

const out = process.argv[2];
const main = await import("./main/audit-session.ts");
const report = await import("./main/audit-report.ts");
const v1 = await import("./v1/audit-session.ts");
const AT = "2026-10-14T09:30:00.000Z";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const longUrl = `https://exemple.fr/${"chemin/".repeat(428)}fin`; // 3 000 caractères
const title = `\tAccueil « ${"titre très long ".repeat(124)}» `; // ≈ 2 000, tabulation et espace en bord
const note = `Ligne 1\n\tLigne 2 ${"n".repeat(12_000)}`; // 12 000 et plus
const processName = `Commande ${"p".repeat(491)} `; // 500 caractères, espace final en cours de frappe
console.log(longUrl.length, title.length, note.length, processName.length);

let s = main.createSession(AT);
s = main.addPage(s, { url: longUrl, title }, AT, A);
s = main.addPage(s, { url: "https://exemple.fr/contact", title: "Contact" }, AT, B);
s = main.setPageProcess(s, A, processName, AT);
s = main.setPageProcess(s, B, processName, AT);
s = main.setEvaluation(s, "1.1", A, { status: "NC", note }, AT);
s = main.setEvaluation(s, "3.2", B, { status: "C", note: "ok" }, AT);
const r = (ruleId, kind, criteria) => ({
	ruleId,
	help: `Help ${ruleId}`,
	kind,
	level: "rgaa",
	tests: [],
	criteria,
	wcag: [],
	flags: { bestPractice: false, experimental: false },
	impact: "serious",
	nodes: [{ target: ["img"], html: "<img>", failureSummary: null }],
});
const rep = report.parseAuditReport(
	{
		schemaVersion: 2,
		tool: { name: "@rampe/cli", version: "0.0.0" },
		engine: {},
		startedAt: AT,
		pages: [
			{
				url: "https://exemple.fr/contact",
				finalUrl: null,
				title: "Contact",
				warnings: [],
				error: null,
				results: [r("image-alt", "non-conformite", ["1.1"]), r("region", "bonne-pratique", ["12.6"])],
			},
		],
	},
	new Set(["1.1", "12.6"]),
);
s = report.importAutomaticResults(s, rep, AT).session;
writeFileSync(`${out}/session-main-v2-limites.json`, JSON.stringify(s));

let o = v1.createSession(AT);
o = v1.addPage(o, { url: longUrl, title }, AT, A);
o = v1.setEvaluation(o, "1.1", A, { status: "NC", note }, AT);
o = v1.setEvaluation(o, "2.1", A, { status: "NA", note: "" }, AT);
writeFileSync(`${out}/session-v1-limites.json`, JSON.stringify(o));
