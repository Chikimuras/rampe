// Auto-évaluation de Rampe par une IA (ADR-0021 §2), lancée par `pnpm auto-evaluation`.
// Lit l'échantillon (docs/audit-rampe/echantillon.txt) et les fragments (docs/audit-rampe/evaluations/<n>.json, une
// thématique RGAA par fichier), les valide strictement (@rampe/core, auto-evaluation.ts), construit la session et
// l'écrit dans docs/audit-rampe/session.json (format de l'ADR-0016, importable dans l'audit guidé). Affiche
// l'avancement, et le taux (ADR-0015) seulement quand l'auto-évaluation est complète.
// `--verifier` (CI) : n'écrit rien, et échoue si session.json n'est pas celui que les fragments produisent.
// Format des fragments et règles d'évaluation : docs/audit-rampe/README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseSessionStrict, progress } from "../packages/core/src/audit-session.ts";
import { buildAutoSession, parseFragment, serializeAutoSession } from "../packages/core/src/auto-evaluation.ts";
import { computeConformity, formatRate } from "../packages/core/src/conformity.ts";
import { baseCriteria, topics } from "../packages/core/src/criteres.ts";
import { parseSampleFile } from "../packages/core/src/sample-file.ts";
import { ReportError } from "../packages/core/src/strict.ts";

const dir = fileURLToPath(new URL("../docs/audit-rampe/", import.meta.url));
const evaluations = join(dir, "evaluations");
const output = join(dir, "session.json");
const verify = process.argv.includes("--verifier");

try {
	const sample = parseSampleFile(readFileSync(join(dir, "echantillon.txt"), "utf8")).urls.map((u) => u.href);
	const names = existsSync(evaluations) ? readdirSync(evaluations).sort() : [];
	const fragments = names.map((name) => {
		const topic = topics.find((t) => name === `${t.number}.json`)?.number;
		if (topic === undefined) throw new Error(`${name} : fichier inattendu (attendu : <thématique 1 à 13>.json)`);
		try {
			return parseFragment(JSON.parse(readFileSync(join(evaluations, name), "utf8")), topic, sample);
		} catch (e) {
			throw new Error(`${name} : ${e instanceof ReportError ? `${e.message} ${e.detail ?? ""}` : e.message}`);
		}
	});
	const session = await buildAutoSession(sample, fragments);
	const text = serializeAutoSession(session);
	// Garde-fou : le fichier publié se réimporte dans l'audit guidé sans perte (ADR-0016 §2).
	const known = new Set(baseCriteria.map((c) => c.id));
	if (!isDeepStrictEqual(parseSessionStrict(JSON.parse(text), known), session))
		throw new Error("la session construite ne se réimporte pas à l’identique");

	const { total } = progress(session, baseCriteria);
	console.log(`Auto-évaluation : ${total.total - total.remaining} évaluations sur ${total.total}.`);
	const conformity = computeConformity(session, [...known]);
	if (conformity.complete)
		console.log(
			`Taux global : ${conformity.globalRate === null ? "sans objet" : formatRate(conformity.globalRate)} ; taux moyen : ${conformity.averageRate === null ? "sans objet" : formatRate(conformity.averageRate)}.`,
		);

	if (verify) {
		const current = existsSync(output) ? readFileSync(output, "utf8") : "";
		if (current !== text) {
			console.error(`${output} n’est pas à jour : lancez \`pnpm auto-evaluation\` puis committez-le.`);
			process.exit(1);
		}
		console.log(`${output} est à jour.`);
	} else {
		writeFileSync(output, text);
		console.log(`Écrit : ${output}`);
	}
} catch (e) {
	console.error(`Auto-évaluation : ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}
