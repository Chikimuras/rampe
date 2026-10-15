#!/usr/bin/env node
// Point d'entrée `rampe` (ADR-0011). Exécuté tel quel par Node ≥ 22.18 (suppression native des types).
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { criteriaWithDirectRule, rgaa } from "@rampe/core";
import axe from "axe-core";
import { chromium } from "playwright";
import { type AxeRawResult, buildReport, classifyResults, formatReport, parseAuditUrl } from "./audit.ts";

const USAGE = `Usage : rampe audit <url> [--json <fichier>] [--timeout <ms>]

  <url>              page à auditer (http:// ou https://)
  --json <fichier>   écrit aussi le résultat détaillé en JSON
  --timeout <ms>     délai maximal de chargement de la page (défaut : 30000)

Codes de sortie : 0 aucune non-conformité détectée, 1 non-conformité(s) détectée(s), 2 erreur.`;

function parseCli(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { json: { type: "string" }, timeout: { type: "string" }, help: { type: "boolean", short: "h" } },
	});
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const [command, target, ...rest] = positionals;
	if (command !== "audit" || !target || rest.length > 0) throw new Error("Commande attendue : rampe audit <url>");
	const timeout = Number(values.timeout ?? 30_000);
	if (!Number.isInteger(timeout) || timeout <= 0)
		throw new Error("--timeout attend un nombre entier de millisecondes.");
	return { url: parseAuditUrl(target), json: values.json, timeout };
}

async function audit({ url, json, timeout }: ReturnType<typeof parseCli>): Promise<number> {
	const startedAt = new Date();
	// Bac à sable de Chromium conservé : Playwright le désactive par défaut, on le réactive (ADR-0011 §6).
	const browser = await chromium.launch({ chromiumSandbox: true });
	try {
		// bypassCSP : sinon la politique de sécurité d'une page peut bloquer l'injection d'axe-core.
		const page = await browser.newPage({ bypassCSP: true });
		await page.goto(url.href, { waitUntil: "load", timeout });
		// Réseau calme : laisse aux scripts le temps de rendre, sans bloquer sur une page qui interroge en continu.
		await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5_000) }).catch(() => {});
		await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core/axe.min.js") });
		// Configuration par défaut d'axe.run (sans règles expérimentales).
		// ponytail: cadre principal seulement ; les iframes demanderont une injection par cadre.
		const raw = await page.evaluate(async () => {
			const r = await (window as unknown as { axe: typeof axe }).axe.run();
			return { violations: r.violations, incomplete: r.incomplete };
		});
		const auditPage = {
			url: url.href,
			finalUrl: page.url(),
			title: await page.title(),
			results: classifyResults(raw.violations as AxeRawResult[], raw.incomplete as AxeRawResult[]),
		};

		// Critères sans vérification directe parmi les règles réellement exécutées (pas les expérimentales).
		const covered = criteriaWithDirectRule(
			axe
				.getRules()
				.map((r) => r.tags)
				.filter((t) => !t.includes("experimental")),
		);
		console.log(formatReport(auditPage, rgaa.criteria.length - covered.size));

		if (json) {
			const report = buildReport({
				startedAt,
				axeVersion: axe.version,
				browserVersion: browser.version(),
				pages: [auditPage],
			});
			await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
			console.log(`\nRésultat JSON écrit dans ${json}`);
		}
		return auditPage.results.some((r) => r.kind === "non-conformite") ? 1 : 0;
	} finally {
		await browser.close();
	}
}

let options: ReturnType<typeof parseCli>;
try {
	options = parseCli(process.argv.slice(2));
} catch (e) {
	console.error(`${(e as Error).message}\n\n${USAGE}`);
	process.exit(2);
}
try {
	process.exitCode = await audit(options);
} catch (e) {
	console.error(`Erreur : ${(e as Error).message}`);
	process.exitCode = 2;
}
