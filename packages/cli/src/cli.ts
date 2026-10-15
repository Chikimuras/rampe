#!/usr/bin/env node
// Point d'entrée `rampe` (ADR-0011). Exécuté tel quel par Node ≥ 22.18 (suppression native des types).
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { criteriaWithDirectRule, rgaa } from "@rampe/core";
import axe from "axe-core";
import { type Browser, chromium } from "playwright";
import {
	type AuditPage,
	type AxeRawResult,
	buildReport,
	classifyResults,
	formatReport,
	parseAuditUrl,
	redact,
	stripControl,
} from "./audit.ts";

const USAGE = `Usage : rampe audit <url> [--json <fichier>] [--timeout <ms>]

  <url>              page à auditer (http:// ou https://)
  --json <fichier>   écrit aussi le résultat détaillé en JSON
  --timeout <ms>     durée maximale de l’audit : chargement, injection et analyse (défaut : 60000)

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
	const timeout = Number(values.timeout ?? 60_000);
	if (!Number.isInteger(timeout) || timeout <= 0)
		throw new Error("--timeout attend un nombre entier de millisecondes.");
	return { url: parseAuditUrl(target), json: values.json, timeout };
}

const isHttp = (href: string) => /^https?:$/.test(new URL(href).protocol);

/** Charge la page et lance axe-core. Peut être interrompu à tout moment par la fermeture du navigateur. */
async function inspect(browser: Browser, url: URL, timeout: number): Promise<AuditPage> {
	const page = await browser.newPage();
	await page.goto(url.href, { waitUntil: "load", timeout });
	// Réseau calme : laisse aux scripts le temps de rendre, sans bloquer sur une page qui interroge en continu.
	await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5_000) }).catch(() => {});
	// La page a pu naviguer d'elle-même (about:blank, data:…) : on n'audite que du http(s) (ADR-0011 §6).
	if (!isHttp(page.url())) throw new Error(`la page a quitté le web (http/https) : ${page.url()}`);
	// Injection par le protocole de débogage : non soumise à la CSP de la page, sans la désactiver.
	await page.evaluate(axe.source);
	// Configuration par défaut d'axe.run (sans règles expérimentales).
	// ponytail: cadre principal seulement ; les iframes demanderont une injection par cadre.
	const raw = await page.evaluate(async () => {
		const r = await (window as unknown as { axe: typeof axe }).axe.run();
		return { violations: r.violations, incomplete: r.incomplete };
	});
	const finalUrl = page.url();
	if (!isHttp(finalUrl)) throw new Error(`la page a quitté le web (http/https) : ${finalUrl}`);
	const warnings =
		new URL(finalUrl).origin === url.origin
			? []
			: [`La page finale est sur une autre origine que celle demandée : ${redact(finalUrl)}`];
	return {
		url: redact(url.href),
		finalUrl: redact(finalUrl),
		title: await page.title(),
		warnings,
		results: classifyResults(raw.violations as AxeRawResult[], raw.incomplete as AxeRawResult[]),
	};
}

async function audit({ url, json, timeout }: ReturnType<typeof parseCli>): Promise<number> {
	const startedAt = new Date();
	// Bac à sable de Chromium conservé : Playwright le désactive par défaut, on le réactive (ADR-0011 §6).
	const browser = await chromium.launch({ chromiumSandbox: true });
	let timer: NodeJS.Timeout | undefined;
	try {
		// Délai global : une page qui bloque son fil principal (boucle infinie) bloquerait aussi axe.run.
		const work = inspect(browser, url, timeout);
		work.catch(() => {}); // rejet attendu après la fermeture du navigateur en cas de dépassement
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`audit interrompu après ${timeout} ms (option --timeout).`)), timeout);
		});
		const auditPage = await Promise.race([work, deadline]);
		for (const w of auditPage.warnings) console.error(`Avertissement : ${stripControl(w)}`);

		console.log(
			formatReport(auditPage, rgaa.criteria.length - criteriaWithDirectRule(axe.getRules().map((r) => r.tags)).size),
		);

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
		clearTimeout(timer);
		await browser.close();
	}
}

let options: ReturnType<typeof parseCli>;
try {
	options = parseCli(process.argv.slice(2));
} catch (e) {
	console.error(`${redact((e as Error).message)}\n\n${USAGE}`);
	process.exit(2);
}
try {
	process.exitCode = await audit(options);
} catch (e) {
	console.error(
		`Erreur : ${redact((e as Error).message)
			.split("\n")
			.map(stripControl)
			.join("\n")}`,
	);
	process.exitCode = 2;
}
