#!/usr/bin/env node
// Point d'entrée `rampe` (ADR-0011, ADR-0012). Exécuté tel quel par Node ≥ 22.18 (suppression native des types).
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AXE_RUN_OPTIONS } from "@rampe/core";
import axe from "axe-core";
import { type Browser, chromium, type Page, type Request } from "playwright";
import {
	type AuditPage,
	buildReport,
	classifyResults,
	exitCodeFor,
	formatPage,
	formatReport,
	formatSynthesis,
	parseAuditUrl,
	parseAxeOutput,
	redact,
	stripControl,
	TITLE_MAX,
	truncate,
	uncoveredCriteria,
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
import { renderHtmlReport } from "./rapport.ts";

const USAGE = `Usage :
  rampe audit <url> [--json <fichier>] [--html <fichier>] [--timeout <ms>] [--theme clair|sombre] [--largeur <px>] [--strict]
  rampe audit --echantillon <fichier> [mêmes options]
  rampe echantillon <url> [--sortie <fichier>] [--max <n>] [--graine <n>] [--timeout <ms>]

audit
  <url>                  page à auditer (http:// ou https://)
  --echantillon <fich.>  audite une à une les pages d’un fichier d’échantillon (voir rampe echantillon)
  --json <fichier>       écrit aussi le résultat détaillé en JSON
  --html <fichier>       écrit aussi un rapport HTML lisible par un non-expert
  --timeout <ms>         durée maximale de l’audit d’une page : chargement, injection et analyse (défaut : 60000)
  --theme clair|sombre   préférence de couleurs du navigateur, prefers-color-scheme (défaut : clair)
  --largeur <px>         largeur de la fenêtre, de 200 à 3840 ; hauteur 720 (défaut : 1280)
  --strict               sort aussi en 1 sur un résultat « rattachement incertain » ou « à vérifier »

echantillon : propose un échantillon de pages selon la méthode RGAA, à relire et modifier
  <url>                  page d’accueil du site
  --sortie <fichier>     fichier à écrire, jamais écrasé (défaut : echantillon.txt)
  --max <n>              nombre maximal de pages proposées (défaut : 50)
  --graine <n>           graine du tirage au hasard, pour rejouer le même échantillon
  --timeout <ms>         durée maximale du chargement de l’accueil (défaut : 60000)

Codes de sortie : 0 aucune non-conformité détectée, 1 non-conformité(s) détectée(s) (avec --strict : ou résultat
incertain ou à vérifier), 2 erreur
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
			html: { type: "string" },
			timeout: { type: "string" },
			echantillon: { type: "string" },
			sortie: { type: "string" },
			max: { type: "string" },
			graine: { type: "string" },
			theme: { type: "string" },
			largeur: { type: "string" },
			strict: { type: "boolean" },
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
		refuse(["json", "html", "echantillon", "theme", "largeur", "strict"]);
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
	const theme = values.theme ?? "clair";
	if (theme !== "clair" && theme !== "sombre") throw new Error("--theme attend « clair » ou « sombre ».");
	return {
		command,
		url: target ? parseAuditUrl(target) : null,
		file: values.echantillon,
		json: values.json,
		html: values.html,
		timeout,
		view: {
			colorScheme: theme === "sombre" ? "dark" : "light",
			viewport: { width: integer(values.largeur, 1280, "--largeur", 200, 3840), height: 720 },
		} satisfies View,
		strict: values.strict ?? false,
	} as const;
}

/** Conditions d'affichage de chaque page auditée : thème du navigateur et taille de la fenêtre. */
interface View {
	colorScheme: "light" | "dark";
	viewport: { width: number; height: number };
}

const isHttp = (href: string) => /^https?:$/.test(new URL(href).protocol);

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
async function onFreshPage<T>(
	browser: Browser,
	timeout: number,
	what: string,
	fn: (page: Page) => Promise<T>,
	view?: View,
) {
	const page = await browser.newPage(view);
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

/**
 * Évalue `expression` dans un monde isolé du cadre principal (ADR-0020) : DOM partagé, mais pas les objets JavaScript
 * de la page, qui ne peut donc ni remplacer `window.axe` ni fausser les primitives (`querySelectorAll`, `getAttribute`,
 * `JSON.stringify`…) dont la CLI dépend. Toute lecture de la page par la CLI passe par ici. Par le protocole de
 * débogage : non soumis à la CSP de la page, sans la désactiver. Renvoie la valeur sérialisée dans le monde isolé.
 */
async function evaluateIsolated(page: Page, expression: string): Promise<unknown> {
	const cdp = await page.context().newCDPSession(page);
	try {
		let response: Awaited<ReturnType<typeof cdp.send<"Runtime.evaluate">>>;
		try {
			const { frameTree } = await cdp.send("Page.getFrameTree");
			// ponytail: cadre principal seulement ; les iframes demanderont un monde isolé par cadre.
			const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
				frameId: frameTree.frame.id,
				worldName: "rampe",
				grantUniveralAccess: false,
			});
			response = await cdp.send("Runtime.evaluate", {
				expression,
				contextId: executionContextId,
				awaitPromise: true,
				returnByValue: true,
			});
		} catch {
			// Monde isolé détruit : la page a navigué (ou s'est fermée) pendant l'évaluation.
			throw new Error(NAVIGATED);
		}
		const { result, exceptionDetails } = response;
		if (exceptionDetails)
			throw new Error(
				`échec du script de Rampe dans la page : ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
			);
		return result.value;
	} finally {
		// Sans attente : pendant une navigation en suspens, Chromium ne répond au détachement qu'à sa fin (jamais si le
		// serveur ne répond pas). La fermeture de la page libère la session de toute façon.
		cdp.detach().catch(() => {});
	}
}

const NAVIGATED = "La page a navigué pendant l’analyse : audit impossible.";

/**
 * Règles par défaut d'axe.run (sans règles expérimentales), options communes avec l'extension (`AXE_RUN_OPTIONS` :
 * jamais d'interrogation des iframes, ADR-0020). Le titre et l'URL sont lus dans la même évaluation, avant l'analyse :
 * une page qui se réécrit pendant l'analyse ne change pas le titre du rapport, et l'URL est celle du document analysé.
 * Résultat sérialisé dans le monde isolé, validé ici.
 */
const AXE_RUN = `${axe.source}
;(async () => {
	const title = document.title;
	const url = location.href;
	const r = await axe.run(document, ${JSON.stringify(AXE_RUN_OPTIONS)});
	return JSON.stringify({ title, url, violations: r.violations, incomplete: r.incomplete });
})()`;

/**
 * Charge la page et lance axe-core. Toute navigation du cadre principal pendant l'analyse arrête l'audit (ADR-0020) :
 * la requête de navigation suffit, sans attendre la validation du nouveau document (qui peut n'arriver qu'après la fin
 * d'axe), et l'URL du document analysé doit être encore celle de la page. Les résultats ne sont donc jamais attribués
 * à une autre page que celle analysée.
 */
async function inspect(page: Page, url: URL, timeout: number): Promise<AuditPage> {
	await load(page, url, timeout);
	let navigated = false;
	const onRequest = (r: Request) => {
		if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigated = true;
	};
	page.on("request", onRequest);
	const raw = parseAxeOutput(await evaluateIsolated(page, AXE_RUN));
	page.off("request", onRequest);
	if (navigated || page.url() !== raw.url) throw new Error(NAVIGATED);
	const finalUrl = raw.url;
	if (!isHttp(finalUrl)) throw new Error(`la page a quitté le web (http/https) : ${finalUrl}`);
	return {
		url: redact(url.href),
		finalUrl: redact(finalUrl),
		title: truncate(raw.title, TITLE_MAX),
		warnings: originWarning(url, finalUrl),
		results: classifyResults(raw.violations, raw.incomplete),
		error: null,
	};
}

/**
 * Lecture de l'accueil, sérialisée par `Function.prototype.toString` puis évaluée dans le monde isolé : aucune
 * référence au code extérieur.
 */
function collectInPage() {
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
}

/** Collecte liens, navigation principale et formulaire de recherche de l'accueil (ADR-0012 §1). */
async function collect(page: Page, url: URL, timeout: number): Promise<Collected> {
	const homeUrl = await load(page, url, timeout);
	const found = (await evaluateIsolated(page, `(${collectInPage})()`)) as ReturnType<typeof collectInPage>;
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

interface Outputs {
	json: string | undefined;
	html: string | undefined;
}

interface AuditOptions {
	timeout: number;
	view: View;
	strict: boolean;
}

/** Code de sortie des pages auditées ; en mode strict, dit pourquoi il vaut 1 sans non-conformité. */
function exitCode(pages: AuditPage[], strict: boolean): number {
	const code = exitCodeFor(pages, strict);
	if (code === 1 && exitCodeFor(pages, false) === 0)
		console.log("\nMode --strict : des résultats « rattachement incertain » ou « à vérifier » font sortir en 1.");
	return code;
}

async function auditOne(url: URL, out: Outputs, { timeout, view, strict }: AuditOptions): Promise<number> {
	const startedAt = new Date();
	return withBrowser(async (browser) => {
		const auditPage = await onFreshPage(browser, timeout, "audit", (page) => inspect(page, url, timeout), view);
		for (const w of auditPage.warnings) console.error(`Avertissement : ${stripControl(w)}`);
		console.log(formatReport(auditPage, uncoveredCriteria()));
		await writeOutputs(out, startedAt, browser, [auditPage]);
		return exitCode([auditPage], strict);
	});
}

/** Audite les pages une à une dans un seul navigateur, chacune dans un contexte neuf (ADR-0012 §3 et §4). */
async function auditSample(file: string, out: Outputs, { timeout, view, strict }: AuditOptions): Promise<number> {
	const { urls, warnings } = parseSampleFile(await readFile(file, "utf8"));
	for (const w of warnings) console.error(`Avertissement : ${w}`);
	const startedAt = new Date();
	return withBrowser(async (browser) => {
		const pages: AuditPage[] = [];
		for (const [i, url] of urls.entries()) {
			console.log(`\n=== Page ${i + 1}/${urls.length} : ${redact(url.href)} ===`);
			let auditPage: AuditPage;
			try {
				auditPage = await onFreshPage(browser, timeout, "audit", (page) => inspect(page, url, timeout), view);
			} catch (e) {
				const error = clean(e).split("\n")[0] ?? "";
				console.error(`Erreur sur ${redact(url.href)} : ${error}`);
				auditPage = { url: redact(url.href), finalUrl: null, title: null, warnings: [], results: [], error };
			}
			for (const w of auditPage.warnings) console.error(`Avertissement (${redact(url.href)}) : ${stripControl(w)}`);
			pages.push(auditPage);
			console.log(formatPage(auditPage).trimEnd());
		}
		console.log(`\n${formatSynthesis(pages, uncoveredCriteria())}`);
		await writeOutputs(out, startedAt, browser, pages);
		if (pages.some((p) => p.error !== null)) return 2;
		return exitCode(pages, strict);
	});
}

/** JSON v2 et rapport HTML, tous deux tirés du même rapport ; jamais d'écrasement (`wx`). */
async function writeOutputs({ json, html }: Outputs, startedAt: Date, browser: Browser, pages: AuditPage[]) {
	const report = buildReport({ startedAt, axeVersion: axe.version, browserVersion: browser.version(), pages });
	if (json) {
		await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
		console.log(`\nRésultat JSON écrit dans ${json}`);
	}
	if (html) {
		await writeFile(html, renderHtmlReport(report), { flag: "wx" });
		console.log(`\nRapport HTML écrit dans ${html}`);
	}
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
	if (o.command === "audit") {
		for (const [option, file] of [
			["--json", o.json],
			["--html", o.html],
		] as const) {
			if (!file) continue;
			if (o.file && resolve(file) === resolve(o.file))
				throw new Error(`${option} désigne le fichier d’échantillon lui-même : choisissez un autre fichier.`);
			assertWritable(file, option);
		}
		if (o.json && o.html && resolve(o.json) === resolve(o.html))
			throw new Error("--json et --html désignent le même fichier : choisissez deux noms différents.");
	}
	process.exitCode =
		o.command === "echantillon"
			? await sample(o.url, o.sortie, o.max, o.seed, o.timeout)
			: o.url
				? await auditOne(o.url, o, o)
				: await auditSample(o.file as string, o, o);
} catch (e) {
	console.error(`Erreur : ${clean(e)}`);
	process.exitCode = 2;
}
