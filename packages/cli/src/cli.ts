#!/usr/bin/env node
// Point d'entrée `rampe` (ADR-0011, ADR-0012). Exécuté tel quel par Node ≥ 22.18 (suppression native des types).
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { criteriaWithDirectRule, rgaa } from "@rampe/core";
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
import {
	type AuditPage,
	type AxeRawResult,
	buildReport,
	classifyResults,
	formatPage,
	formatReport,
	formatSynthesis,
	parseAuditUrl,
	redact,
	stripControl,
} from "./audit.ts";
import {
	type Collected,
	formatSampleFile,
	formatSampleSummary,
	parseSampleFile,
	proposeSample,
	type RawLink,
	type RawSearch,
} from "./echantillon.ts";

const USAGE = `Usage :
  rampe audit <url> [--json <fichier>] [--timeout <ms>]
  rampe audit --echantillon <fichier> [--json <fichier>] [--timeout <ms>]
  rampe echantillon <url> [--sortie <fichier>] [--max <n>] [--graine <n>] [--timeout <ms>]

audit
  <url>                  page à auditer (http:// ou https://)
  --echantillon <fich.>  audite une à une les pages d’un fichier d’échantillon (voir rampe echantillon)
  --json <fichier>       écrit aussi le résultat détaillé en JSON
  --timeout <ms>         durée maximale de l’audit d’une page : chargement, injection et analyse (défaut : 60000)

echantillon : propose un échantillon de pages selon la méthode RGAA, à relire et modifier
  <url>                  page d’accueil du site
  --sortie <fichier>     fichier à écrire, jamais écrasé (défaut : echantillon.txt)
  --max <n>              nombre maximal de pages proposées (défaut : 50)
  --graine <n>           graine du tirage au hasard, pour rejouer le même échantillon
  --timeout <ms>         durée maximale du chargement de l’accueil (défaut : 60000)

Codes de sortie : 0 aucune non-conformité détectée, 1 non-conformité(s) détectée(s), 2 erreur
(avec --echantillon : 2 dès qu’une page est en erreur, les autres pages étant quand même auditées).`;

function integer(value: string | undefined, fallback: number, option: string, min: number, max: number): number {
	const n = Number(value ?? fallback);
	if (!Number.isInteger(n) || n < min || n > max)
		throw new Error(`${option} attend un nombre entier entre ${min} et ${max}.`);
	return n;
}

function parseCli(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: "string" },
			timeout: { type: "string" },
			echantillon: { type: "string" },
			sortie: { type: "string" },
			max: { type: "string" },
			graine: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const [command, target, ...rest] = positionals;
	const timeout = integer(values.timeout, 60_000, "--timeout", 1, 2 ** 31 - 1);
	const refuse = (options: (keyof typeof values)[]) => {
		const extra = options.find((o) => values[o] !== undefined);
		if (extra) throw new Error(`L’option --${extra} ne s’applique pas à rampe ${command}.`);
	};
	if (command === "echantillon") {
		if (!target || rest.length > 0) throw new Error("Commande attendue : rampe echantillon <url>");
		refuse(["json", "echantillon"]);
		return {
			command,
			url: parseAuditUrl(target),
			timeout,
			sortie: values.sortie ?? "echantillon.txt",
			max: integer(values.max, 50, "--max", 2, 10_000),
			seed: integer(values.graine, randomInt(2 ** 32), "--graine", 0, 2 ** 32 - 1),
		} as const;
	}
	if (command !== "audit" || rest.length > 0 || Boolean(target) === Boolean(values.echantillon))
		throw new Error("Commande attendue : rampe audit <url> ou rampe audit --echantillon <fichier>");
	refuse(["sortie", "max", "graine"]);
	return {
		command,
		url: target ? parseAuditUrl(target) : null,
		file: values.echantillon,
		json: values.json,
		timeout,
	} as const;
}

const isHttp = (href: string) => /^https?:$/.test(new URL(href).protocol);

/** Critères sans aucune vérification automatique directe (même décompte que le site). */
const uncovered = () => rgaa.criteria.length - criteriaWithDirectRule(axe.getRules().map((r) => r.tags)).size;

/** Bac à sable de Chromium conservé : Playwright le désactive par défaut, on le réactive (ADR-0011 §6). */
async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
	const browser = await chromium.launch({ chromiumSandbox: true });
	try {
		return await fn(browser);
	} finally {
		await browser.close();
	}
}

/**
 * Exécute `fn` dans une page neuve (donc un contexte neuf) bornée par un délai global : une page qui bloque son fil
 * principal (boucle infinie) bloquerait aussi axe.run. Au dépassement, la page est fermée.
 */
async function onFreshPage<T>(browser: Browser, timeout: number, what: string, fn: (page: Page) => Promise<T>) {
	const page = await browser.newPage();
	let timer: NodeJS.Timeout | undefined;
	try {
		const work = fn(page);
		work.catch(() => {}); // rejet attendu après la fermeture de la page en cas de dépassement
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${what} interrompu après ${timeout} ms (option --timeout).`)),
				timeout,
			);
		});
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
		await page.close().catch(() => {});
	}
}

/** Charge la page et renvoie son URL finale, en refusant toute page qui a quitté le web (ADR-0011 §6). */
async function load(page: Page, url: URL, timeout: number): Promise<string> {
	const response = await page.goto(url.href, { waitUntil: "load", timeout });
	// Une page d'erreur (404, 500…) n'est pas la page voulue : l'auditer donnerait un résultat trompeur.
	const status = response?.status() ?? 0;
	if (status >= 400) throw new Error(`HTTP ${status} pour ${url.href}`);
	// Réseau calme : laisse aux scripts le temps de rendre, sans bloquer sur une page qui interroge en continu.
	await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5_000) }).catch(() => {});
	// La page a pu naviguer d'elle-même (about:blank, data:…) : on n'audite que du http(s).
	if (!isHttp(page.url())) throw new Error(`la page a quitté le web (http/https) : ${page.url()}`);
	return page.url();
}

const originWarning = (url: URL, finalUrl: string) =>
	new URL(finalUrl).origin === url.origin
		? []
		: [`La page finale est sur une autre origine que celle demandée : ${redact(finalUrl)}`];

/** Charge la page et lance axe-core. */
async function inspect(page: Page, url: URL, timeout: number): Promise<AuditPage> {
	await load(page, url, timeout);
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
	return {
		url: redact(url.href),
		finalUrl: redact(finalUrl),
		title: await page.title(),
		warnings: originWarning(url, finalUrl),
		results: classifyResults(raw.violations as AxeRawResult[], raw.incomplete as AxeRawResult[]),
		error: null,
	};
}

/** Collecte liens, navigation principale et formulaire de recherche de l'accueil (ADR-0012 §1). */
async function collect(page: Page, url: URL, timeout: number): Promise<Collected> {
	const homeUrl = await load(page, url, timeout);
	// Exécuté dans la page : aucune référence au code extérieur.
	const found = await page.evaluate(() => {
		const FOOTER = "footer, [role=contentinfo]";
		const HEADER = "header, [role=banner]";
		const name = (n: Element) =>
			`${n.getAttribute("aria-label") ?? ""} ${n.id} ${document.getElementById(n.getAttribute("aria-labelledby") ?? "")?.textContent ?? ""}`;
		// Ni sélecteur de langue, ni fil d'Ariane, ni liens d'évitement ; au moins 3 liens.
		const notMain = /langue|language|ariane|breadcrumb|acc[eè]s rapide|skip|[ée]vitement/i;
		const navs = [...document.querySelectorAll("nav, [role=navigation]")].filter(
			(n) => !n.closest(FOOTER) && !notMain.test(name(n)) && n.querySelectorAll("a[href]").length >= 3,
		);
		const inHeader = navs.filter((n) => n.closest(HEADER));
		const pool = inHeader.length > 0 ? inHeader : navs;
		const count = (n: Element) => n.querySelectorAll("a[href]").length;
		// Navigation principale : nommée comme telle, sinon celle qui a le plus de liens (en-tête d'abord).
		const main =
			pool.find((n) => /princip|main|primary/i.test(name(n))) ?? [...pool].sort((a, b) => count(b) - count(a))[0];
		// Premier niveau : les liens les moins imbriqués dans des éléments de liste.
		const depth = (a: Element) => {
			let d = 0;
			for (let e = a.parentElement; e && e !== main; e = e.parentElement) if (e.tagName === "LI") d++;
			return d;
		};
		const navLinks = main ? [...main.querySelectorAll("a[href]")] : [];
		const top = Math.min(...navLinks.map(depth));
		const links = [...document.querySelectorAll("a[href], area[href]")].map((a) => ({
			href: (a as HTMLAnchorElement).href,
			text:
				a.getAttribute("aria-label")?.trim() ||
				a.textContent?.trim() ||
				a.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
				a.getAttribute("title")?.trim() ||
				"",
			zone: a.closest(FOOTER) ? "pied-de-page" : a.closest(HEADER) ? "en-tete" : "contenu",
			topNav: navLinks.includes(a) && depth(a) === top,
		}));

		const NAMES = ["q", "query", "recherche", "rechercher", "search", "s", "keywords", "motcle", "mots-cles", "text"];
		const named = NAMES.map((n) => `input[name="${n}"]`).join(", ");
		const forms = [...document.forms];
		const byRole = forms.find((f) => f.closest('[role="search"], search'));
		const byType = forms.find((f) => f.querySelector('input[type="search"]'));
		const byName = forms.find((f) => f.method === "get" && f.querySelector(named));
		const form = byRole ?? byType ?? byName;
		let search = null;
		if (form) {
			const input =
				form.querySelector('input[type="search"]') ??
				form.querySelector(named) ??
				form.querySelector('input[name]:not([type]), input[type="text"][name]');
			const name = input?.getAttribute("name") ?? null;
			search = {
				reason:
					form === byRole
						? 'formulaire dans une zone de recherche (role="search")'
						: form === byType
							? "formulaire avec un champ de type search"
							: `formulaire GET avec un champ « ${name} »`,
				action: form.action,
				method: form.method,
				field: name,
				params: [...new FormData(form)].filter((e): e is [string, string] => typeof e[1] === "string"),
			};
		} else if (document.querySelector('[role="search"], search, input[type="search"]'))
			search = { reason: "zone de recherche sans formulaire", action: null, method: "get", field: null, params: [] };
		const label = main?.getAttribute("aria-label") || main?.id || null;
		return { links, search, navLabel: label };
	});
	return {
		requestedUrl: url.href,
		homeUrl,
		links: found.links as RawLink[],
		navLabel: found.navLabel,
		search: found.search as RawSearch | null,
	};
}

/**
 * Vérifie, avant tout chargement, qu'un fichier de sortie pourra être écrit sans rien écraser : un fichier a pu être
 * relu et modifié à la main, et un audit perdu faute de dossier coûte cher.
 */
function assertWritable(file: string, option: string) {
	if (existsSync(file))
		throw new Error(`Le fichier ${file} existe déjà (${option}) : choisissez un autre nom, ou supprimez-le.`);
	if (!existsSync(dirname(resolve(file)))) throw new Error(`Le dossier de ${file} n’existe pas (${option}).`);
}

/** Message d'erreur affichable : identifiants masqués, sans caractère de contrôle. */
const clean = (e: unknown) =>
	redact((e as Error).message)
		.split("\n")
		.map(stripControl)
		.join("\n");

async function auditOne(url: URL, json: string | undefined, timeout: number): Promise<number> {
	const startedAt = new Date();
	return withBrowser(async (browser) => {
		const auditPage = await onFreshPage(browser, timeout, "audit", (page) => inspect(page, url, timeout));
		for (const w of auditPage.warnings) console.error(`Avertissement : ${stripControl(w)}`);
		console.log(formatReport(auditPage, uncovered()));
		await writeJson(json, startedAt, browser, [auditPage]);
		return auditPage.results.some((r) => r.kind === "non-conformite") ? 1 : 0;
	});
}

/** Audite les pages une à une dans un seul navigateur, chacune dans un contexte neuf (ADR-0012 §3 et §4). */
async function auditSample(file: string, json: string | undefined, timeout: number): Promise<number> {
	const { urls, warnings } = parseSampleFile(await readFile(file, "utf8"));
	for (const w of warnings) console.error(`Avertissement : ${w}`);
	const startedAt = new Date();
	return withBrowser(async (browser) => {
		const pages: AuditPage[] = [];
		for (const [i, url] of urls.entries()) {
			console.log(`\n=== Page ${i + 1}/${urls.length} : ${redact(url.href)} ===`);
			let auditPage: AuditPage;
			try {
				auditPage = await onFreshPage(browser, timeout, "audit", (page) => inspect(page, url, timeout));
			} catch (e) {
				const error = clean(e).split("\n")[0] ?? "";
				console.error(`Erreur sur ${redact(url.href)} : ${error}`);
				auditPage = { url: redact(url.href), finalUrl: null, title: null, warnings: [], results: [], error };
			}
			for (const w of auditPage.warnings) console.error(`Avertissement (${redact(url.href)}) : ${stripControl(w)}`);
			pages.push(auditPage);
			console.log(formatPage(auditPage).trimEnd());
		}
		console.log(`\n${formatSynthesis(pages, uncovered())}`);
		await writeJson(json, startedAt, browser, pages);
		if (pages.some((p) => p.error !== null)) return 2;
		return pages.some((p) => p.results.some((r) => r.kind === "non-conformite")) ? 1 : 0;
	});
}

async function writeJson(json: string | undefined, startedAt: Date, browser: Browser, pages: AuditPage[]) {
	if (!json) return;
	const report = buildReport({ startedAt, axeVersion: axe.version, browserVersion: browser.version(), pages });
	await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	console.log(`\nRésultat JSON écrit dans ${json}`);
}

async function sample(url: URL, sortie: string, max: number, seed: number, timeout: number): Promise<number> {
	assertWritable(sortie, "--sortie");
	const collected = await withBrowser((browser) =>
		onFreshPage(browser, timeout, "chargement de l’accueil", (page) => collect(page, url, timeout)),
	);
	const proposal = proposeSample(collected, max, seed);
	await writeFile(sortie, formatSampleFile(proposal), { flag: "wx" });
	console.log(formatSampleSummary(proposal, sortie));
	if (url.username || url.password)
		console.error(
			"Note : les identifiants de l’adresse ne sont pas écrits dans le fichier. Ajoutez-les à la main aux adresses qui en ont besoin.",
		);
	return 0;
}

let options: ReturnType<typeof parseCli>;
try {
	options = parseCli(process.argv.slice(2));
} catch (e) {
	console.error(`${redact((e as Error).message)}\n\n${USAGE}`);
	process.exit(2);
}
try {
	const o = options;
	if (o.command === "audit" && o.json) {
		if (o.file && resolve(o.json) === resolve(o.file))
			throw new Error("--json désigne le fichier d’échantillon lui-même : choisissez un autre fichier.");
		assertWritable(o.json, "--json");
	}
	process.exitCode =
		o.command === "echantillon"
			? await sample(o.url, o.sortie, o.max, o.seed, o.timeout)
			: o.url
				? await auditOne(o.url, o.json, o.timeout)
				: await auditSample(o.file as string, o.json, o.timeout);
} catch (e) {
	console.error(`Erreur : ${clean(e)}`);
	process.exitCode = 2;
}
