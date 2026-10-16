// Bout en bout de l'extension (ADR-0019 §7) : build réel, chargé non empaqueté dans Chromium (contexte persistant,
// nouveau mode headless, qui accepte les extensions), sur une page à défauts connus servie sur un port libre.
//
// Lier le panneau à l'onglet testé : Playwright ne sait pas cliquer sur l'icône d'une extension. Le test
// 1. accorde activeTab À L'ONGLET TESTÉ comme le ferait un clic sur l'icône : commande CDP `Extensions.triggerAction`
//    (session navigateur, cible « tab », drapeau --enable-unsafe-extension-debugging) ;
// 2. ouvre popup.html dans un onglet (même code, mêmes API que le panneau), où il remplace la SEULE fonction
//    `chrome.tabs.query` (« quel est l'onglet courant ? ») par l'onglet testé. Tout le reste est réel : sans l'étape 1,
//    l'injection est refusée par le navigateur (vérifié plus bas), ce qui prouve l'absence de permission d'hôte.
//
// Le rapport téléchargé est ensuite importé dans l'audit guidé du site, construit ici (@rampe/site est une dépendance
// de développement : pnpm lance donc ses tests avant ceux-ci, et les deux builds d'Astro ne se gênent pas).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAuditReport, rgaa } from "@rampe/core";
import axe from "axe-core";
import { type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const site = fileURLToPath(new URL("../../../apps/site/", import.meta.url));
const astro = join(site, "node_modules/astro/bin/astro.mjs");
const cliFixtures = fileURLToPath(new URL("../../cli/test/fixtures/", import.meta.url));
const defauts = join(cliFixtures, "defauts.html");
// Captures d'écran facultatives, pour la relecture humaine : RAMPE_CAPTURES=<dossier>.
const captures = process.env.RAMPE_CAPTURES;
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
};
// Page hostile : balisage dans le titre et dans un identifiant, qui doivent rester du texte dans le panneau.
const HOSTILE = `<!doctype html><html lang="fr"><head><title>&lt;img src=x onerror=alert(1)&gt;</title></head>
<body><main><h1>Hostile</h1><input id="&lt;img src=x onerror=alert(2)&gt;">
<img id="${"tres-long-identifiant".repeat(40)}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>`;
// Page lourde : axe met plusieurs secondes à l'analyser, le temps d'y naviguer pendant l'analyse.
const LOURDE = `<!doctype html><html lang="fr"><head><title>Page lourde</title></head><body><main><h1>Lourde</h1>${'<p style="color:#999">texte <a href="#x">lien</a></p>'.repeat(15_000)}</main></body></html>`;
// Bloque son fil principal 1 s après le chargement (le temps de lire son titre) : aucun script ne peut plus y finir.
const BOUCLE = `<!doctype html><html lang="fr"><head><title>Boucle infinie</title>
<script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 1000));</script></head><body><main><h1>Boucle</h1></main></body></html>`;
// Plus petit PDF valide : servi en http, ce n'est pas une page HTML.
const PDF =
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const FIXTURES = {
	defauts: "Page avec défauts connus",
	hostile: "<img src=x onerror=alert(1)>",
	boucle: "Boucle infinie",
	lourde: "Page lourde",
	// Pages de la CLI (ADR-0020) : témoin à iframe muette, pièges dont l'iframe répond à la messagerie d'axe.
	"ifr-honest": "Iframe honnete",
	"ifr-null": "Piege iframe ifr-null",
	"ifr-fake": "Piege iframe ifr-fake",
} as const;
const IFRAMES = new Set(["ifr-honest", "ifr-null", "ifr-fake"]);

let tmp: string;
let ext: string;
let id: string;
let server: Server;
let origin: string;
let ctx: BrowserContext;
/** Chemins demandés au serveur, toutes origines de requête confondues (ce que Playwright ne voit pas compris). */
const hits: string[] = [];

const run = (args: string[], cwd: string) =>
	new Promise<void>((resolve, reject) =>
		// Build de production, celui que la CI empaquette (vitest fixe NODE_ENV à « test »).
		execFile(process.execPath, args, { cwd, env: { ...process.env, NODE_ENV: "production" } }, (error, _o, stderr) =>
			error ? reject(new Error(stderr)) : resolve(),
		),
	);

/** Identifiant d'une extension non empaquetée : SHA-256 de son chemin, 32 premiers chiffres hexadécimaux en a-p. */
const extensionId = (path: string) =>
	[...createHash("sha256").update(path).digest("hex").slice(0, 32)]
		.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
		.join("");

beforeAll(async () => {
	tmp = await mkdtemp(join(await realpath(tmpdir()), "rampe-extension-"));
	ext = join(tmp, "extension");
	const siteOut = join(tmp, "site");
	await run([vite, "build", "--outDir", ext, "--emptyOutDir"], pkg);
	await run([astro, "build", "--outDir", siteOut], site);
	server = createServer(async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		hits.push(path);
		const html = { "content-type": "text/html; charset=utf-8" };
		if (path === "/fixture/defauts") return res.writeHead(200, html).end(await readFile(defauts));
		if (path === "/fixture/hostile") return res.writeHead(200, html).end(HOSTILE);
		if (path === "/fixture/boucle") return res.writeHead(200, html).end(BOUCLE);
		const name = path.slice("/fixture/".length);
		// Noms fixes : aucun chemin venu de la requête n'atteint le disque.
		if (path.startsWith("/fixture/") && IFRAMES.has(name))
			return res.writeHead(200, html).end(await readFile(join(cliFixtures, `${name}.html`)));
		if (path === "/fixture/lourde") return res.writeHead(200, html).end(LOURDE);
		if (path === "/fixture/document.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
		if (!path.startsWith("/rampe/")) return res.writeHead(404).end();
		// normalize + préfixe : aucune requête ne sort du dossier de build.
		let file = normalize(join(siteOut, path.slice("/rampe/".length)));
		if (!file.startsWith(siteOut)) return res.writeHead(403).end();
		if (path.endsWith("/")) file = join(file, "index.html");
		try {
			res
				.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
				.end(await readFile(file));
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	ctx = await chromium.launchPersistentContext(join(tmp, "profil"), {
		// « chromium » : nouveau mode headless (le navigateur complet), le seul qui charge les extensions.
		channel: "chromium",
		headless: true,
		// Bac à sable de Chromium conservé (ADR-0011 §6).
		chromiumSandbox: true,
		args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--enable-unsafe-extension-debugging"],
	});
	id = extensionId(ext);
	if (captures) await mkdir(captures, { recursive: true });
}, 240_000);

afterAll(async () => {
	await ctx?.close();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (tmp) await rm(tmp, { recursive: true, force: true });
});

let n = 0;
/** Ouvre une page de test sous une adresse unique (pour retrouver son onglet sans ambiguïté). */
async function openFixture(name: keyof typeof FIXTURES, hash = "") {
	const page = await ctx.newPage();
	const url = `${origin}/fixture/${name}?onglet=${++n}${hash}`;
	await page.goto(url);
	await expect(page.title()).resolves.toBe(FIXTURES[name]);
	return { page, url };
}

/** Équivalent d'un clic sur l'icône de l'extension pour l'onglet à `url` : accorde activeTab. */
async function clickAction(url: string) {
	const cdp = await (ctx.browser() ?? expect.fail("navigateur introuvable")).newBrowserCDPSession();
	const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
	const tab = targetInfos.find((t) => t.url === url) ?? expect.fail(`onglet ${url} introuvable`);
	await cdp.send("Extensions.triggerAction", { id, targetId: tab.targetId });
	await cdp.detach();
}

/** Panneau ouvert dans un onglet ; `chrome.tabs.query` y désigne l'onglet testé (`tab`). */
async function openPopup(tab: { url?: string; fake?: { id: number; url: string } }) {
	const popup = await ctx.newPage();
	await popup.setViewportSize({ width: 420, height: 700 });
	await popup.goto(`chrome-extension://${id}/popup.html`);
	await expect(popup.title()).resolves.toBe("Rampe — audit de la page");
	await popup.evaluate(async ({ url, fake }) => {
		type Api = { tabs: { query: (q: object) => Promise<unknown[]> } };
		const g = globalThis as unknown as { chrome: Api; browser?: Api };
		const target = fake ?? (await g.chrome.tabs.query({})).find((t) => (t as { url?: string }).url === url);
		if (!target) throw new Error(`onglet ${url} invisible pour l'extension`);
		// Les deux espaces de noms, au cas où le navigateur fournirait aussi `browser`.
		for (const a of [g.chrome, g.browser]) if (a) a.tabs.query = async () => [target];
	}, tab);
	return popup;
}

const status = (popup: Page) => popup.locator("#etat").textContent();

async function axeViolations(page: Page) {
	await page.evaluate(axe.source);
	return page.evaluate(async () => {
		const r = await (window as unknown as { axe: typeof axe }).axe.run();
		return r.violations.map((v) => `${v.id} : ${v.nodes.map((x) => x.target.join(" ")).join(", ")}`);
	});
}

describe("extension navigateur (bout en bout)", { timeout: 90_000 }, () => {
	it("sans clic sur l'icône, l'extension ne voit ni l'adresse de l'onglet ni ne peut y injecter de script", async () => {
		const { page, url } = await openFixture("defauts");
		const popup = await ctx.newPage();
		await popup.goto(`chrome-extension://${id}/popup.html`);
		const seen = await popup.evaluate(async (url) => {
			const c = (
				globalThis as unknown as { chrome: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }
			).chrome;
			const tabs = (await c.tabs?.query?.({})) as { id: number; url?: string; title?: string }[];
			const others = tabs.filter((t) => t.url === undefined);
			const refused: string[] = [];
			for (const t of others)
				await c.scripting
					?.executeScript?.({ target: { tabId: t.id }, func: () => document.title })
					.then(() => refused.push("injecté !"))
					.catch((e: Error) => refused.push(e.message));
			return { visible: tabs.filter((t) => t.url === url).length, hidden: others.length, refused };
		}, url);
		expect(seen.visible).toBe(0);
		expect(seen.hidden).toBeGreaterThan(0);
		expect(seen.refused).toHaveLength(seen.hidden);
		expect(seen.refused.join("\n")).not.toContain("injecté !");
		await popup.close();
		await page.close();
	});

	it("analyse l'onglet au clavier, range les résultats par critère, sans aucune requête réseau, rapport importable", async () => {
		const { page, url } = await openFixture("defauts", "#haut");
		await clickAction(url);
		const popup = await openPopup({ url });
		await expect(popup.locator("#rappel").textContent()).resolves.toMatch(
			new RegExp(
				`^Les ${rgaa.criteria.length} critères demandent une vérification humaine ; \\d+ n’en ont aucune vérification automatique directe\\.`,
			),
		);

		// À partir d'ici, aucune requête vers le réseau : ni du panneau, ni de l'onglet analysé.
		const requests: string[] = [];
		ctx.on("request", (r) => requests.push(r.url()));
		const hitsBefore = hits.length;

		await popup.focus("body");
		await popup.keyboard.press("Tab");
		await expect(popup.evaluate(() => document.activeElement?.textContent)).resolves.toBe("Analyser cette page");
		await popup.keyboard.press("Enter");
		await expect
			.poll(() => status(popup), { timeout: 30_000 })
			.toMatch(/^Analyse terminée : \d+ règles en non-conformité/);
		// Le focus reste sur le bouton pendant et après l'analyse (aria-disabled, jamais disabled).
		await expect(popup.evaluate(() => document.activeElement?.id)).resolves.toBe("analyser");
		await expect(popup.locator("#analyser").getAttribute("aria-disabled")).resolves.toBeNull();
		// Avertissement avant partage (OWASP User Privacy Protection Cheat Sheet).
		await expect(popup.locator("#partage").textContent()).resolves.toMatch(
			/^Avant de partager ce rapport, relisez-le : il contient l’adresse de la page avec ses paramètres, et des extraits du code de la page \(jusqu’à 500 caractères/,
		);

		const nc = popup.locator("section:has(> h3:text-is('Non-conformités détectées')) h4");
		const criteria = (await nc.allTextContents()).map((t) => t.split(" — ")[0]);
		expect(criteria).toEqual(expect.arrayContaining(["Critère 1.1", "Critère 3.2", "Critère 8.3", "Critère 11.1"]));
		expect(await popup.locator("h3").allTextContents()).toEqual([
			"Non-conformités détectées",
			"Problèmes détectés, rattachement RGAA incertain",
			"À vérifier par un humain",
			"Bonnes pratiques (hors conformité RGAA)",
		]);
		// duplicate-id : règle dépréciée par axe, jamais présentée.
		await expect(popup.locator("#categories").textContent()).resolves.not.toContain("duplicate-id");
		await expect(popup.locator("#categories").textContent()).resolves.not.toMatch(/score|taux|%/i);

		const [download] = await Promise.all([
			popup.waitForEvent("download"),
			popup.getByRole("button", { name: "Télécharger le rapport (JSON)" }).click(),
		]);
		const file = await download.path();
		const report = JSON.parse(await readFile(file, "utf8"));
		expect(download.suggestedFilename()).toMatch(/^rampe-127\.0\.0\.1-\d{4}-\d{2}-\d{2}\.json$/);

		// Aucune requête réseau pendant l'analyse et le téléchargement : seules les ressources de l'extension et le Blob.
		expect(requests.filter((u) => !/^(chrome-extension|blob):/.test(u))).toEqual([]);
		expect(hits.slice(hitsBefore)).toEqual([]);

		expect(report).toMatchObject({ schemaVersion: 2, tool: { name: "@rampe/extension", version: "0.1.0" } });
		// Fragment retiré, requête gardée.
		expect(report.pages[0].url).toBe(url.replace("#haut", ""));
		expect(JSON.stringify(report)).not.toContain("#haut");
		expect(Object.keys(report)).toEqual(["schemaVersion", "tool", "engine", "startedAt", "pages"]);
		expect(report.engine.axe).toBe(axe.version);
		const parsed = parseAuditReport(report, new Set(rgaa.criteria.map((c) => c.id)));
		const ncCriteria = [
			...new Set(parsed.pages[0]?.results.filter((r) => r.kind === "non-conformite").flatMap((r) => r.criteria)),
		];
		expect(ncCriteria).toEqual(expect.arrayContaining(["1.1", "3.2", "8.3", "11.1"]));

		// Accessibilité du panneau, résultats affichés, en clair puis en sombre (ADR-0019 §6).
		for (const colorScheme of ["light", "dark"] as const) {
			await popup.emulateMedia({ colorScheme });
			expect(await axeViolations(popup), colorScheme).toEqual([]);
			if (captures) await popup.screenshot({ path: join(captures, `popup-${colorScheme}.png`), fullPage: true });
		}

		// Import dans l'audit guidé du site (ADR-0014) : la page est ajoutée, les non-conformités deviennent à confirmer.
		const audit = await ctx.newPage();
		await audit.goto(`${origin}/rampe/audit/`);
		await expect(audit.title()).resolves.toBe("Audit guidé · Rampe");
		await audit.waitForSelector("astro-island:not([ssr])");
		await audit.getByLabel("Importer un rapport automatique (CLI ou extension, JSON)").setInputFiles(file);
		await audit.locator(".audit-import-summary").waitFor();
		await expect(audit.locator("[aria-live=polite]").textContent()).resolves.toMatch(
			new RegExp(
				`^Import terminé : 1 page ajoutée, ${ncCriteria.length} statuts « Non conforme » à confirmer, \\d+ indices\\.`,
			),
		);
		await expect(audit.locator(".audit-page-list li").textContent()).resolves.toContain("Page avec défauts connus");
		await Promise.all([audit.close(), popup.close(), page.close()]);
	});

	it("une iframe qui répond à la messagerie d'axe ne change pas le résultat (ADR-0020, iframes: false)", async () => {
		const results = async (name: keyof typeof FIXTURES) => {
			const { page, url } = await openFixture(name);
			await clickAction(url);
			const popup = await openPopup({ url });
			await popup.getByRole("button", { name: "Analyser cette page" }).click();
			await expect.poll(() => status(popup), { timeout: 30_000 }).toMatch(/^Analyse terminée/);
			const [download] = await Promise.all([
				popup.waitForEvent("download"),
				popup.getByRole("button", { name: "Télécharger le rapport (JSON)" }).click(),
			]);
			const report = JSON.parse(await readFile(await download.path(), "utf8"));
			const text = await status(popup);
			await Promise.all([popup.close(), page.close()]);
			return { text, results: report.pages[0].results as { ruleId: string; kind: string }[] };
		};
		const witness = await results("ifr-honest");
		expect(witness.text).toMatch(/^Analyse terminée : 4 règles en non-conformité/);
		expect(witness.results.find((r) => r.ruleId === "frame-tested")?.kind).toBe("a-verifier");
		for (const trap of ["ifr-null", "ifr-fake"] as const) expect(await results(trap), trap).toEqual(witness);
	});

	it("le panneau ne peut joindre aucun serveur : la CSP bloque toute connexion", async () => {
		const popup = await ctx.newPage();
		await popup.goto(`chrome-extension://${id}/popup.html`);
		const hitsBefore = hits.length;
		const result = await popup.evaluate(
			(u) =>
				fetch(u).then(
					() => "joint",
					() => "bloqué",
				),
			`${origin}/sonde`,
		);
		expect(result).toBe("bloqué");
		expect(hits.slice(hitsBefore)).toEqual([]);
		await popup.close();
	});

	it("données de la page affichées comme du texte, jamais comme du HTML", async () => {
		const { page, url } = await openFixture("hostile");
		await clickAction(url);
		const popup = await openPopup({ url });
		await popup.getByRole("button", { name: "Analyser cette page" }).click();
		await expect.poll(() => status(popup), { timeout: 30_000 }).toMatch(/^Analyse terminée/);
		await expect(popup.locator("#page").textContent()).resolves.toMatch(/^<img src=x onerror=alert\(1\)> — /);
		await expect(popup.locator("#categories").textContent()).resolves.toContain(
			String.raw`#\<img\ src\=x\ onerror\=alert\(2\)\>`,
		);
		await expect(popup.locator("img").count()).resolves.toBe(0);
		// Sélecteur de 840 caractères sans espace : jamais de défilement horizontal du panneau.
		await expect(popup.locator("#categories").textContent()).resolves.toContain("tres-long-identifiant".repeat(40));
		for (const width of [350, 420, 800]) {
			await popup.setViewportSize({ width, height: 700 });
			const overflow = await popup.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			);
			expect(overflow, `${width} px`).toBe(0);
		}
		await Promise.all([popup.close(), page.close()]);
	});

	it("document non HTML (PDF servi en http) : refusé avec un message clair, sans y injecter axe", async () => {
		const page = await ctx.newPage();
		const url = `${origin}/fixture/document.pdf?onglet=${++n}`;
		await page.goto(url).catch(() => {}); // le visionneur PDF peut interrompre la navigation de Playwright
		await expect.poll(() => page.url()).toBe(url);
		await clickAction(url);
		const popup = await openPopup({ url });
		await popup.getByRole("button", { name: "Analyser cette page" }).click();
		await expect
			.poll(() => status(popup))
			.toMatch(/^Rampe n’analyse que les pages HTML\. Ce document est de type « application\/pdf »/);
		await expect(popup.locator("#detail").isHidden()).resolves.toBe(true);
		await Promise.all([popup.close(), page.close()]);
	});

	it("page bloquée par un script : arrêt au bout de 60 s, message clair, bouton de nouveau utilisable", async () => {
		const { page, url } = await openFixture("boucle");
		await clickAction(url);
		const popup = await ctx.newPage();
		// Horloge simulée du panneau : les 60 s passent sans attendre.
		await popup.clock.install();
		await popup.goto(`chrome-extension://${id}/popup.html`);
		await popup.evaluate(async (url) => {
			type Api = { tabs: { query: (q: object) => Promise<unknown[]> } };
			const g = globalThis as unknown as { chrome: Api; browser?: Api };
			const target = (await g.chrome.tabs.query({})).find((t) => (t as { url?: string }).url === url);
			for (const a of [g.chrome, g.browser]) if (a) a.tabs.query = async () => [target];
		}, url);
		await popup.getByRole("button", { name: "Analyser cette page" }).click();
		await expect.poll(() => status(popup)).toBe("Analyse en cours…");
		await expect(popup.locator("#analyser").getAttribute("aria-disabled")).resolves.toBe("true");
		await popup.clock.fastForward(60_000);
		await expect.poll(() => status(popup)).toMatch(/^L’analyse a dépassé 60 secondes : la page est peut-être bloquée/);
		await expect(popup.locator("#analyser").getAttribute("aria-disabled")).resolves.toBeNull();
		await popup.close();
		await page.close({ runBeforeUnload: false });
	});

	it("navigation pendant l'analyse : message en français, détail technique replié", async () => {
		const { page, url } = await openFixture("lourde");
		await clickAction(url);
		const popup = await openPopup({ url });
		await popup.getByRole("button", { name: "Analyser cette page" }).click();
		await expect.poll(() => status(popup)).toBe("Analyse en cours…");
		await popup.waitForTimeout(500); // axe est lancé ; la page lourde le retient plusieurs secondes
		await page.goto(`${origin}/fixture/defauts?onglet=${++n}`);
		await expect
			.poll(() => status(popup), { timeout: 30_000 })
			.toBe("La page a changé pendant l’analyse : relancez-la.");
		const detail = popup.locator("#detail");
		await expect(detail.isVisible()).resolves.toBe(true);
		await expect(detail.getAttribute("open")).resolves.toBeNull();
		await expect(popup.locator("#detail-texte").textContent()).resolves.not.toBe("");
		await Promise.all([popup.close(), page.close()]);
	});

	it.each([
		["chrome://extensions/", /^Rampe n’analyse que les pages web/],
		["file:///etc/passwd", /^Rampe n’analyse pas les fichiers ouverts depuis l’ordinateur/],
		["https://chromewebstore.google.com/", /magasins d’extensions/],
	])("refuse %s avec un message clair", async (url, message) => {
		const popup = await openPopup({ fake: { id: 1, url } });
		await popup.getByRole("button", { name: "Analyser cette page" }).click();
		await expect.poll(() => status(popup)).toMatch(message);
		await expect(popup.locator("#etat").getAttribute("class")).resolves.toBe("erreur");
		await expect(popup.locator("#resultats").isHidden()).resolves.toBe(true);
		await popup.close();
	});
});
