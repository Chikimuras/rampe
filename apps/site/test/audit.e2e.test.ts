// Bout en bout de l'audit guidé (ADR-0013) : build réel du site, servi en local, piloté dans un vrai Chromium.
// Preuves : axe sans violation (clair, sombre, mobile) après interactions, parcours au clavier seul,
// reprise de la session, stockage indisponible ou corrompu, aucune autre page avec du JavaScript, et import d'un
// rapport produit par la VRAIE CLI (ADR-0014) sur sa page de test à défauts connus.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { rgaa } from "@rampe/core";
import { AUTO_EVALUATOR, buildAutoSession, parseFragment, serializeAutoSession } from "@rampe/core/auto-evaluation";
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
import { markdownToHast } from "satteri";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const astro = fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/src/cli.ts", import.meta.url));
const defauts = fileURLToPath(new URL("../../../packages/cli/test/fixtures/defauts.html", import.meta.url));
// Captures d'écran facultatives, pour la relecture humaine : RAMPE_CAPTURES=<dossier>.
const captures = process.env.RAMPE_CAPTURES;
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
};

let out: string;
let server: Server;
let base: string;
let browser: Browser;
/** Rapport JSON écrit par la CLI sur la page à défauts, servie à `fixtureUrl`. */
let reportPath: string;
let fixtureUrl: string;
let report: { pages: { results: { kind: string; criteria: string[] }[] }[] };

beforeAll(async () => {
	out = await mkdtemp(join(tmpdir(), "rampe-site-"));
	await new Promise<void>((resolve, reject) =>
		// NODE_ENV : vitest le fixe à « test », ce qui donnerait le JSX de développement (jsxDEV, chemins des sources).
		// Le budget se mesure sur le build de production, celui que la CI publie.
		execFile(
			process.execPath,
			[astro, "build", "--outDir", out],
			{ cwd: root, env: { ...process.env, NODE_ENV: "production" } },
			(error, _o, stderr) => (error ? reject(new Error(stderr)) : resolve()),
		),
	);
	server = createServer(async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		if (path === "/fixture/defauts")
			return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(defauts));
		if (!path.startsWith("/rampe/")) return res.writeHead(404).end();
		// normalize + préfixe : aucune requête ne sort du dossier de build.
		let file = normalize(join(out, path.slice("/rampe/".length)));
		if (!file.startsWith(out)) return res.writeHead(403).end();
		if (path.endsWith("/")) file = join(file, "index.html");
		try {
			const body = await readFile(file);
			res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rampe`;
	browser = await chromium.launch({ chromiumSandbox: true });
	if (captures) await mkdir(captures, { recursive: true });

	// La vraie CLI audite la page à défauts (1.1, 3.2, 8.3, 11.1) : elle sort en 1 puisqu'elle trouve des non-conformités.
	fixtureUrl = `${base.replace(/\/rampe$/, "")}/fixture/defauts`;
	reportPath = join(await mkdtemp(join(tmpdir(), "rampe-rapport-")), "rapport.json");
	await new Promise<void>((resolve, reject) =>
		execFile(process.execPath, [cli, "audit", fixtureUrl, "--json", reportPath], (error, _o, stderr) =>
			error && error.code !== 1 ? reject(new Error(stderr)) : resolve(),
		),
	);
	report = JSON.parse(await readFile(reportPath, "utf8"));
}, 180_000);

afterAll(async () => {
	await browser?.close();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (out) await rm(out, { recursive: true, force: true });
	if (reportPath) await rm(dirname(reportPath), { recursive: true, force: true });
});

/** Ouvre /audit/ et attend l'hydratation de l'îlot (Astro retire alors l'attribut `ssr`). */
async function openAudit(page: Page) {
	await page.goto(`${base}/audit/`);
	await expect(page.title()).resolves.toBe("Audit guidé · Rampe");
	await page.waitForSelector("astro-island:not([ssr])");
}

async function axeViolations(page: Page) {
	await page.evaluate(axe.source);
	return page.evaluate(async () => {
		const r = await (window as unknown as { axe: typeof axe }).axe.run();
		return r.violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
	});
}

const addPage = async (page: Page, url: string, title: string) => {
	await page.getByLabel("Adresse de la page").fill(url);
	await page.getByLabel("Nom de la page (facultatif)").fill(title);
	await page.getByRole("button", { name: "Ajouter la page" }).click();
};

/** Appuie sur Tab (ou Maj+Tab) jusqu'à ce que `predicate` soit vrai pour l'élément actif ; échoue au-delà de `max`. */
async function tabUntil(page: Page, predicate: string, { back = false, max = 80 } = {}) {
	for (let i = 0; i < max; i++) {
		await page.keyboard.press(back ? "Shift+Tab" : "Tab");
		if (await page.evaluate(`(el => ${predicate})(document.activeElement)`)) return;
	}
	throw new Error(`Focus jamais atteint : ${predicate}`);
}

/** Clique et intercepte le téléchargement ; aucune requête réseau pendant ce temps (Blob local). */
async function download(page: Page, button: string, press?: string) {
	const requests: string[] = [];
	const onRequest = (r: { url: () => string }) => {
		if (!r.url().startsWith("blob:")) requests.push(r.url());
	};
	page.on("request", onRequest);
	const [file] = await Promise.all([
		page.waitForEvent("download"),
		press ? page.keyboard.press(press) : page.getByRole("button", { name: button }).click(),
	]);
	const content = await readFile(await file.path(), "utf8");
	page.off("request", onRequest);
	expect(requests).toEqual([]);
	return {
		name: file.suggestedFilename(),
		content,
		get json() {
			return JSON.parse(content);
		},
	};
}

describe("audit guidé (bout en bout)", { timeout: 60_000 }, () => {
	it("seule /audit/ charge du JavaScript, et ce poids reste borné", async () => {
		const pages: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				if (e.isDirectory()) await walk(join(dir, e.name));
				else if (e.name.endsWith(".html")) pages.push(join(dir, e.name));
			}
		};
		await walk(out);
		const withScript = [];
		for (const p of pages) if (/<script\b/i.test(await readFile(p, "utf8"))) withScript.push(p.slice(out.length));
		expect(withScript).toEqual(["/audit/index.html"]);

		const page = await browser.newPage();
		const bodies: Promise<[raw: number, gzip: number]>[] = [];
		page.on("response", (r) => {
			if (r.url().endsWith(".js")) bodies.push(r.body().then((b) => [b.length, gzipSync(b, { level: 9 }).length]));
		});
		await openAudit(page);
		await page.waitForLoadState("networkidle");
		const files = bodies.length;
		const sizes = await Promise.all(bodies);
		const js = sizes.reduce((a, [raw]) => a + raw, 0);
		const gzip = sizes.reduce((a, [, z]) => a + z, 0);
		const inline = await page.evaluate(() =>
			[...document.querySelectorAll("script:not([src])")].reduce((n, s) => n + (s.textContent?.length ?? 0), 0),
		);
		console.log(
			`/audit/ : ${files} modules JS, ${js} octets non compressés, ${gzip} octets en gzip ; scripts en ligne d'Astro : ${inline} octets`,
		);
		expect(js).toBeGreaterThan(0);
		// Build de production : ni JSX de développement, ni chemin absolu de la machine de build dans le bundle.
		for (const name of await readdir(join(out, "_astro"))) {
			if (!name.endsWith(".js")) continue;
			const code = await readFile(join(out, "_astro", name), "utf8");
			expect(code.includes("jsxDEV"), `${name} : jsxDEV`).toBe(false);
			expect(code.includes(root.replace(/\/$/, "")), `${name} : chemin absolu`).toBe(false);
		}
		// Budget mesuré en gzip, ce que le réseau transporte réellement : 40 Ko pour /audit/. Historique en octets
		// bruts, mesuré jusqu'à l'ADR-0017 sur un build en NODE_ENV=test (JSX de développement, plus lourd) :
		// 62 299 (« Résultat », ADR-0015), 72 128 (sauvegarde, ADR-0016), 99 345 (déclaration, ADR-0017), soit
		// 32 683 octets en gzip. Depuis le schéma pluriannuel (ADR-0018), build de production : 108 290 octets bruts,
		// 37 461 en gzip.
		expect(gzip).toBeLessThan(40_000);
		await page.close();
	});

	it("parcours au clavier seul : ajouter une page, saisir un statut, passer au critère suivant", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await page.focus("body");

		await tabUntil(page, "el.id === 'audit-url'");
		await page.keyboard.type("https://exemple.fr/");
		await page.keyboard.press("Tab");
		await page.keyboard.type("Accueil");
		await page.keyboard.press("Shift+Tab"); // retour arrière possible, pas de piège
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-url");
		await tabUntil(page, "el.type === 'submit'");
		await page.keyboard.press("Enter");
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-url");

		// Groupe de radios : un seul arrêt de tabulation (la valeur cochée, « Non testé »), puis les flèches.
		await tabUntil(page, "el.name?.startsWith('statut-1.1-')");
		expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("NT");
		await page.keyboard.press("ArrowDown"); // NT est le dernier : la flèche revient au premier, « Conforme »
		await expect(page.getByLabel("Conforme", { exact: true }).isChecked()).resolves.toBe(true);
		await page.keyboard.press("ArrowDown");
		await expect(page.getByLabel("Non conforme", { exact: true }).isChecked()).resolves.toBe(true);
		await page.keyboard.press("Tab");
		await page.keyboard.type("Logo sans alternative");

		await tabUntil(page, "el.textContent === 'Critère suivant : 1.2'");
		await page.keyboard.press("Enter");
		// Le focus va sur le titre du nouveau critère.
		await page.waitForFunction(() => document.activeElement?.id === "audit-titre");
		expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(
			/^Critère 1\.2, thématique 1 « Images » /,
		);
		// Sauvegarde différée : on attend l'écriture avant de recharger.
		await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Logo sans alternative"));

		// Reprise après rechargement : la page et le statut sont toujours là.
		await page.reload();
		await page.waitForSelector("astro-island:not([ssr])");
		await expect(page.locator(".audit-page-list li").textContent()).resolves.toContain("Accueil");
		// Au rechargement, le parcours repart du critère 1.1.
		await expect(page.getByLabel("Non conforme", { exact: true }).isChecked()).resolves.toBe(true);
		await expect(page.getByLabel("Note sur Accueil (facultative)").inputValue()).resolves.toBe("Logo sans alternative");
		await page.close();
	});

	for (const [name, options] of [
		["clair", { colorScheme: "light" }],
		["sombre", { colorScheme: "dark" }],
		["mobile", { colorScheme: "light", viewport: { width: 375, height: 800 } }],
	] as const) {
		it(`axe : aucune violation après interactions (${name})`, async () => {
			const page = await browser.newPage(options);
			await openAudit(page);
			expect(await axeViolations(page), "état initial").toEqual([]);

			await addPage(page, "https://exemple.fr/", "Accueil");
			await addPage(page, "https://exemple.fr/contact", "Contact");
			await page.getByRole("button", { name: "Critère suivant : 1.2" }).click();
			await page
				.getByRole("group", { name: /^Critère 1\.2, page Accueil/ })
				.getByLabel("Non conforme", { exact: true })
				.check();
			await page
				.getByRole("group", { name: /^Critère 1\.2, page Contact/ })
				.getByLabel("Non applicable")
				.check();
			await page.getByLabel("Note sur Accueil (facultative)").fill("Image décorative annoncée");
			await page.getByRole("button", { name: "Critère précédent : 1.1" }).click();
			await page.getByRole("button", { name: "Critère suivant : 1.2" }).click();
			await page.getByLabel("Critères non conformes sur au moins une page").check();
			await expect(page.locator("[aria-live=polite]").textContent()).resolves.toBe("1 critère affiché");
			await page.getByRole("button", { name: /^2\. / }).click();
			await page.getByRole("button", { name: /^1\. / }).click();
			if (captures) await page.screenshot({ path: join(captures, `audit-${name}.png`), fullPage: true });
			for (const d of await page.locator("details").all())
				await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));

			expect(await axeViolations(page), "après interactions").toEqual([]);
			if (name === "mobile")
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
			await page.close();
		});
	}

	it("M1 : filtre sans résultat dans la thématique : message au lieu d'un critère hors filtre", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await page.getByLabel("Critères non conformes sur au moins une page").check();
		await expect(page.locator("[aria-live=polite]").textContent()).resolves.toBe("0 critère affiché");
		await expect.poll(() => page.locator("article").count()).toBe(0);
		await expect(
			page.getByText("Aucun critère ne correspond à ce filtre dans cette thématique.").count(),
		).resolves.toBe(1);
		await page.close();
	});

	it("M1 : filtre dont le critère affiché sort : saut au premier critère correspondant", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await page.getByLabel("Conforme", { exact: true }).check(); // 1.1 évalué
		await page.getByLabel("Critères avec des pages non testées").check();
		await expect(page.locator("[aria-live=polite]").textContent()).resolves.toBe(
			"105 critères affichés ; critère 1.2 affiché",
		);
		await expect(page.locator("#audit-titre").textContent()).resolves.toMatch(/^Critère 1\.2,/);
		await page.close();
	});

	it("M2 et M3 : changement de thématique annoncé, sauvegardes réussies silencieuses", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await page.getByRole("button", { name: /^3\. Couleurs/ }).click();
		await expect(page.locator("[aria-live=polite]").textContent()).resolves.toBe(
			"Thématique 3 « Couleurs » : critère 3.1 affiché",
		);
		await expect(page.locator("#audit-titre").textContent()).resolves.toMatch(
			/^Critère 3\.1, thématique 3 « Couleurs » /,
		);
		await page.getByLabel("Non applicable").check();
		await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"NA"'));
		await expect(page.locator("[aria-live=polite]").textContent()).resolves.toBe(
			"Thématique 3 « Couleurs » : critère 3.1 affiché",
		);
		await page.close();
	});

	it("C5 : groupe et note nomment le critère et la page ; aide visible sur les statuts", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/contact", "Contact");
		await expect(
			page.getByRole("group", { name: "Critère 1.1, page Contact (https://exemple.fr/contact)" }).count(),
		).resolves.toBe(1);
		await expect.poll(() => page.getByLabel("Note sur Contact (facultative)").count()).toBe(1);
		await expect(page.locator(".audit-pages-eval .audit-help").isVisible()).resolves.toBe(true);
		await expect(page.locator(".audit-pages-eval .audit-help").textContent()).resolves.toContain(
			"Non applicable : le contenu visé par ce critère n’existe pas sur la page.",
		);
		await page.close();
	});

	it("C1 : statuts avant les tests (repliés) ; liste des critères repliée sous 700 px", async () => {
		const distances: string[] = [];
		for (const width of [1280, 375]) {
			const page = await browser.newPage({ viewport: { width, height: 800 } });
			await openAudit(page);
			await addPage(page, "https://exemple.fr/", "Accueil");
			await addPage(page, "https://exemple.fr/contact", "Contact");
			const list = page.locator("details.audit-list");
			await expect.poll(() => list.count()).toBe(width < 700 ? 1 : 0);
			if (width < 700) await expect(list.evaluate((d) => (d as HTMLDetailsElement).open)).resolves.toBe(false);
			for (const id of ["1.1", "1.6"]) {
				if (id === "1.6") {
					if (width < 700) await page.locator("details.audit-list summary").click();
					await page.getByRole("button", { name: /^1\.6/ }).click();
				}
				const d = await page.evaluate(() => {
					const h = document.querySelector("#audit-titre")?.getBoundingClientRect().top ?? 0;
					const f = document.querySelector(".audit-page")?.getBoundingClientRect().top ?? 0;
					const tests = document.querySelector(".audit-criterion > details") as HTMLDetailsElement;
					return { gap: Math.round(f - h), testsOpen: tests.open, testsAfter: f < tests.getBoundingClientRect().top };
				});
				expect(d.testsOpen).toBe(false);
				expect(d.testsAfter).toBe(true);
				expect(d.gap).toBeLessThan(width < 700 ? 900 : 600);
				distances.push(`${id} à ${width} px : ${d.gap} px`);
			}
			await page.close();
		}
		console.log(`Distance titre du critère → 1er groupe de statuts : ${distances.join(" ; ")}`);
	});

	it("C2 : après « Retirer », focus sur le « Retirer » suivant, sinon précédent, sinon le titre de section", async () => {
		const page = await browser.newPage();
		page.on("dialog", (d) => d.accept());
		await openAudit(page);
		for (const n of ["a", "b", "c"]) await addPage(page, `https://exemple.fr/${n}`, n.toUpperCase());
		const focused = () => page.evaluate(() => document.activeElement?.textContent);
		await page.getByRole("button", { name: "Retirer B" }).click();
		await page.waitForFunction(() => document.querySelectorAll(".audit-page-list li").length === 2);
		await expect(focused()).resolves.toBe("Retirer C");
		await page.getByRole("button", { name: "Retirer C" }).click();
		await page.waitForFunction(() => document.querySelectorAll(".audit-page-list li").length === 1);
		await expect(focused()).resolves.toBe("Retirer A");
		await page.getByRole("button", { name: "Retirer A" }).click();
		await page.waitForFunction(() => document.activeElement?.id === "audit-echantillon");
		await page.close();
	});

	it("C4 : stockage plein : alerte, puis nouvel essai et alerte retirée dès qu'une écriture réussit", async () => {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if ((window as unknown as { plein?: boolean }).plein && key === "rampe.audit.session")
					throw new DOMException("plein", "QuotaExceededError");
				setItem.call(this, key, value);
			};
		});
		await openAudit(page);
		await page.evaluate(() => {
			(window as unknown as { plein: boolean }).plein = true;
		});
		await addPage(page, "https://exemple.fr/", "Accueil");
		const alert = page.getByRole("alert");
		await alert.waitFor();
		await expect(alert.textContent()).resolves.toContain("Échec de l’enregistrement.");
		await page.waitForFunction(
			() => document.querySelector("[aria-live=polite]")?.textContent === "Échec de l’enregistrement",
		);
		await page.getByLabel("Conforme", { exact: true }).check(); // nouvel essai : toujours plein
		await page.waitForTimeout(600);
		await expect.poll(() => alert.count()).toBe(1);
		await page.evaluate(() => {
			(window as unknown as { plein: boolean }).plein = false;
		});
		await page.getByLabel("Non conforme", { exact: true }).check();
		await alert.waitFor({ state: "detached" });
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session"))).resolves.toContain('"NC"');
		await page.close();
	});

	it("B1 : deux onglets : l'onglet ouvert avant adopte les écritures de l'autre, rien n'est perdu", async () => {
		const context = await browser.newContext();
		const a = await context.newPage();
		const b = await context.newPage();
		await openAudit(a);
		await openAudit(b); // B est ouvert avant toute saisie dans A
		await addPage(a, "https://exemple.fr/", "Accueil");
		await a.getByLabel("Non conforme", { exact: true }).check();
		await a.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"NC"'));
		await b.waitForFunction(
			() => document.querySelector("[aria-live=polite]")?.textContent === "Audit mis à jour depuis un autre onglet",
		);
		await addPage(b, "https://exemple.fr/contact", "Contact"); // écriture de B après celle de A
		await b.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Contact"));
		await a.reload();
		await a.waitForSelector("astro-island:not([ssr])");
		await expect(a.locator(".audit-page-list li").allTextContents()).resolves.toEqual([
			expect.stringContaining("Accueil"),
			expect.stringContaining("Contact"),
		]);
		await expect(
			a
				.getByRole("group", { name: /page Accueil/ })
				.getByLabel("Non conforme", { exact: true })
				.isChecked(),
		).resolves.toBe(true);
		await context.close();
	});

	it("accepte un echantillon.txt collé, avec la même lecture que la CLI", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await page.getByText("Coller un fichier echantillon.txt").click();
		await page
			.getByLabel(/^Contenu du fichier/)
			.fill("# accueil\nhttps://exemple.fr/\n\n# hasard — x\nhttps://exemple.fr/a\nhttps://autre.fr/");
		await page.getByRole("button", { name: "Ajouter ces pages" }).click();
		await expect(page.locator("#audit-fichier-message").textContent()).resolves.toContain(
			"ligne 6 : https://autre.fr/ n’est pas sur la même origine",
		);
		await page
			.getByLabel(/^Contenu du fichier/)
			.fill("# accueil\nhttps://exemple.fr/\n# hasard — x\nhttps://exemple.fr/a\n");
		await page.getByRole("button", { name: "Ajouter ces pages" }).click();
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(2);
		await page.close();
	});

	it("refuse une adresse invalide ou d'un autre site, avec un message relié au champ", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "exemple.fr", "");
		const field = page.getByLabel("Adresse de la page");
		await expect(field.getAttribute("aria-invalid")).resolves.toBe("true");
		await expect(page.locator("#audit-url-erreur").textContent()).resolves.toMatch(/URL invalide/);
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-url");
		await addPage(page, "https://exemple.fr/", "");
		await addPage(page, "https://autre.fr/", "");
		await expect(page.locator("#audit-url-erreur").textContent()).resolves.toMatch(/un seul site/);
		await page.close();
	});

	it("stockage indisponible : bandeau persistant, l'outil fonctionne quand même", async () => {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			Object.defineProperty(window, "localStorage", {
				get() {
					throw new DOMException("refusé", "SecurityError");
				},
			});
		});
		await openAudit(page);
		await expect
			.poll(() => page.getByText("Votre travail ne sera pas conservé si vous fermez cette page.").count())
			.toBe(1);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
		await page.close();
	});

	/** Copies mises de côté, dans l'ordre d'écriture (numéro de clé). */
	const copies = (page: Page) =>
		page.evaluate(() =>
			Object.keys(localStorage)
				.map((k) => /^rampe\.audit\.session\.ignoree\.(\d+)\./.exec(k))
				.filter((m) => m !== null)
				.sort((a, b) => Number(a[1]) - Number(b[1]))
				.map((m) => localStorage.getItem(m.input)),
		);

	it("session corrompue : mise de côté sous une clé horodatée, jamais écrasée (3 copies au plus), téléchargeable", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		const asides = () => copies(page);
		// Copie unique laissée par une version précédente : jamais touchée.
		await page.evaluate(() => localStorage.setItem("rampe.audit.session.ignoree", "ancienne copie"));
		const broken = (n: number) => `{"schemaVersion":2,"pages":"abîmé ${n}"}`;
		for (const n of [1, 2, 3, 4]) {
			await page.evaluate((v) => localStorage.setItem("rampe.audit.session", v), broken(n));
			await page.reload();
			await page.waitForSelector("astro-island:not([ssr])");
			await expect.poll(() => page.getByText(/n’a pas pu être relue/).count()).toBe(1);
			if (n === 1) {
				const [file] = await Promise.all([
					page.waitForEvent("download"),
					page.getByRole("button", { name: "Télécharger la session mise de côté" }).click(),
				]);
				expect(await readFile(await file.path(), "utf8")).toBe(broken(1));
				if (captures)
					await page.locator(".audit-banner").screenshot({ path: join(captures, "session-mise-de-cote.png") });
			}
		}
		// Les 3 dernières copies ; la plus ancienne n'est retirée qu'au-delà de 3.
		await expect(asides()).resolves.toEqual([broken(2), broken(3), broken(4)]);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session.ignoree"))).resolves.toBe(
			"ancienne copie",
		);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
		await page.close();
	});

	it("session corrompue et stockage plein : rien n'est écrit tant qu'elle n'est pas téléchargée", async () => {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			if (!sessionStorage.getItem("seeded")) {
				localStorage.setItem("rampe.audit.session", '{"schemaVersion":2,"pages":"abîmé"}');
				sessionStorage.setItem("seeded", "1");
			}
			const set = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (key.startsWith("rampe.audit.session.ignoree")) throw new DOMException("plein", "QuotaExceededError");
				return set.call(this, key, value);
			};
		});
		await openAudit(page);
		await expect(page.getByRole("alert").textContent()).resolves.toMatch(/ni mise de côté \(stockage plein\)/);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await page.waitForTimeout(600);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session"))).resolves.toBe(
			'{"schemaVersion":2,"pages":"abîmé"}',
		);
		const [file] = await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("button", { name: "Télécharger la session mise de côté" }).click(),
		]);
		expect(await readFile(await file.path(), "utf8")).toBe('{"schemaVersion":2,"pages":"abîmé"}');
		// Téléchargement lancé, mais peut-être annulé : toujours aucune écriture sans confirmation explicite.
		await addPage(page, "https://exemple.fr/contact", "Contact");
		await page.waitForTimeout(600);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session"))).resolves.toBe(
			'{"schemaVersion":2,"pages":"abîmé"}',
		);
		await page.getByRole("button", { name: "J’ai bien enregistré le fichier, continuer" }).click();
		await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Contact"));
		await page.close();
	});

	it("contre-relecture 1 : rechargements répétés : aucune recopie, une copie plus ancienne et distincte survit", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await page.evaluate(() => {
			localStorage.setItem("rampe.audit.session.ignoree.1.2026-01-01T00:00:00.000Z", "X du 1er janvier");
			localStorage.setItem("rampe.audit.session", '{"schemaVersion":2,"pages":"Y illisible"}');
		});
		for (let i = 0; i < 5; i++) {
			await page.reload();
			await page.waitForSelector("astro-island:not([ssr])");
		}
		await expect(copies(page)).resolves.toEqual(["X du 1er janvier", '{"schemaVersion":2,"pages":"Y illisible"}']);
		await page.close();
	});

	it("contre-relecture 2 : horloge en arrière : la copie neuve n'est jamais purgée, l'ordre d'écriture fait foi", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await page.evaluate(() => {
			// Copies écrites quand l'horloge avançait de 70 ans : leurs noms sont « plus récents » que la copie neuve.
			for (const n of [1, 2, 3])
				localStorage.setItem(`rampe.audit.session.ignoree.${n}.2099-01-0${n}T00:00:00.000Z`, `copie ${n}`);
			localStorage.setItem("rampe.audit.session", '{"schemaVersion":2,"pages":"Z"}');
		});
		await page.reload();
		await page.waitForSelector("astro-island:not([ssr])");
		// Copie gardée (pas d'alerte de stockage plein), la plus ancienne ÉCRITE retirée.
		await expect.poll(() => page.getByText(/ni mise de côté/).count()).toBe(0);
		await expect(copies(page)).resolves.toEqual(["copie 2", "copie 3", '{"schemaVersion":2,"pages":"Z"}']);
		await page.close();
	});

	it("session écrite par main aux valeurs limites : relue, affichée et gardée intacte ; export signalé", async () => {
		const raw = await readFile(
			fileURLToPath(new URL("../../../packages/core/test/fixtures/session-main-v2-limites.json", import.meta.url)),
			"utf8",
		);
		const value = JSON.parse(raw);
		const text = JSON.stringify(value);
		const [FA] = value.pages.map((p: { id: string }) => p.id);
		const page = await browser.newPage();
		await page.addInitScript((v) => {
			if (!sessionStorage.getItem("seeded")) {
				localStorage.setItem("rampe.audit.session", v);
				sessionStorage.setItem("seeded", "1");
			}
		}, text);
		await openAudit(page);
		await page.reload();
		await page.waitForSelector("astro-island:not([ssr])");
		await expect.poll(() => page.getByText(/n’a pas pu être relue/).count()).toBe(0);
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(2);
		await expect(page.locator(`#processus-${FA}`).inputValue()).resolves.toBe(value.pages[0].process);
		await expect(page.locator(`[id="note-1.1-${FA}"]`).inputValue()).resolves.toBe(value.evaluations["1.1"][FA].note);
		await expect(page.locator(".audit-page-list li").first().textContent()).resolves.toContain(value.pages[0].url);
		await page.waitForTimeout(600);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session"))).resolves.toBe(text);
		await expect(page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("ignoree")))).resolves.toEqual(
			[],
		);
		// Export : fichier complet, mais l'utilisateur est prévenu que l'import le bornera.
		await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("button", { name: "Télécharger l’audit (JSON)" }).click(),
		]);
		await expect(page.locator("#audit-telechargement-alerte > p").textContent()).resolves.toMatch(
			/^Attention : cet audit contient/,
		);
		await expect(page.locator("#audit-telechargement-alerte details > p").textContent()).resolves.toMatch(
			/adresse de plus de 2048 caractères/,
		);
		await page.close();
	});

	it("bornes à l'écriture : adresse trop longue une fois encodée refusée, avec un message relié au champ", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, `https://exemple.fr/${"é".repeat(700)}`, "");
		await expect(page.locator("#audit-url-erreur").textContent()).resolves.toMatch(/^Adresse trop longue/);
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(0);
		await page.close();
	});

	it("« Recommencer » demande confirmation puis efface l'audit", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/", "Accueil");
		page.once("dialog", (d) => d.dismiss());
		await page.getByRole("button", { name: "Effacer cet audit et recommencer" }).click();
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
		page.once("dialog", (d) => d.accept());
		await page.getByRole("button", { name: "Effacer cet audit et recommencer" }).click();
		await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(0);
		await page.close();
	});

	describe("import d'un rapport de la CLI (ADR-0014)", () => {
		const IMPORT_LABEL = "Importer un rapport automatique (CLI ou extension, JSON)";
		const live = (page: Page) => page.locator("[aria-live=polite]").textContent();
		const stored = (page: Page) => page.evaluate(() => localStorage.getItem("rampe.audit.session"));
		const group = (page: Page, criterion: string) =>
			page.getByRole("group", { name: new RegExp(`^Critère ${criterion.replace(".", "\\.")}, page Défauts`) });
		const showCriterion = async (page: Page, id: string) => {
			const topic = id.split(".")[0];
			await page.getByRole("button", { name: new RegExp(`^${topic}\\. `) }).click();
			await page.getByRole("button", { name: new RegExp(`^${id.replace(".", "\\.")}(?!\\d)`) }).click();
		};
		/** Critères en non-conformité dans le rapport réel, hors 1.1 que l'humain a déjà évalué. */
		const autoCriteria = () =>
			[
				...new Set(
					report.pages[0]?.results.filter((r) => r.kind === "non-conformite").flatMap((r) => r.criteria) ?? [],
				),
			].filter((c) => c !== "1.1");

		/** Page à défauts ajoutée, critère 1.1 évalué « Conforme » par l'humain, puis import du rapport. */
		async function importScenario(page: Page) {
			await openAudit(page);
			await addPage(page, fixtureUrl, "Défauts");
			await group(page, "1.1").getByLabel("Conforme", { exact: true }).check();
			await page.getByLabel(IMPORT_LABEL).setInputFiles(reportPath);
			await page.locator(".audit-import-summary").waitFor();
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"auto"'));
		}

		it("NC à confirmer sur les bons critères, évaluation humaine intacte, indices visibles", async () => {
			expect(autoCriteria()).toEqual(expect.arrayContaining(["3.2", "8.3", "11.1"]));
			const page = await browser.newPage();
			await importScenario(page);
			const n = autoCriteria().length;
			await expect(live(page)).resolves.toMatch(
				new RegExp(`^Import terminé : 0 page ajoutée, ${n} statuts « Non conforme » à confirmer, \\d+ indices\\.`),
			);
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);

			// 1.1 : l'humain avait dit « Conforme » ; l'import n'y touche pas, mais l'indice image-alt est visible.
			const g11 = group(page, "1.1");
			await expect(g11.getByLabel("Conforme", { exact: true }).isChecked()).resolves.toBe(true);
			await expect.poll(() => g11.locator(".audit-auto").count()).toBe(0);
			// Conflit : l'outil a trouvé une non-conformité là où l'humain a dit « Conforme ».
			await expect(g11.locator(".audit-conflict").textContent()).resolves.toBe(
				"L’outil a détecté une non-conformité sur cette page : vérifiez votre évaluation.",
			);
			if (captures) await g11.screenshot({ path: join(captures, "import-conflit.png") });
			// Compteur et filtre « à confirmer ».
			await expect(page.locator(".audit-to-confirm").textContent()).resolves.toBe(
				`Dont ${n} statuts détectés automatiquement, à confirmer.`,
			);
			await page.getByLabel("Critères avec des statuts détectés automatiquement, à confirmer").check();
			await expect(live(page)).resolves.toMatch(new RegExp(`^${n} critères affichés`));
			await page.getByLabel("Tous les critères").check();
			await g11.getByText(/^Indices de l’audit automatique pour Défauts/).click();
			await expect(g11.locator(".audit-findings li").first().textContent()).resolves.toMatch(
				/^Non-conformité détectée : règle image-alt « Images must have alternative text », 1 élément concerné$/,
			);
			await expect(g11.locator('.audit-findings [lang="en"]').first().textContent()).resolves.toBe(
				"Images must have alternative text",
			);

			for (const id of autoCriteria()) {
				await showCriterion(page, id);
				const g = group(page, id);
				await expect(g.getByLabel("Non conforme", { exact: true }).isChecked(), id).resolves.toBe(true);
				await expect(g.locator(".audit-auto").textContent()).resolves.toMatch(
					/^Détecté automatiquement, à confirmer\./,
				);
				await expect(g.getByLabel("Note sur Défauts (facultative)").inputValue()).resolves.toMatch(
					/^Détecté automatiquement : [a-z-]+ \(\d+ éléments?\)/,
				);
			}
			// Un critère sans résultat reste « non testé » : l'automatique ne conclut jamais à la conformité.
			await showCriterion(page, "1.2");
			await expect(group(page, "1.2").getByLabel("Non testé").isChecked()).resolves.toBe(true);

			// La confirmation humaine (même une note) fait disparaître la mention « à confirmer ».
			await showCriterion(page, "3.2");
			await group(page, "3.2").getByLabel("Note sur Défauts (facultative)").fill("Contraste vérifié : 2,0:1");
			await expect.poll(() => group(page, "3.2").locator(".audit-auto").count()).toBe(0);
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("2,0:1"));
			const saved = JSON.parse((await stored(page)) ?? "{}");
			expect(saved.schemaVersion).toBe(5);
			const [pageId] = saved.pages.map((p: { id: string }) => p.id);
			expect(saved.evaluations["1.1"][pageId]).toMatchObject({ status: "C", source: "humain" });
			expect(saved.evaluations["3.2"][pageId]).toMatchObject({ status: "NC", source: "humain" });
			expect(saved.evaluations["8.3"][pageId]).toMatchObject({ status: "NC", source: "auto" });
			// Plus d'annulation possible après une autre modification.
			await expect.poll(() => page.getByRole("button", { name: "Annuler cet import" }).count()).toBe(0);
			await page.close();
		});

		it("« Confirmer » garde le statut et le rend humain ; changer un statut automatique vide la note générée", async () => {
			const page = await browser.newPage();
			await importScenario(page);
			await showCriterion(page, "8.3");
			const g = group(page, "8.3");
			await g.getByRole("button", { name: "Confirmer « Non conforme » pour Défauts" }).click();
			await expect.poll(() => g.locator(".audit-auto").count()).toBe(0);
			await expect(g.getByLabel("Non conforme", { exact: true }).isChecked()).resolves.toBe(true);
			expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("NC");
			await expect(live(page)).resolves.toBe("Statut « Non conforme » confirmé pour Défauts, critère 8.3");
			await expect(g.getByLabel("Note sur Défauts (facultative)").inputValue()).resolves.toMatch(/^Détecté/);

			await showCriterion(page, "11.1");
			const g11 = group(page, "11.1");
			await g11.getByLabel("Non applicable").check();
			await expect(g11.getByLabel("Note sur Défauts (facultative)").inputValue()).resolves.toBe("");
			await page.waitForFunction(() => {
				const s = JSON.parse(localStorage.getItem("rampe.audit.session") ?? "{}");
				return Object.values(s.evaluations?.["11.1"] ?? {}).some((e) => (e as { status: string }).status === "NA");
			});
			const saved = JSON.parse((await stored(page)) ?? "{}");
			const [pageId] = saved.pages.map((p: { id: string }) => p.id);
			expect(saved.evaluations["8.3"][pageId]).toMatchObject({ status: "NC", source: "humain" });
			expect(saved.evaluations["11.1"][pageId]).toEqual({ status: "NA", note: "", source: "humain" });
			await page.close();
		});

		it("réimporter le même fichier ne duplique rien", async () => {
			const page = await browser.newPage();
			await importScenario(page);
			const once = JSON.parse((await stored(page)) ?? "{}");
			await page.getByLabel(IMPORT_LABEL).setInputFiles(reportPath);
			await page.waitForFunction(() =>
				document
					.querySelector("[aria-live=polite]")
					?.textContent?.startsWith("Import terminé : 0 page ajoutée, 0 statut"),
			);
			await expect(live(page)).resolves.toMatch(/, 0 indice\./);
			// On attend l'écriture du réimport (updatedAt change) avant de comparer : sinon on relirait l'ancienne.
			await page.waitForFunction(
				(before) => JSON.parse(localStorage.getItem("rampe.audit.session") ?? "{}").updatedAt !== before,
				once.updatedAt,
			);
			const twice = JSON.parse((await stored(page)) ?? "{}");
			expect({ ...twice, updatedAt: "" }).toEqual({ ...once, updatedAt: "" });
			await page.close();
		});

		for (const colorScheme of ["light", "dark"] as const) {
			it(`axe : aucune violation après import, indices ouverts (${colorScheme === "light" ? "clair" : "sombre"})`, async () => {
				const page = await browser.newPage({ colorScheme });
				await importScenario(page);
				await showCriterion(page, "3.2");
				await page.locator(".audit-findings summary").click();
				// État vérifié par axe (le gate « Rampe audite Rampe » ne voit que la page chargée, ADR-0021) : section 2
				// avec la page importée et un critère affiché, statut automatique et indices.
				await expect(group(page, "3.2").isVisible()).resolves.toBe(true);
				await expect(page.locator(".audit-findings").isVisible()).resolves.toBe(true);
				if (captures) {
					await page.locator(".audit-import").screenshot({ path: join(captures, `import-bilan-${colorScheme}.png`) });
					await page.locator(".audit-page").screenshot({ path: join(captures, `import-critere-${colorScheme}.png`) });
				}
				for (const d of await page.locator("details").all())
					await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));
				expect(await axeViolations(page)).toEqual([]);
				await page.close();
			});
		}

		it("« Annuler cet import » restaure l'état précédent", async () => {
			const page = await browser.newPage();
			await importScenario(page);
			await page.getByRole("button", { name: "Annuler cet import" }).click();
			await expect(live(page)).resolves.toBe("Import annulé : l’audit est revenu à son état d’avant l’import.");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-rapport");
			await expect(group(page, "1.1").getByLabel("Conforme", { exact: true }).isChecked()).resolves.toBe(true);
			await expect.poll(() => page.locator(".audit-findings").count()).toBe(0);
			await showCriterion(page, "3.2");
			await expect(group(page, "3.2").getByLabel("Non testé").isChecked()).resolves.toBe(true);
			await page.waitForFunction(() => {
				const saved = localStorage.getItem("rampe.audit.session");
				return saved?.includes("Défauts") && !saved.includes('"auto"');
			});
			const saved = JSON.parse((await stored(page)) ?? "{}");
			expect(saved.findings).toEqual({});
			await page.close();
		});

		it("fichier hostile, trop gros ou d'un autre site : refusé, message relié au champ, session intacte", async () => {
			const page = await browser.newPage();
			await openAudit(page);
			await addPage(page, fixtureUrl, "Défauts");
			await group(page, "1.1").getByLabel("Non applicable").check();
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"NA"'));
			const before = await stored(page);
			const input = page.getByLabel(IMPORT_LABEL);
			const hostile = JSON.parse(await readFile(reportPath, "utf8"));
			const invalid =
				"Ce fichier n’est pas un rapport automatique de Rampe (CLI ou extension), ou il a été modifié. Rien n’a été importé.";
			const cases: [string, Buffer, string | RegExp, RegExp | null][] = [
				[
					"proto.json",
					Buffer.from(JSON.stringify(hostile).replace('"pages":', '"__proto__":{"polluted":true},"pages":')),
					invalid,
					/clé interdite « __proto__ »/,
				],
				[
					"critere.json",
					Buffer.from(JSON.stringify(hostile).replace('"criteria":["1.1"]', '"criteria":["99.1"]')),
					invalid,
					/critère "99\.1" inexistant/,
				],
				["casse.json", Buffer.from("{ pas du JSON"), /^Ce fichier n’est pas un fichier JSON lisible/, null],
				["enorme.json", Buffer.alloc(21 * 1024 * 1024, " "), /^Fichier trop volumineux \(21 Mo\)/, null],
			];
			const error = page.locator("#audit-rapport-erreur");
			for (const [name, buffer, message, detail] of cases) {
				await input.setInputFiles({ name, mimeType: "application/json", buffer });
				// Phrase claire d'abord ; le détail technique, s'il y en a un, est replié dessous.
				await expect.poll(() => error.locator("> p").textContent(), { message: name }).toMatch(message);
				await expect.poll(() => error.locator("details").count()).toBe(detail ? 1 : 0);
				if (detail) {
					await expect(error.locator("details").evaluate((d) => (d as HTMLDetailsElement).open)).resolves.toBe(false);
					await expect(error.locator("summary").textContent()).resolves.toBe("Détail technique");
					await expect(error.locator("details > p").textContent()).resolves.toMatch(detail);
					if (captures && name === "critere.json") {
						await error.locator("summary").click();
						await page.locator(".audit-import").screenshot({ path: join(captures, "import-refus.png") });
						await error.locator("summary").click();
					}
				}
				await expect(input.getAttribute("aria-describedby")).resolves.toContain("audit-rapport-erreur");
				await expect(input.getAttribute("aria-invalid")).resolves.toBe("true");
				await expect(live(page)).resolves.toMatch(message);
			}
			expect(await page.evaluate(() => "polluted" in {})).toBe(false);
			await page.waitForTimeout(600);
			expect(await stored(page)).toBe(before);
			await expect.poll(() => page.locator(".audit-import-summary").count()).toBe(0);
			await page.close();

			// Autre site : l'audit en cours porte sur exemple.fr.
			const other = await browser.newPage();
			await openAudit(other);
			await addPage(other, "https://exemple.fr/", "Accueil");
			await other.getByLabel(IMPORT_LABEL).setInputFiles(reportPath);
			await expect(other.locator("#audit-rapport-erreur").textContent()).resolves.toMatch(
				/^Ce rapport porte sur un autre site \(http:\/\/127\.0\.0\.1:\d+\) que l’audit en cours \(https:\/\/exemple\.fr\)\./,
			);
			await expect.poll(() => other.locator(".audit-page-list li").count()).toBe(1);
			await other.close();
		});

		it("au clavier seul : choisir le fichier, puis annuler l'import", async () => {
			const page = await browser.newPage();
			await openAudit(page);
			await addPage(page, fixtureUrl, "Défauts");
			await page.focus("body");
			await tabUntil(page, "el.id === 'audit-rapport'");
			const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Space")]);
			await chooser.setFiles(reportPath);
			await page.locator(".audit-import-summary").waitFor();
			await tabUntil(page, "el.textContent === 'Annuler cet import'");
			await page.keyboard.press("Enter");
			await expect(live(page)).resolves.toBe("Import annulé : l’audit est revenu à son état d’avant l’import.");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-rapport");
			await expect(group(page, "1.1").getByLabel("Non testé").isChecked()).resolves.toBe(true);
			await page.close();
		});
	});

	it("session d'une version plus récente : avertissement, et rien n'est écrasé", async () => {
		const page = await browser.newPage();
		const future = JSON.stringify({ schemaVersion: 99, pages: [], future: "données" });
		await page.addInitScript((value) => {
			if (!sessionStorage.getItem("seeded")) {
				localStorage.setItem("rampe.audit.session", value);
				sessionStorage.setItem("seeded", "1");
			}
		}, future);
		await openAudit(page);
		await expect(page.getByRole("alert").textContent()).resolves.toMatch(
			/^Cet audit a été créé par une version plus récente de Rampe : rechargez la page\./,
		);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await page.waitForTimeout(600);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session"))).resolves.toBe(future);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session.ignoree"))).resolves.toBeNull();
		await page.close();
	});

	// Taux de conformité (ADR-0015). Une session complète demande 106 critères × 3 pages : elle est INJECTÉE dans le
	// stockage local (même format que ce que l'outil écrit, relu par parseSession), pas saisie clic par clic. Le
	// processus, lui, est saisi au clavier : c'est lui qui fait passer le taux moyen de 77,77 % à 61,11 %.
	const [P1, P2, P3] = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string];
	const PCT = "\u202f%";
	/** Adresses nues, www., e-mail et <…> : liens http(s) ou mailto admis en Markdown, aucun autre schéma. */
	const LINKS =
		" https://exemple.fr/nue www.exemple.fr contact@exemple.fr <http://exemple.fr/chevrons> <javascript:alert(9)> data:text/html,x";
	/** Tout NA sur les 3 pages, sauf 1.1, 3.2 et 8.3 (exemple chiffré du test de conformity.ts). */
	function sessionJson(
		patch: (evaluations: Record<string, Record<string, unknown>>, session: Record<string, unknown>) => void = () => {},
	) {
		const evaluations: Record<string, Record<string, unknown>> = {};
		const e = (status: string) => ({ status, note: "", source: "humain" });
		for (const c of rgaa.criteria) evaluations[c.id] = { [P1]: e("NA"), [P2]: e("NA"), [P3]: e("NA") };
		evaluations["1.1"] = { [P1]: e("C"), [P2]: e("C"), [P3]: e("NC") };
		evaluations["3.2"] = { [P1]: e("C"), [P2]: e("C"), [P3]: e("C") };
		evaluations["8.3"] = { [P1]: e("NC"), [P2]: e("NA"), [P3]: e("C") };
		const at = "2026-10-15T10:00:00.000Z";
		const session: Record<string, unknown> = {
			schemaVersion: 2,
			site: "https://exemple.fr",
			createdAt: at,
			updatedAt: at,
			pages: [
				{ id: P1, url: "https://exemple.fr/", title: "Accueil" },
				{ id: P2, url: "https://exemple.fr/panier", title: "Panier" },
				{ id: P3, url: "https://exemple.fr/paiement", title: "Paiement" },
			],
			evaluations,
			findings: {},
		};
		patch(evaluations, session);
		return JSON.stringify(session);
	}
	async function openWith(page: Page, json: string) {
		await page.addInitScript((value) => {
			if (!sessionStorage.getItem("seeded")) {
				localStorage.setItem("rampe.audit.session", value);
				sessionStorage.setItem("seeded", "1");
			}
		}, json);
		await openAudit(page);
	}
	const rates = (page: Page) => page.locator(".audit-rate").allTextContents();
	const rows = (page: Page) =>
		page
			.locator(".audit-result tbody tr")
			.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
	/**
	 * Processus saisi au clavier seul : « Commande » sur Panier, « commande  » (casse et espace différentes) sur
	 * Paiement. Les deux forment un seul processus, affiché « Commande » (premier libellé saisi).
	 */
	async function typeProcess(page: Page) {
		await page.focus("body");
		for (const [id, name] of [
			[P2, "Commande"],
			[P3, "commande  "],
		]) {
			await tabUntil(page, `el.id === 'processus-${id}'`);
			await page.keyboard.type(name as string);
		}
	}

	describe("taux de conformité (ADR-0015)", () => {
		it("processus saisi au clavier ; taux exactement égaux au calcul à la main", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			// Sans processus (calcul à la main) : Accueil 2/3, Panier 1/1 (1.1 C, 3.2 C, le reste NA), Paiement 2/3.
			// Global : 1 validé (3.2) ÷ 3 applicables = 33,333… ; moyen : (66,666… + 100 + 66,666…) ÷ 3 = 77,777…
			await expect(rates(page)).resolves.toEqual([`33,33${PCT}`, `77,77${PCT}`]);

			await typeProcess(page);
			// Avec « Commande » (Panier + Paiement) : 1.1 NC sur Paiement invalide 1.1 sur Panier → Panier 1/2 = 50.
			// Moyen : (66,666… + 50 + 66,666…) ÷ 3 = 61,111… ; global inchangé.
			await expect(rates(page)).resolves.toEqual([`33,33${PCT}`, `61,11${PCT}`]);
			// Page, processus, validés, non validés, non applicables (106 - 3 + NA propres), taux.
			await expect(rows(page)).resolves.toEqual([
				["Accueil", "aucun", "2", "1", "103", `66,66${PCT}`],
				["Panier", "Commande", "1", "1", "104", `50${PCT}`],
				["Paiement", "Commande", "2", "1", "103", `66,66${PCT}`],
			]);
			await expect(page.locator(".audit-failed a").allTextContents()).resolves.toEqual([
				expect.stringMatching(/^Critère 1\.1 : /),
				expect.stringMatching(/^Critère 8\.3 : /),
			]);
			await expect(page.locator(".audit-result").textContent()).resolves.toContain(
				"Ce taux mesure la conformité de votre échantillon ; il n’est pas une certification.",
			);
			// Le processus est enregistré comme le reste.
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"process":"Commande"'));
			await page.close();
		});

		it("une évaluation non testée et un statut à confirmer : aucun pourcentage nulle part", async () => {
			const page = await browser.newPage();
			await openWith(
				page,
				sessionJson((ev) => {
					delete (ev["11.1"] as Record<string, unknown>)[P1];
					(ev["8.3"] as Record<string, unknown>)[P1] = { status: "NC", note: "Détecté", source: "auto" };
				}),
			);
			await expect(page.locator(".audit-result strong").first().textContent()).resolves.toBe(
				"Audit incomplet : 1 évaluation restante, 1 statut à confirmer.",
			);
			expect(await page.evaluate(() => document.body.innerText)).not.toContain("%");
			await page.getByRole("button", { name: "Afficher les critères non testés" }).click();
			await page.waitForFunction(() => document.activeElement?.id === "audit-titre");
			expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/^Critère 11\.1, /);
			await expect(page.getByLabel("Critères avec des pages non testées").isChecked()).resolves.toBe(true);
			await page.getByRole("button", { name: "Afficher les statuts à confirmer" }).click();
			await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Critère 8.3, "));
			await page.close();
		});

		for (const colorScheme of ["light", "dark"] as const) {
			it(`axe : aucune violation sur le résultat (${colorScheme === "light" ? "clair" : "sombre"})`, async () => {
				const page = await browser.newPage({ colorScheme });
				await openWith(page, sessionJson());
				await typeProcess(page);
				await expect(rates(page)).resolves.toEqual([`33,33${PCT}`, `61,11${PCT}`]);
				if (captures) {
					await page.locator(".audit-result").screenshot({ path: join(captures, `resultat-${colorScheme}.png`) });
					await page.locator(".audit-sample").screenshot({ path: join(captures, `processus-${colorScheme}.png`) });
				}
				expect(await axeViolations(page)).toEqual([]);
				await page.close();
			});
		}

		it("axe à 320 px : tableau dans une région qui défile, aucune violation, pas de défilement de page", async () => {
			const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
			await openWith(page, sessionJson());
			await typeProcess(page);
			await expect(rates(page)).resolves.toEqual([`33,33${PCT}`, `61,11${PCT}`]);
			const region = page.getByRole("region", { name: "Résultat par page" });
			await expect.poll(() => region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
			await region.focus();
			await page.keyboard.press("ArrowRight");
			// Défilement éventuellement animé : on attend qu'il ait eu lieu.
			await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
			if (captures) await page.locator(".audit-result").screenshot({ path: join(captures, "resultat-320.png") });
			expect(await axeViolations(page)).toEqual([]);
			await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
			await page.close();
		});

		it("axe : aucune violation sur un résultat incomplet (clair)", async () => {
			const page = await browser.newPage();
			await openWith(
				page,
				sessionJson((ev) => {
					delete (ev["11.1"] as Record<string, unknown>)[P1];
				}),
			);
			if (captures) await page.locator(".audit-result").screenshot({ path: join(captures, "resultat-incomplet.png") });
			expect(await axeViolations(page)).toEqual([]);
			await page.close();
		});
	});

	describe("sauvegarde : export et import de l'audit en JSON (ADR-0016)", () => {
		const SESSION_LABEL = "Importer un audit (JSON)";
		const REPORT_LABEL = "Importer un rapport automatique (CLI ou extension, JSON)";
		const live = (page: Page) => page.locator("[aria-live=polite]").textContent();
		const stored = (page: Page) => page.evaluate(() => localStorage.getItem("rampe.audit.session"));
		const reminder = (page: Page) => page.locator(".audit-backup > p").first().textContent();
		const dialog = (page: Page) => page.getByRole("dialog", { name: "Remplacer l’audit en cours ?" });
		const pad = (n: number) => String(n).padStart(2, "0");
		const today = () => {
			const d = new Date();
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		};
		/** Session complète (taux calculé) avec une note sur deux lignes et un indice de la CLI. */
		const fullSession = () =>
			sessionJson((ev, session) => {
				(ev["1.1"] as Record<string, unknown>)[P1] = {
					status: "C",
					note: "Logo :\n\talternative vérifiée",
					source: "humain",
				};
				session.findings = {
					"1.1": {
						[P1]: [
							{
								ruleId: "image-alt",
								kind: "non-conformite",
								nodes: 2,
								impact: "critical",
								help: "Images must have alternative text",
							},
						],
					},
				};
			});
		const asFile = (json: string, name = "audit.json") => ({
			name,
			mimeType: "application/json",
			buffer: Buffer.from(json.replace(/^\{/, '{"tool":{"name":"@rampe/site"},')),
		});
		/** Audit non vide dans une page neuve : Accueil, 1.1 non conforme avec une note. */
		async function nonEmpty(page: Page) {
			await openAudit(page);
			await addPage(page, "https://exemple.fr/", "Accueil");
			await page.getByLabel("Non conforme", { exact: true }).check();
			await page.getByLabel("Note sur Accueil (facultative)").fill("Logo sans alternative");
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Logo sans alternative"));
		}

		it("aller-retour : export réel, navigateur vierge, import : audit identique", async () => {
			const first = await browser.newContext();
			const a = await first.newPage();
			await openWith(a, fullSession());
			await typeProcess(a);
			await a.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("commande  "));
			await expect(reminder(a)).resolves.toBe(
				"Cet audit n’existe que dans ce navigateur. Dernier téléchargement : jamais.",
			);
			if (captures) await a.locator(".audit-backup").screenshot({ path: join(captures, "sauvegarde-jamais.png") });

			const file = await download(a, "Télécharger l’audit (JSON)");
			expect(file.name).toBe(`audit-exemple.fr-${today()}.json`);
			expect(file.json.tool).toEqual({ name: "@rampe/site" });
			expect(file.json.schemaVersion).toBe(5);
			await expect(live(a)).resolves.toBe(`Audit téléchargé : ${file.name}`);
			await expect(reminder(a)).resolves.toMatch(
				/^Cet audit n’existe que dans ce navigateur\. Dernier téléchargement : \d+ \S+ \d{4} à \d{2}:\d{2}\.$/,
			);
			if (captures) await a.locator(".audit-backup").screenshot({ path: join(captures, "sauvegarde-telechargee.png") });
			await a.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("exportedAt"));
			const before = {
				session: JSON.parse((await stored(a)) ?? "null"),
				rates: await rates(a),
				rows: await rows(a),
				reminder: await reminder(a),
			};
			expect(before.rates).toEqual([`33,33${PCT}`, `61,11${PCT}`]);
			expect(before.session).toEqual(file.json);
			await first.close();

			// Nouveau contexte : stockage vierge, comme un autre navigateur.
			const second = await browser.newContext();
			const b = await second.newPage();
			await openAudit(b);
			expect(await stored(b)).toBeNull();
			await b
				.getByLabel(SESSION_LABEL)
				.setInputFiles({ name: file.name, mimeType: "application/json", buffer: Buffer.from(file.content) });
			// Audit vide : aucune confirmation, import direct.
			await expect.poll(() => dialog(b).count()).toBe(0);
			await expect(live(b)).resolves.toBe(
				"Audit importé : 3 pages, 318 évaluations enregistrées, 1 indice. L’audit précédent a été remplacé.",
			);
			await b.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("exportedAt"));
			expect(JSON.parse((await stored(b)) ?? "null")).toEqual(before.session);
			await expect(rates(b)).resolves.toEqual(before.rates);
			await expect(rows(b)).resolves.toEqual(before.rows);
			await expect(reminder(b)).resolves.toBe(before.reminder);
			await expect(b.getByLabel("Processus (facultatif) de Paiement").inputValue()).resolves.toBe("commande  ");
			await expect(b.getByLabel("Note sur Accueil (facultative)").inputValue()).resolves.toBe(
				"Logo :\n\talternative vérifiée",
			);
			await b.getByText("Indices de l’audit automatique pour Accueil (1)").waitFor();
			await expect.poll(() => b.locator(".audit-conflict").count()).toBe(1);
			await second.close();
		});

		for (const colorScheme of ["light", "dark"] as const) {
			const scheme = colorScheme === "light" ? "clair" : "sombre";
			it(`audit non vide : confirmation, « Télécharger d’abord », remplacement puis annulation ; axe (${scheme})`, async () => {
				const page = await browser.newPage({ colorScheme });
				await nonEmpty(page);
				const original = await stored(page);
				await page.getByLabel(SESSION_LABEL).setInputFiles(asFile(sessionJson()));
				await dialog(page).waitFor();
				// Focus dans la boîte, sur l'action la plus sûre ; le reste de la page est inerte.
				expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
					"Télécharger d’abord l’audit en cours",
				);
				expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
				await expect
					.poll(() => dialog(page).getByRole("paragraph").first().textContent())
					.toBe(
						"L’audit en cours (1 page, https://exemple.fr) sera remplacé par celui du fichier (3 pages, https://exemple.fr). Téléchargez d’abord l’audit en cours si vous voulez pouvoir y revenir.",
					);
				expect(await axeViolations(page), "boîte de dialogue ouverte").toEqual([]);
				if (captures) await page.screenshot({ path: join(captures, `confirmation-${scheme}.png`) });

				const backup = await download(page, "Télécharger d’abord l’audit en cours");
				expect(backup.json.pages.map((p: { title: string }) => p.title)).toEqual(["Accueil"]);
				expect(backup.json.evaluations["1.1"][backup.json.pages[0].id]).toEqual({
					status: "NC",
					note: "Logo sans alternative",
					source: "humain",
				});
				await expect
					.poll(() => dialog(page).getByRole("status").textContent())
					.toBe(`Audit en cours téléchargé : ${backup.name}`);
				await dialog(page).waitFor();

				await page.getByRole("button", { name: "Remplacer l’audit en cours" }).click();
				await dialog(page).waitFor({ state: "hidden" });
				// Fermeture : le focus revient au champ fichier (événement `close`, asynchrone).
				await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("audit-session");
				await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(3);
				await expect(live(page)).resolves.toMatch(/^Audit importé : 3 pages, 318 évaluations/);
				expect(await axeViolations(page), "après import").toEqual([]);
				if (captures)
					await page.locator(".audit-backup").screenshot({ path: join(captures, `import-audit-${scheme}.png`) });

				await page.getByRole("button", { name: "Annuler cet import" }).click();
				await expect(live(page)).resolves.toBe("Import annulé : l’audit est revenu à son état d’avant l’import.");
				expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-session");
				await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
				await expect(page.getByLabel("Non conforme", { exact: true }).isChecked()).resolves.toBe(true);
				await page.waitForFunction(() => {
					const saved = localStorage.getItem("rampe.audit.session");
					return saved?.includes("exportedAt") && !saved.includes("Panier");
				});
				// L'état d'avant, téléchargement compris (date du dernier téléchargement).
				expect(JSON.parse((await stored(page)) ?? "null")).toEqual({
					...JSON.parse(original ?? "null"),
					exportedAt: backup.json.exportedAt,
				});
				await page.close();
			});
		}

		it("au clavier seul : boîte de dialogue au focus piégé, Échap rend le focus, remplacer puis annuler", async () => {
			const page = await browser.newPage();
			await nonEmpty(page);
			const original = await stored(page);
			await page.focus("body");
			await tabUntil(page, "el.id === 'audit-session'");
			const choose = async () => {
				const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Space")]);
				await chooser.setFiles(asFile(sessionJson()));
				await dialog(page).waitFor();
			};
			await choose();
			// Tab et Maj+Tab ne sortent jamais de la boîte vers la page (le navigateur peut passer par sa propre interface).
			const visited: string[] = [];
			for (const key of [...Array(7).fill("Tab"), ...Array(7).fill("Shift+Tab")]) {
				await page.keyboard.press(key);
				const where = await page.evaluate(() => {
					const el = document.activeElement;
					if (!el || el === document.body) return "hors document";
					return el.closest("dialog") ? (el.textContent ?? "") : `FUITE ${el.id || el.tagName}`;
				});
				visited.push(where);
			}
			expect(visited.filter((v) => v.startsWith("FUITE"))).toEqual([]);

			expect(visited).toEqual(
				expect.arrayContaining(["Télécharger d’abord l’audit en cours", "Remplacer l’audit en cours", "Annuler"]),
			);
			await page.keyboard.press("Escape");
			await dialog(page).waitFor({ state: "hidden" });
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-session");
			await page.waitForTimeout(600);
			expect(await stored(page)).toBe(original);

			await choose();
			await page.keyboard.press("Tab"); // du bouton « Télécharger d'abord » à « Remplacer »
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Remplacer l’audit en cours");
			await page.keyboard.press("Enter");
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(3);
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-session");
			await tabUntil(page, "el.textContent === 'Annuler cet import'");
			await page.keyboard.press("Enter");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("audit-session");
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
			await page.close();
		});

		it("événement « close » en retard : il ne vole pas le focus déjà posé ailleurs (cause de l’instabilité en CI)", async () => {
			const page = await browser.newPage();
			await nonEmpty(page);
			await page.getByLabel("Importer un audit (JSON)").setInputFiles(asFile(sessionJson()));
			await dialog(page).getByRole("button", { name: "Remplacer l’audit en cours" }).click();
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(3);
			// Le navigateur envoie « close » dans une tâche à part : on le rejoue de façon déterministe après que le
			// focus est passé sur « Annuler cet import » (ce que fait Tab chez l'utilisateur rapide).
			const focused = await page.evaluate(() => {
				const undo = [...document.querySelectorAll("button")].find((b) => b.textContent === "Annuler cet import");
				undo?.focus();
				document.querySelector("dialog.audit-dialog")?.dispatchEvent(new Event("close"));
				return document.activeElement?.textContent;
			});
			expect(focused).toBe("Annuler cet import");
			await page.close();
		});

		it("fichier hostile ou abîmé : refusé avant toute confirmation, message clair, session intacte", async () => {
			const page = await browser.newPage();
			await nonEmpty(page);
			const before = await stored(page);
			const input = page.getByLabel(SESSION_LABEL);
			const invalid = "Ce fichier n’est pas un audit Rampe, ou il a été modifié. Rien n’a été importé.";
			const good = sessionJson();
			const cases: [string, string | Buffer, string | RegExp, RegExp | null][] = [
				[
					"proto.json",
					good.replace(`"title":"Accueil"`, `"title":"Accueil","__proto__":{"polluted":true}`),
					invalid,
					/^fichier\.pages\.0 : clé interdite « __proto__ »/,
				],
				[
					"critere.json",
					good.replace(`"1.1":`, `"99.1":`),
					invalid,
					/^evaluations : critère "99\.1" inexistant dans le référentiel/,
				],
				[
					"id.json",
					good.replaceAll(P1, "toString"),
					invalid,
					/^pages\[0\]\.id : identifiant de page qui n’est pas un UUID/,
				],
				[
					"url.json",
					good.replace("https://exemple.fr/panier", "javascript:alert(1)"),
					invalid,
					/^pages\[1\]\.url : Seules les adresses http/,
				],
				["statut.json", good.replace(`"status":"NC"`, `"status":"OK"`), invalid, /statut inconnu "OK"/],
				[
					"futur.json",
					good.replace(`"schemaVersion":2`, `"schemaVersion":6`),
					/^Cet audit a été créé par une version plus récente de Rampe/,
					null,
				],
				["casse.json", "{ pas du JSON", /^Ce fichier n’est pas un fichier JSON lisible/, null],
				// Au-delà de 50 Mo, Playwright exige un fichier sur disque.
				["enorme.json", "", /^Fichier trop volumineux \(65 Mo\) : 64 Mo au plus/, null],
			];
			const big = join(await mkdtemp(join(tmpdir(), "rampe-gros-")), "enorme.json");
			await writeFile(big, Buffer.alloc(65 * 1024 * 1024, " "));
			const error = page.locator("#audit-session-erreur");
			for (const [name, content, message, detail] of cases) {
				if (name === "enorme.json") await input.setInputFiles(big);
				else {
					const buffer = typeof content === "string" ? asFile(content).buffer : content;
					await input.setInputFiles({ name, mimeType: "application/json", buffer });
				}
				// Le message peut être le même d'un cas à l'autre : on attend le détail propre à ce cas.
				if (detail)
					await expect.poll(() => error.locator("details > p").textContent(), { message: name }).toMatch(detail);
				await expect.poll(() => error.locator("> p").textContent(), { message: name }).toMatch(message);
				await expect.poll(() => dialog(page).count()).toBe(0);
				await expect.poll(() => error.locator("details").count()).toBe(detail ? 1 : 0);
				if (detail) {
					await expect(error.locator("details").evaluate((d) => (d as HTMLDetailsElement).open)).resolves.toBe(false);
					await expect(error.locator("details > p").textContent()).resolves.toMatch(detail);
					if (captures && name === "critere.json") {
						await error.locator("summary").click();
						await page.locator(".audit-session-import").screenshot({ path: join(captures, "import-audit-refus.png") });
						await error.locator("summary").click();
					}
				}
				await expect(input.getAttribute("aria-describedby")).resolves.toContain("audit-session-erreur");
				await expect(input.getAttribute("aria-invalid")).resolves.toBe("true");
				await expect(live(page)).resolves.toMatch(message);
			}
			expect(await page.evaluate(() => "polluted" in {})).toBe(false);
			await page.waitForTimeout(600);
			expect(await stored(page)).toBe(before);
			await rm(dirname(big), { recursive: true, force: true });
			await page.close();
		});

		it("mauvais champ : rapport de la CLI comme audit, audit comme rapport : message qui oriente", async () => {
			const page = await browser.newPage();
			await nonEmpty(page);
			const before = await stored(page);
			await page.getByLabel(SESSION_LABEL).setInputFiles(reportPath);
			await expect
				.poll(() => page.locator("#audit-session-erreur > p").textContent())
				.toBe(
					"Ce fichier est un rapport automatique de Rampe (CLI ou extension), pas un audit complet : importez-le avec le champ « Importer un rapport automatique (CLI ou extension, JSON) », section « 1. Pages de l’échantillon ». Rien n’a été importé.",
				);
			await page.getByLabel(REPORT_LABEL).setInputFiles(asFile(sessionJson()));
			await expect
				.poll(() => page.locator("#audit-rapport-erreur > p").textContent())
				.toBe(
					"Ce fichier est un audit Rampe complet (téléchargé depuis l’audit guidé), pas un rapport automatique : importez-le avec le champ « Importer un audit (JSON) », section « Sauvegarde de l’audit ». Rien n’a été importé.",
				);
			await expect.poll(() => dialog(page).count()).toBe(0);
			if (captures) await page.screenshot({ path: join(captures, "mauvais-champ.png"), fullPage: true });
			await page.waitForTimeout(600);
			expect(await stored(page)).toBe(before);
			await page.close();
		});
	});

	// Déclaration d'accessibilité (ADR-0017). Audits injectés comme pour le taux (sessionJson), saisies au clavier ou
	// par remplissage ; chaque export est intercepté et relu (fichier HTML ouvert dans Chromium, Markdown analysé).
	describe("déclaration d’accessibilité (ADR-0017)", () => {
		const preview = (page: Page) => page.locator(".audit-preview");
		const previewText = (page: Page) => preview(page).evaluate((el) => (el as HTMLElement).innerText);
		const state = (page: Page) => page.locator(".audit-state").evaluate((el) => (el as HTMLElement).innerText);
		const NBSP = " ";
		/** 8.3 conforme sur l'accueil : seul 1.1 (NC sur Paiement) n'est pas validé. */
		const twoThirds = (patch: (ev: Record<string, Record<string, unknown>>) => void = () => {}) =>
			sessionJson((ev) => {
				(ev["8.3"] as Record<string, unknown>)[P1] = { status: "C", note: "", source: "humain" };
				patch(ev);
			});
		const HOSTILE = {
			"Nom de l’organisme": '<script>alert("org")</script><img src=x onerror=alert(1)>',
			"Nom du site": "[clic](javascript:alert(2)) \u202egnp.live",
			"Adresse du schéma pluriannuel de mise en accessibilité": "javascript:alert(3)",
			"Formulaire de contact ou adresse e-mail": 'https://exemple.fr/"><svg onload=alert(4)>',
			"Service à contacter": `<iframe src=javascript:alert(5)></iframe>${LINKS}`,
		};

		it("audit complet : « partiellement », chiffres exactement égaux au calcul à la main", async () => {
			const page = await browser.newPage();
			await openWith(page, twoThirds());
			// Validés : 3.2 et 8.3 ; applicables : 1.1, 3.2, 8.3 → 2/3 = 66,666… → 66,66 % ; 2 × 2 ≥ 3 : partiellement.
			// Taux moyen : Accueil 3/3, Panier 2/2 (8.3 NA), Paiement 2/3 → (100 + 100 + 66,666…) ÷ 3 = 88,888… → 88,88 %.
			await expect
				.poll(() => state(page))
				.toMatch(new RegExp(`^Partiellement conforme : 66,66${PCT} des critères RGAA respectés`));
			const text = await previewText(page);
			expect(text).toContain(
				`est\npartiellement conforme avec le référentiel général d’amélioration de l’accessibilité (RGAA), version 4.1.2.`,
			);
			expect(text).toContain(`66,66${PCT} des critères RGAA sont respectés.`);
			expect(text).toContain(`Le taux moyen de conformité du service en ligne s’élève à 88,88${PCT}.`);
			expect(text).toContain(
				`Critère 1.1${NBSP}: Chaque image porteuse d’information a-t-elle une alternative textuelle${NBSP}? Page concernée${NBSP}: Paiement.`,
			);
			expect(text).not.toMatch(/Critère (3\.2|8\.3)/);
			for (const p of ["Accueil", "Panier", "Paiement"]) expect(text).toContain(`${p}${NBSP}: https://exemple.fr/`);
			// Ce que l'utilisateur doit compléter reste visible, entre crochets, et marqué.
			expect(text).toContain("[Nom de l’organisme concerné] s’engage à rendre");
			await expect(preview(page).locator("mark").first().textContent()).resolves.toBe("[Nom de l’organisme concerné]");
			// L'exemple de conformity.ts : 1 validé sur 3 → 33,33 %, moins de 50 % : « non », motif en clair.
			const other = await browser.newPage();
			await openWith(other, sessionJson());
			await expect
				.poll(() => state(other))
				.toBe(
					`Non conforme : Moins de 50 % des critères RGAA sont respectés. Pourcentage de critères respectés : 33,33${PCT}.`,
				);
			await expect(previewText(other)).resolves.toContain("est\nnon conforme avec");
			await page.close();
			await other.close();
		});

		it("audit incomplet : « non conforme », motif, et lien vers ce qui reste à faire", async () => {
			const page = await browser.newPage();
			await openWith(
				page,
				twoThirds((ev) => delete ev["11.1"]?.[P1]),
			);
			await expect
				.poll(() => state(page))
				.toMatch(
					/^Non conforme : aucun résultat d’audit complet\. .+terminez l’audit : 1 évaluation « non testé » et 0 statut à confirmer\./s,
				);
			const text = await previewText(page);
			expect(text).toContain("est\nnon conforme avec");
			expect(text).toContain(
				"Aucun résultat d’audit complet permettant de mesurer le respect des critères : l’audit n’est pas terminé.",
			);
			expect(text).toContain("[pourcentage de critères RGAA respectés] des critères RGAA sont respectés.");
			expect(text).not.toContain("%");
			expect(text).not.toMatch(/totalement|partiellement conforme/);
			// Lien vers le résultat, où se trouvent les raccourcis vers les critères restants.
			await page.getByRole("link", { name: "Terminer l’audit (section 3)" }).click();
			await expect.poll(() => page.evaluate(() => location.hash)).toBe("#audit-resultat");
			await page.locator(".audit-result").getByRole("button", { name: "Afficher les critères non testés" }).click();
			await page.waitForFunction(() => document.activeElement?.id === "audit-titre");
			expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/^Critère 11\.1, /);
			// Sans aucune page : renvoi vers l'échantillon.
			const empty = await browser.newPage();
			await openAudit(empty);
			await expect.poll(() => state(empty)).toMatch(/ajoutez des pages à l’échantillon \(section 1\)/);
			await expect(empty.locator(".audit-state a").getAttribute("href")).resolves.toBe("#audit-echantillon");
			await page.close();
			await empty.close();
		});

		it("saisies hostiles : HTML téléchargé sans balise active (fichier ouvert dans Chromium), Markdown inerte", async () => {
			const page = await browser.newPage();
			await openWith(page, twoThirds());
			for (const [label, value] of Object.entries(HOSTILE)) await page.getByLabel(label, { exact: true }).fill(value);
			// Adresse refusée : signalée à la sortie du champ, reliée au champ.
			await page.getByLabel("Adresse du schéma pluriannuel de mise en accessibilité").blur();
			await expect
				.poll(() =>
					page.getByLabel("Adresse du schéma pluriannuel de mise en accessibilité").getAttribute("aria-invalid"),
				)
				.toBe("true");
			await expect(page.locator("#declaration-schemeUrl-erreur").textContent()).resolves.toMatch(
				/^Adresse non reconnue/,
			);
			await expect.poll(() => previewText(page)).toContain('<script>alert("org")</script>');

			const html = await download(page, "Télécharger (HTML)");
			expect(html.name).toMatch(/^declaration-accessibilite-exemple\.fr-\d{4}-\d{2}-\d{2}\.html$/);
			const viewer = await browser.newPage();
			const dialogs: string[] = [];
			viewer.on("dialog", (d) => {
				dialogs.push(d.message());
				void d.dismiss();
			});
			await viewer.setContent(html.content, { waitUntil: "load" });
			await viewer.waitForTimeout(300);
			expect(dialogs).toEqual([]);
			const parsed = await viewer.evaluate(() => ({
				title: document.title,
				lang: document.documentElement.lang,
				active: document.querySelectorAll("script, img, iframe, svg, object, embed, style, link, form").length,
				handlers: [...document.querySelectorAll("*")].flatMap((el) =>
					[...el.attributes].filter((a) => a.name.startsWith("on")).map((a) => a.name),
				),
				hrefs: [...document.querySelectorAll("a")].map((a) => a.protocol),
				tags: [...new Set([...document.body.querySelectorAll("*")].map((el) => el.localName))].sort(),
				text: document.body.innerText,
			}));
			expect(parsed).toMatchObject({ title: "Déclaration d’accessibilité", lang: "fr", active: 0, handlers: [] });
			for (const protocol of parsed.hrefs) expect(["https:", "mailto:"]).toContain(protocol);
			expect(parsed.tags).toEqual(["a", "br", "h1", "h2", "h3", "li", "main", "p", "ul"]);
			// Les saisies restent lisibles, comme du texte.
			expect(parsed.text).toContain('<script>alert("org")</script><img src=x onerror=alert(1)>');
			expect(parsed.text).toContain("[liens vers le schéma pluriannuel et vers le plan d’action");
			expect(parsed.text).not.toMatch(/[‪-‮⁦-⁩]/);
			await viewer.close();

			const md = await download(page, "Télécharger (Markdown)");
			expect(md.name).toMatch(/\.md$/);
			const tree = markdownToHast(md.content, { features: { rawHtml: true }, position: false }) as {
				children?: unknown[];
			};
			const elements: string[] = [];
			const raw: string[] = [];
			const links: string[] = [];
			const walk = (node: {
				type?: string;
				tagName?: string;
				value?: string;
				properties?: { href?: string };
				children?: unknown[];
			}) => {
				if (node.type === "element") {
					elements.push(node.tagName ?? "");
					if (node.tagName === "a") links.push(String(node.properties?.href));
				}
				if (node.type === "raw") raw.push(node.value ?? "");
				for (const child of node.children ?? []) walk(child as typeof node);
			};
			walk(tree);
			expect(
				raw.every((r) => r === "<br>"),
				raw.join(" "),
			).toBe(true);
			expect([...new Set(elements)].filter((e) => e !== "br").sort()).toEqual(["a", "h1", "h2", "h3", "li", "p", "ul"]);
			for (const href of links) expect(href).toMatch(/^(https?:\/\/|mailto:)/);
			await page.close();
		});

		it("saisies gardées : rechargement, puis export et import de l'audit dans un navigateur vierge", async () => {
			const first = await browser.newContext();
			const a = await first.newPage();
			await openWith(a, twoThirds());
			await a.getByLabel("Nom de l’organisme", { exact: true }).fill("Boulangerie Dupont");
			await a.getByLabel("Par un prestataire").check();
			await a.getByLabel("Nom du prestataire").fill("Accès Conseil");
			await a.getByLabel("Dérogations pour charge disproportionnée, une par ligne").fill("Archives PDF\nVidéos 2015");
			await a.getByLabel("Formulaire de contact ou adresse e-mail").fill("accessibilite@exemple.fr");
			await a.getByLabel("Date de mise à jour (facultatif)").fill("2026-10-14");
			await a.getByLabel("Date de mise à jour (facultatif)").blur(); // une date s'enregistre à la sortie du champ
			await a.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("2026-10-14"));
			const expected = {
				organization: "Boulangerie Dupont",
				auditBy: "prestataire",
				auditCompany: "Accès Conseil",
				derogations: "Archives PDF\nVidéos 2015",
				contactFormUrl: "accessibilite@exemple.fr",
				updatedOn: "2026-10-14",
			};
			const check = async (page: Page) => {
				await expect
					.poll(() => page.getByLabel("Nom de l’organisme", { exact: true }).inputValue())
					.toBe(expected.organization);
				await expect(page.getByLabel("Par un prestataire").isChecked()).resolves.toBe(true);
				await expect(page.getByLabel("Nom du prestataire").inputValue()).resolves.toBe(expected.auditCompany);
				const text = await previewText(page);
				expect(text).toContain("Boulangerie Dupont s’engage à rendre");
				expect(text).toContain(`L’audit de conformité réalisé par la société Accès Conseil révèle que${NBSP}:`);
				expect(text).toContain("Archives PDF\nVidéos 2015.");
				expect(text).toContain("Elle a été mise à jour le 14 octobre 2026.");
				await expect(
					preview(page).getByRole("link", { name: "accessibilite@exemple.fr" }).getAttribute("href"),
				).resolves.toBe("mailto:accessibilite@exemple.fr");
			};
			await check(a);
			expect(
				JSON.parse((await a.evaluate(() => localStorage.getItem("rampe.audit.session"))) ?? "{}").declaration,
			).toEqual(expected);
			await a.reload();
			await a.waitForSelector("astro-island:not([ssr])");
			await check(a);

			const file = await download(a, "Télécharger l’audit (JSON)");
			expect(file.json.declaration).toEqual(expected);
			await first.close();
			const second = await browser.newContext();
			const b = await second.newPage();
			await openAudit(b);
			await b
				.getByLabel("Importer un audit (JSON)")
				.setInputFiles({ name: file.name, mimeType: "application/json", buffer: Buffer.from(file.content) });
			await check(b);
			await second.close();
		});

		for (const colorScheme of ["light", "dark"] as const) {
			const scheme = colorScheme === "light" ? "clair" : "sombre";
			it(`axe : aucune violation sur la déclaration (${scheme}), adresse refusée affichée`, async () => {
				const page = await browser.newPage({ colorScheme });
				await openWith(page, twoThirds());
				await page.getByLabel("Nom de l’organisme", { exact: true }).fill("Boulangerie Dupont");
				await page.getByLabel("Page web de ses coordonnées").fill("exemple.fr/contact");
				await page.getByLabel("Service à contacter").focus();
				await page.locator("#declaration-contactPageUrl-erreur").waitFor();
				await expect.poll(() => previewText(page)).toContain("Boulangerie Dupont");
				if (captures) {
					await page.locator(".audit-declaration").screenshot({ path: join(captures, `declaration-${scheme}.png`) });
					await preview(page).screenshot({ path: join(captures, `declaration-apercu-${scheme}.png`) });
				}
				expect(await axeViolations(page)).toEqual([]);
				await page.close();
			});
		}

		it("axe et capture : audit incomplet (clair), et mobile 375 px sans défilement horizontal", async () => {
			const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
			await openWith(
				page,
				sessionJson((ev) => delete (ev["11.1"] as Record<string, unknown>)[P1]),
			);
			await expect.poll(() => state(page)).toMatch(/^Non conforme : aucun résultat d’audit complet/);
			if (captures)
				await page.locator(".audit-declaration").screenshot({ path: join(captures, "declaration-incomplet-375.png") });
			expect(await axeViolations(page)).toEqual([]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
			await page.close();
		});

		it("dates : saisie hors limites (10, 14, 27576) jamais enregistrée ni publiée, message relié, aucune exception", async () => {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await openWith(page, twoThirds());
			const field = page.getByLabel("Date de mise à jour (facultatif)");
			await expect(field.getAttribute("min")).resolves.toBe("1900-01-01");
			await expect(field.getAttribute("max")).resolves.toBe("9999-12-31");
			const stored = async () =>
				JSON.parse((await page.evaluate(() => localStorage.getItem("rampe.audit.session"))) ?? "{}").declaration
					?.updatedOn;
			// Saisie du relecteur. Chromium garde 4 chiffres d'année : « 27576 » donne 7576 ; en route, le champ est passé
			// par 0002, 0027, 0275 : aucun de ces états n'est enregistré ni publié avant la sortie du champ.
			await field.focus();
			for (const part of ["10", "14", "27576"]) await page.keyboard.type(part);
			await expect.poll(() => field.inputValue()).toBe("7576-10-14");
			await page.waitForTimeout(600);
			expect(await stored()).toBeUndefined();
			await expect(previewText(page)).resolves.toContain("Elle a été mise à jour le [JJ mois AAAA].");
			await field.blur();
			await expect.poll(stored).toBe("7576-10-14");
			// Année hors limites (0010) : message relié au champ, valeur non enregistrée, la précédente reste.
			await field.focus();
			for (const part of ["10", "14", "0010"]) await page.keyboard.type(part);
			await expect.poll(() => field.inputValue()).toBe("0010-10-14");
			await field.blur();
			await expect.poll(() => field.getAttribute("aria-invalid")).toBe("true");
			await expect(page.locator("#declaration-updatedOn-erreur").textContent()).resolves.toBe(
				"Date incomplète ou hors limites (années 1900 à 9999) : elle n’est pas enregistrée.",
			);
			await expect(field.getAttribute("aria-describedby")).resolves.toBe("declaration-updatedOn-erreur");
			await page.waitForTimeout(600);
			expect(await stored()).toBe("7576-10-14");
			await expect(previewText(page)).resolves.not.toContain("0010");
			// Corrigée, elle est enregistrée à la sortie du champ.
			await field.focus();
			await page.keyboard.type("10142026");
			await field.blur();
			await expect.poll(() => previewText(page)).toContain("Elle a été mise à jour le 14 octobre 2026.");
			await expect.poll(() => field.getAttribute("aria-invalid")).toBe(null);
			await expect.poll(stored).toBe("2026-10-14");
			expect(errors).toEqual([]);
			await page.close();
		});

		it("date d'établissement figée au premier téléchargement, gardée ensuite, modifiable", async () => {
			const page = await browser.newPage();
			await openWith(page, twoThirds());
			const field = page.getByLabel("Date d’établissement (facultatif)");
			await expect(field.inputValue()).resolves.toBe("");
			await download(page, "Télécharger (Markdown)");
			const d = new Date();
			const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			await expect.poll(() => field.inputValue()).toBe(today);
			await page.waitForFunction(
				(t) => localStorage.getItem("rampe.audit.session")?.includes(`"establishedOn":"${t}"`),
				today,
			);
			// Saisie par l'utilisateur : c'est elle qui fait foi, et un nouvel export ne la change pas.
			await field.focus();
			await page.keyboard.type("01022025");
			await field.blur();
			const md = await download(page, "Télécharger (Markdown)");
			expect(md.content).toContain("Cette déclaration a été établie le 02 janvier 2025.");
			await page.close();
		});

		it("export : une date en brouillon est enregistrée avant le document ; invalide, l'export est bloqué", async () => {
			const page = await browser.newPage();
			await openWith(page, twoThirds());
			const field = page.getByLabel("Date de mise à jour (facultatif)");
			// Nouvelle date valide, puis clic immédiat : le clic provoque la sortie du champ, le fichier a la NOUVELLE date.
			await field.focus();
			await page.keyboard.type("10142026");
			const html = await download(page, "Télécharger (HTML)");
			expect(html.content).toContain("Elle a été mise à jour le 14 octobre 2026.");
			await field.focus();
			await page.keyboard.type("11052026");
			const md = await download(page, "Télécharger (Markdown)");
			expect(md.content).toContain("Elle a été mise à jour le 05 novembre 2026.");
			// Activation sans sortie du champ (technologie d'assistance, clic programmatique) : le focus reste dans la
			// date, aucun « blur » ; l'export doit quand même prendre la nouvelle date.
			await field.focus();
			await page.keyboard.type("12242026");
			const [noBlur] = await Promise.all([
				page.waitForEvent("download"),
				page.getByRole("button", { name: "Télécharger (HTML)" }).evaluate((b) => (b as HTMLButtonElement).click()),
			]);
			expect(await readFile(await noBlur.path(), "utf8")).toContain("Elle a été mise à jour le 24 décembre 2026.");
			// Date invalide puis clic : aucun téléchargement, message relié, focus sur le champ ; la date publiée reste.
			const downloads: string[] = [];
			page.on("download", (d) => downloads.push(d.suggestedFilename()));
			await field.focus();
			await page.keyboard.type("10140010");
			await page.getByRole("button", { name: "Télécharger (HTML)" }).click();
			await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("declaration-updatedOn");
			await expect.poll(() => field.getAttribute("aria-invalid")).toBe("true");
			await expect(page.locator("#declaration-updatedOn-erreur").textContent()).resolves.toMatch(
				/^Date incomplète ou hors limites/,
			);
			await expect
				.poll(() => page.locator("[aria-live=polite]").textContent())
				.toBe("Export impossible : une date est incomplète ou hors limites (années 1900 à 9999).");
			await page.getByRole("button", { name: "Télécharger (Markdown)" }).click();
			await page.waitForTimeout(800);
			expect(downloads).toEqual([]);
			await expect(previewText(page)).resolves.toContain("Elle a été mise à jour le 24 décembre 2026.");
			await page.close();
		});

		it("relecture : une date de déclaration abîmée est retirée, signalée sobrement ; l'audit n'est pas mis de côté", async () => {
			const page = await browser.newPage();
			const json = JSON.parse(twoThirds());
			json.schemaVersion = 3;
			json.declaration = { organization: "Mairie", establishedOn: "0010-10-14" };
			await openWith(page, JSON.stringify(json));
			await expect
				.poll(() => page.locator(".audit > p.audit-help").first().textContent())
				.toBe(
					"Déclaration d’accessibilité : 1 date illisible, retirée à la relecture (section 4). Le reste de l’audit est intact.",
				);
			await expect(page.getByLabel("Nom de l’organisme", { exact: true }).inputValue()).resolves.toBe("Mairie");
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(3);
			const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("ignoree")));
			expect(keys).toEqual([]);
			await page.close();
		});

		it("375 px : une adresse de page très longue ne fait pas défiler la page (libellé de note, annonce)", async () => {
			const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
			await openAudit(page);
			await page.getByLabel("Adresse de la page").fill(`https://exemple.fr/${"sanscoupure".repeat(30)}`);
			await page.getByRole("button", { name: "Ajouter la page" }).click();
			await expect.poll(() => page.locator(".audit-page-list li").count()).toBe(1);
			await page.locator(".audit-page > label").first().waitFor();
			await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
			if (captures)
				await page
					.locator(".audit-page")
					.first()
					.screenshot({ path: join(captures, "note-url-longue-375.png") });
			await page.close();
		});

		it("au clavier seul : remplir un champ puis télécharger la déclaration", async () => {
			const page = await browser.newPage();
			await openWith(page, twoThirds());
			await page.focus("body");
			await tabUntil(page, "el.id === 'declaration-organization'", { max: 400 });
			await page.keyboard.type("Mairie de Clavierville");
			await expect.poll(() => previewText(page)).toContain("Mairie de Clavierville s’engage à rendre");
			await tabUntil(page, "el.textContent === 'Télécharger (HTML)'", { max: 60 });
			const file = await download(page, "", "Enter");
			expect(file.content).toContain("<p>Mairie de Clavierville s’engage à rendre");
			await tabUntil(page, "el.textContent === 'Télécharger (Markdown)'", { max: 3 });
			const md = await download(page, "", "Space");
			expect(md.content).toContain("Mairie de Clavierville s’engage à rendre");
			await page.close();
		});
	});

	describe("schéma pluriannuel et plan d’action (ADR-0018)", () => {
		const NBSP = "\u00a0";
		const schemaPreview = (page: Page) =>
			page.locator("#schema-apercu + *").evaluate((el) => (el as HTMLElement).parentElement?.innerText ?? "");
		const planPreview = (page: Page) =>
			page.locator("#plan-apercu + *").evaluate((el) => (el as HTMLElement).parentElement?.innerText ?? "");
		const rowHeads = (page: Page) => page.locator(".audit-schema-table tbody th").allTextContents();
		const live = (page: Page) => page.locator("[aria-live=polite]").textContent();
		const stored = async (page: Page) =>
			JSON.parse((await page.evaluate(() => localStorage.getItem("rampe.audit.session"))) ?? "{}");
		const control = (page: Page, kind: string, criterion: string) =>
			page.getByLabel(new RegExp(`^${kind} de l’action \\d+ : Critère ${criterion.replace(".", "\\.")} : `));
		/** Période 2026-2028 saisie comme un utilisateur : l'année s'enregistre à la sortie du champ. */
		async function setPeriod(page: Page) {
			await page.getByLabel("Année de début").fill("2026");
			await page.getByLabel("Année de début").blur();
			await page.getByLabel("Durée").selectOption("3");
			await page.waitForFunction(() =>
				/"startYear":2026,"duration":3/.test(localStorage.getItem("rampe.audit.session") ?? ""),
			);
		}
		const syncButton = (page: Page) => page.getByRole("button", { name: "Mettre à jour depuis l’audit" });

		it("2 critères non validés : 2 actions ; réglages ; resynchronisation idempotente ; critère corrigé marqué ; plan filtré", async () => {
			const page = await browser.newPage();
			// sessionJson : 1.1 non conforme sur Paiement, 8.3 sur Accueil ; 3.2 validé.
			await openWith(page, sessionJson());
			await setPeriod(page);
			await syncButton(page).click();
			await expect.poll(() => live(page)).toBe("2 actions ajoutées, 0 action mise à jour.");
			const heads = await rowHeads(page);
			expect(heads).toHaveLength(2);
			expect(heads[0]).toMatch(/^Critère 1\.1 : Chaque image porteuse d’information .*\(Paiement\)$/);
			expect(heads[1]).toMatch(/^Critère 8\.3 : .*\(Accueil\)$/);

			await control(page, "Priorité", "1.1").selectOption("haute");
			await control(page, "Année cible", "1.1").selectOption("2026");
			await control(page, "Bilan", "1.1").selectOption("faite");
			await control(page, "Priorité", "8.3").selectOption("moyenne");
			await control(page, "Année cible", "8.3").selectOption("2027");
			await control(page, "Commentaire", "8.3").fill("Avec la refonte");
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Avec la refonte"));
			const before = (await stored(page)).schema;

			// Relancer : rien n'est dupliqué ni modifié.
			await syncButton(page).click();
			await expect.poll(() => live(page)).toBe("Tableau déjà à jour : aucune action ajoutée ni modifiée.");
			await page.waitForTimeout(600);
			expect((await stored(page)).schema).toEqual(before);
			expect(await rowHeads(page)).toHaveLength(2);
			await expect(control(page, "Priorité", "1.1").inputValue()).resolves.toBe("haute");

			// 8.3 corrigé sur l'accueil (seule page où il échouait) : l'action reste, marquée.
			const json = await stored(page);
			json.evaluations["8.3"][P1] = { status: "C", note: "", source: "humain" };
			await page.evaluate((v) => localStorage.setItem("rampe.audit.session", v), JSON.stringify(json));
			await page.reload();
			await page.waitForSelector("astro-island:not([ssr])");
			await expect
				.poll(() => rowHeads(page))
				.toEqual([expect.any(String), expect.stringMatching(/Critère désormais validé\.$/)]);
			await syncButton(page).click();
			await expect.poll(() => live(page)).toBe("Tableau déjà à jour : aucune action ajoutée ni modifiée.");
			expect(await rowHeads(page)).toHaveLength(2);
			await expect(control(page, "Priorité", "8.3").inputValue()).resolves.toBe("moyenne");
			await expect.poll(() => schemaPreview(page)).toContain("(critère désormais validé)");

			// Plan de 2027 : seulement les actions de 2027 ; bilan de 2026.
			await page.getByLabel("Année du plan d’action").selectOption("2027");
			const plan = await planPreview(page);
			expect(plan).toContain("Aperçu du plan d’action 2027");
			const planned = plan.slice(plan.indexOf("Actions prévues en 2027"), plan.indexOf("Bilan de l’année précédente"));
			expect(planned).toContain("Critère 8.3");
			expect(planned).not.toContain("Critère 1.1");
			expect(plan.slice(plan.indexOf("Bilan de l’année précédente (2026)"))).toContain(
				`Critère 1.1${NBSP}: Chaque image porteuse d’information a-t-elle une alternative textuelle${NBSP}? Page concernée${NBSP}: Paiement. Priorité${NBSP}: haute. Bilan${NBSP}: faite.`,
			);
			const md = await download(page, "Télécharger le plan d’action 2027 (Markdown)");
			expect(md.name).toMatch(/^plan-action-2027-exemple\.fr-\d{4}-\d{2}-\d{2}\.md$/);
			expect(md.content.startsWith("# Plan d’action 2027\n")).toBe(true);
			if (captures) await page.locator(".audit-schema").screenshot({ path: join(captures, "schema-actions.png") });
			await page.close();
		});

		it("audit incomplet : aucune action inventée, renvoi vers l’audit", async () => {
			const page = await browser.newPage();
			await openWith(
				page,
				sessionJson((ev) => delete (ev["11.1"] as Record<string, unknown>)[P1]),
			);
			await syncButton(page).click();
			await expect
				.poll(() => live(page))
				.toBe("Audit incomplet : aucune action n’est proposée tant que l’audit n’est pas terminé.");
			await expect(page.locator(".audit-schema-table").count()).resolves.toBe(0);
			await expect(
				page.locator(".audit-schema").getByRole("link", { name: "Terminer l’audit (section 3)" }).getAttribute("href"),
			).resolves.toBe("#audit-resultat");
			await expect(schemaPreview(page)).resolves.toContain(
				"L’audit n’est pas complet : aucune action n’a encore été proposée à partir de ses résultats.",
			);
			await page.close();
		});

		it("saisies hostiles : schéma et plan téléchargés sans balise active (HTML ouvert dans Chromium), Markdown inerte", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			await setPeriod(page);
			// Adresses que satteri peut transformer en liens : seuls http(s) et mailto sont admis (README du core).
			const HOSTILE = `<script>alert("s")</script><img src=x onerror=alert(1)>[clic](javascript:alert(2)) ‮gnp${LINKS}`;
			await page.getByLabel("Stratégie", { exact: true }).fill(`${HOSTILE}\n# titre\n<iframe src=javascript:alert(3)>`);
			await page.getByLabel("Intitulé d’une action libre").fill(HOSTILE);
			await page.getByRole("button", { name: "Ajouter l’action" }).click();
			await expect.poll(() => rowHeads(page)).toHaveLength(1);
			await page.getByLabel(/^Commentaire de l’action 1 : /).fill("<svg onload=alert(4)>");
			await page.getByLabel(/^Année cible de l’action 1 : /).selectOption("2026");
			await expect.poll(() => schemaPreview(page)).toContain('<script>alert("s")</script>');

			for (const [button, title] of [
				["Télécharger le schéma (HTML)", "Schéma pluriannuel de mise en accessibilité numérique"],
				["Télécharger le plan d’action 2026 (HTML)", "Plan d’action 2026"],
			] as const) {
				const file = await download(page, button);
				const viewer = await browser.newPage();
				const dialogs: string[] = [];
				viewer.on("dialog", (d) => {
					dialogs.push(d.message());
					void d.dismiss();
				});
				await viewer.setContent(file.content, { waitUntil: "load" });
				await viewer.waitForTimeout(300);
				expect(dialogs).toEqual([]);
				const parsed = await viewer.evaluate(() => ({
					title: document.title,
					lang: document.documentElement.lang,
					active: document.querySelectorAll("script, img, iframe, svg, object, embed, style, link, form, a").length,
					handlers: [...document.querySelectorAll("*")].flatMap((el) =>
						[...el.attributes].filter((a) => a.name.startsWith("on")).map((a) => a.name),
					),
					tags: [...new Set([...document.body.querySelectorAll("*")].map((el) => el.localName))].sort(),
					text: document.body.innerText,
				}));
				expect(parsed).toMatchObject({ title, lang: "fr", active: 0, handlers: [] });
				for (const tag of parsed.tags) expect(["h1", "h2", "h3", "li", "main", "p", "ul"]).toContain(tag);
				expect(parsed.text).toContain('<script>alert("s")</script><img src=x onerror=alert(1)>');
				expect(parsed.text).not.toMatch(/[‪-‮⁦-⁩]/);
				await viewer.close();
			}

			for (const button of ["Télécharger le schéma (Markdown)", "Télécharger le plan d’action 2026 (Markdown)"]) {
				const md = await download(page, button);
				const tree = markdownToHast(md.content, { features: { rawHtml: true }, position: false }) as {
					children?: unknown[];
				};
				const elements: string[] = [];
				const raw: string[] = [];
				const links: string[] = [];
				const walk = (node: {
					type?: string;
					tagName?: string;
					value?: string;
					properties?: { href?: string };
					children?: unknown[];
				}) => {
					if (node.type === "element") elements.push(node.tagName ?? "");
					if (node.tagName === "a") links.push(String(node.properties?.href));
					if (node.type === "raw") raw.push(node.value ?? "");
					for (const child of node.children ?? []) walk(child as typeof node);
				};
				walk(tree);
				expect(raw).toEqual([]);
				for (const tag of new Set(elements)) expect(["a", "h1", "h2", "h3", "li", "p", "ul"]).toContain(tag);
				// Non vide : satteri fait bien des liens des adresses nues, www., e-mail et <http://…> (admis).
				expect(links.length).toBeGreaterThan(0);
				for (const href of links) expect(href).toMatch(/^(https?:\/\/|mailto:)/);
			}
			await page.close();
		});

		it("saisies gardées : rechargement, puis export et import de l’audit dans un navigateur vierge", async () => {
			const first = await browser.newContext();
			const a = await first.newPage();
			await openWith(a, sessionJson());
			await setPeriod(a);
			await syncButton(a).click();
			await expect.poll(() => rowHeads(a)).toHaveLength(2);
			await a.getByLabel("Référent accessibilité numérique").fill("Marie Durand, rattachée à la direction");
			await control(a, "Priorité", "8.3").selectOption("basse");
			await a.getByRole("button", { name: /^Retirer l’action \d+ : Critère 1\.1 / }).click();
			await a.getByLabel("Intitulé d’une action libre").fill("Former l’équipe");
			await a.getByRole("button", { name: "Ajouter l’action" }).click();
			await a.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("Former l’équipe"));
			const check = async (page: Page) => {
				await expect.poll(() => rowHeads(page)).toHaveLength(3);
				await expect(page.getByLabel("Année de début").inputValue()).resolves.toBe("2026");
				await expect(page.getByLabel("Durée").inputValue()).resolves.toBe("3");
				await expect(page.getByLabel("Référent accessibilité numérique").inputValue()).resolves.toBe(
					"Marie Durand, rattachée à la direction",
				);
				await expect(control(page, "Priorité", "8.3").inputValue()).resolves.toBe("basse");
				const heads = await rowHeads(page);
				expect(heads[0]).toMatch(/Retirée\.$/);
				expect(heads[2]).toBe("Former l’équipe");
				await expect(page.getByRole("button", { name: /^Rétablir l’action \d+ : Critère 1\.1/ }).count()).resolves.toBe(
					1,
				);
				const text = await schemaPreview(page);
				expect(text).toContain("Marie Durand, rattachée à la direction");
				expect(text).toContain("Actions retirées par l’organisme, gardées pour mémoire");
			};
			await check(a);
			await a.reload();
			await a.waitForSelector("astro-island:not([ssr])");
			await check(a);
			const file = await download(a, "Télécharger l’audit (JSON)");
			expect(file.json.schemaVersion).toBe(5);
			expect(file.json.schema.actions).toHaveLength(3);
			await first.close();
			const second = await browser.newContext();
			const b = await second.newPage();
			await openAudit(b);
			await b
				.getByLabel("Importer un audit (JSON)")
				.setInputFiles({ name: file.name, mimeType: "application/json", buffer: Buffer.from(file.content) });
			await check(b);
			await second.close();
		});

		for (const [colorScheme, width] of [
			["light", 1280],
			["dark", 1280],
			["light", 375],
		] as const) {
			const name = `${colorScheme === "light" ? "clair" : "sombre"}${width === 375 ? ", 375 px" : ""}`;
			it(`axe : aucune violation sur le schéma et le plan (${name})`, async () => {
				const page = await browser.newPage({ colorScheme, viewport: { width, height: 900 } });
				await openWith(page, sessionJson());
				await setPeriod(page);
				await syncButton(page).click();
				await expect.poll(() => rowHeads(page)).toHaveLength(2);
				// Section 5 avec une année choisie : l'aperçu du plan est rendu, et axe le juge (ADR-0021).
				await page.getByLabel("Année du plan d’action").selectOption("2027");
				await expect(page.locator("#plan-apercu").textContent()).resolves.toBe("Aperçu du plan d’action 2027");
				await page.getByRole("button", { name: /^Retirer l’action \d+ : Critère 8\.3 / }).click();
				await page.getByLabel("Intitulé d’une action libre").fill("");
				await page.getByRole("button", { name: "Ajouter l’action" }).click();
				await expect(page.getByLabel("Intitulé d’une action libre").getAttribute("aria-invalid")).resolves.toBe("true");
				await page.getByLabel("Année de début").fill("10");
				await page.getByLabel("Année de début").blur();
				await page.locator("#schema-debut-erreur").waitFor();
				if (captures) {
					await page
						.locator(".audit-schema")
						.screenshot({ path: join(captures, `schema-${colorScheme}-${width}.png`) });
				}
				expect(await axeViolations(page)).toEqual([]);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
				await page.close();
			});
		}

		it("année de début invalide : jamais enregistrée ; l’export est bloqué, focus sur le champ", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			await setPeriod(page);
			const downloads: string[] = [];
			page.on("download", (d) => downloads.push(d.suggestedFilename()));
			await page.getByLabel("Année de début").fill("0010");
			await page.getByRole("button", { name: "Télécharger le schéma (HTML)" }).click();
			await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("schema-debut");
			await expect.poll(() => live(page)).toBe("Export impossible : l’année de début est incomplète ou hors limites.");
			await page.waitForTimeout(600);
			expect(downloads).toEqual([]);
			expect((await stored(page)).schema.startYear).toBe(2026);
			// Corrigée sans quitter le champ : l'export l'enregistre avant de produire le document.
			await page.getByLabel("Année de début").fill("2027");
			const [file] = await Promise.all([
				page.waitForEvent("download"),
				page
					.getByRole("button", { name: "Télécharger le schéma (Markdown)" })
					.evaluate((b) => (b as HTMLButtonElement).click()),
			]);
			expect(await readFile(await file.path(), "utf8")).toContain("Période : de 2027 à 2029 (3 ans).");
			await page.close();
		});

		it("mention « Rampe vous aide seulement… » : dans l’interface et l’aperçu, jamais dans les fichiers", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			await setPeriod(page);
			const MENTION = "Ce document décrit la politique de votre organisme ; Rampe vous aide seulement à le structurer.";
			await expect.poll(() => schemaPreview(page)).toContain(MENTION);
			await expect(planPreview(page)).resolves.toContain(MENTION);
			for (const button of [
				"Télécharger le schéma (HTML)",
				"Télécharger le schéma (Markdown)",
				"Télécharger le plan d’action 2026 (HTML)",
				"Télécharger le plan d’action 2026 (Markdown)",
			])
				expect((await download(page, button)).content).not.toContain("Rampe vous aide");
			await page.close();
		});

		it("audit redevenu incomplet après une synchronisation : avertissement, et une ligne dans l’export", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			await syncButton(page).click();
			await expect.poll(() => rowHeads(page)).toHaveLength(2);
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes('"actions":[{'));
			const json = await stored(page);
			delete json.evaluations["11.1"][P1];
			await page.evaluate((v) => localStorage.setItem("rampe.audit.session", v), JSON.stringify(json));
			await page.reload();
			await page.waitForSelector("astro-island:not([ssr])");
			await expect
				.poll(() => page.locator(".audit-schema").textContent())
				.toContain("Attention : l’audit n’est plus complet.");
			const md = await download(page, "Télécharger le schéma (Markdown)");
			expect(md.content).toContain(
				"Liste établie à partir d’un audit qui n’est plus complet : à mettre à jour une fois l’audit terminé.",
			);
			await page.close();
		});

		it("deux actions libres de même intitulé : étiquettes distinctes, numérotées par ligne", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			for (let i = 0; i < 2; i++) {
				await page.getByLabel("Intitulé d’une action libre").fill("Audit annuel");
				await page.getByRole("button", { name: "Ajouter l’action" }).click();
			}
			await expect.poll(() => rowHeads(page)).toEqual(["Audit annuel", "Audit annuel"]);
			const labels = await page
				.locator(".audit-schema-table select, .audit-schema-table input, .audit-schema-table button")
				.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
			expect(new Set(labels).size).toBe(labels.length);
			expect(labels).toContain("Priorité de l’action 2 : Audit annuel");
			await page.close();
		});

		it("plus de 1 000 actions : la mise à jour depuis l’audit est refusée avec un message clair", async () => {
			const page = await browser.newPage();
			const actions = Array.from({ length: 1000 }, (_, i) => ({
				id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
				source: "libre",
				title: `Action ${i}`,
				comment: "",
				removed: false,
			}));
			await openWith(
				page,
				sessionJson((_, session) => {
					session.schemaVersion = 4;
					session.schema = { sections: {}, actions };
				}),
			);
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await syncButton(page).click();
			await expect.poll(() => live(page)).toMatch(/^Mise à jour impossible : le tableau dépasserait 1 000 actions/);
			expect(errors).toEqual([]);
			await page.close();
		});

		it("au clavier seul : ajouter une action libre, régler sa priorité, exporter", async () => {
			const page = await browser.newPage();
			await openWith(page, sessionJson());
			await setPeriod(page);
			await page.focus("body");
			await tabUntil(page, "el.id === 'schema-nouvelle-action'", { max: 600 });
			await page.keyboard.type("Former l’équipe éditoriale");
			await page.keyboard.press("Enter");
			await expect.poll(() => rowHeads(page)).toEqual(["Former l’équipe éditoriale"]);
			await expect.poll(() => live(page)).toBe("Action ajoutée : Former l’équipe éditoriale");
			await tabUntil(page, "el.getAttribute('aria-label') === 'Priorité de l’action 1 : Former l’équipe éditoriale'", {
				back: true,
				max: 20,
			});
			await page.keyboard.press("h"); // recherche par la première lettre : « haute »
			await expect
				.poll(() => page.getByLabel("Priorité de l’action 1 : Former l’équipe éditoriale").inputValue())
				.toBe("haute");
			await tabUntil(page, "el.textContent === 'Télécharger le schéma (Markdown)'", { max: 40 });
			const md = await download(page, "", "Enter");
			expect(md.content).toContain(
				`- Former l’équipe éditoriale. Priorité${NBSP}: haute. Année cible${NBSP}: [à définir].`,
			);
			await page.close();
		});
	});

	describe("audit réalisé par une IA : attribution (ADR-0022)", () => {
		const NOTICE =
			"Cet audit a été réalisé par une IA (Claude). Il n’est pas certifié et ne remplace pas un audit humain.";
		const IA = "par une IA (Claude), auto-évaluation non certifiée";
		const SAMPLE = ["https://exemple.fr/", "https://exemple.fr/contact/"];
		/** Session d'auto-évaluation COMPLÈTE, fabriquée par la vraie construction (fragments canoniques validés). */
		const autoSession = async () => {
			const fragments = rgaa.topics.map((t) =>
				parseFragment(
					new TextEncoder().encode(
						`${JSON.stringify(
							{
								evaluator: AUTO_EVALUATOR,
								date: "2026-10-16",
								entries: rgaa.criteria
									.filter((c) => c.topic === t.number)
									.flatMap((c) =>
										SAMPLE.map((page) => ({
											criterion: c.id,
											page,
											status: c.id === "1.1" ? "NC" : "C",
											note: `Test ${c.id}.1 appliqué à chaque élément concerné de la page.`,
										})),
									),
							},
							null,
							"\t",
						)}\n`,
					),
					t.number,
					SAMPLE,
					"2026-10-16",
				),
			);
			return serializeAutoSession(await buildAutoSession(SAMPLE, fragments));
		};
		const importAuto = async (page: Page) => {
			await openAudit(page);
			await page.getByLabel("Importer un audit (JSON)").setInputFiles({
				name: "session.json",
				mimeType: "application/json",
				buffer: Buffer.from(await autoSession()),
			});
			await page.locator(".audit-attribution").waitFor();
		};
		const banner = (page: Page) => page.locator(".audit-attribution").textContent();
		const result = (page: Page) => page.locator(".audit-result").evaluate((el) => (el as HTMLElement).innerText);
		const preview = (page: Page) => page.locator(".audit-preview").evaluate((el) => (el as HTMLElement).innerText);

		for (const colorScheme of ["light", "dark"] as const) {
			const scheme = colorScheme === "light" ? "clair" : "sombre";
			it(`import : bandeau, Résultat et déclaration portent la mention ; axe sans violation (${scheme})`, async () => {
				const page = await browser.newPage({ colorScheme });
				await importAuto(page);
				expect(await banner(page)).toContain(NOTICE);
				// Complet : le taux est affiché, et la mention l'accompagne.
				await expect.poll(() => page.locator(".audit-rate").count()).toBe(2);
				expect(await result(page)).toContain(NOTICE);
				expect(await preview(page)).toContain(`L’audit de conformité réalisé ${IA} révèle que`);
				// Verrouillé : pas de choix « en interne / prestataire » tant que l'attribution existe.
				expect(await page.getByRole("radio", { name: "En interne" }).count()).toBe(0);
				expect(await axeViolations(page)).toEqual([]);
				if (captures) await page.locator(".audit-attribution").screenshot({ path: join(captures, `ia-${scheme}.png`) });
				await page.close();
			});
		}

		it("exports de la déclaration (HTML, Markdown) et de l'audit : l'attribution y est", async () => {
			const page = await browser.newPage();
			await importAuto(page);
			expect((await download(page, "Télécharger (HTML)")).content).toContain(`réalisé ${IA} révèle`);
			expect((await download(page, "Télécharger (Markdown)")).content).toContain(`réalisé ${IA} révèle`);
			expect((await download(page, "Télécharger l’audit (JSON)")).json.evaluatedBy).toEqual({
				kind: "ia",
				name: "Claude",
				certified: false,
			});
			await page.close();
		});

		it("reprise : confirmation refusée → rien ne change ; acceptée → mention retirée ; Annuler → rétablie", async () => {
			const page = await browser.newPage();
			await importAuto(page);
			const take = page.getByRole("button", { name: "Je reprends cet audit à mon compte" });
			const messages: string[] = [];
			page.once("dialog", (d) => {
				messages.push(d.message());
				d.dismiss();
			});
			await take.click();
			expect(messages[0]).toMatch(/endossez alors chacune de ses évaluations/);
			expect(await banner(page)).toContain(NOTICE);

			page.once("dialog", (d) => d.accept());
			await take.click();
			await expect.poll(() => banner(page)).toContain("Vous avez repris à votre compte");
			// Le focus suit : il est sur « Annuler », pas perdu sur le corps de la page.
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Annuler");
			expect(await result(page)).not.toContain("par une IA");
			expect(await preview(page)).not.toContain(IA);
			await page.getByRole("radio", { name: "En interne" }).check();
			await expect.poll(() => preview(page)).toContain("L’audit de conformité réalisé en interne révèle que");
			expect(await axeViolations(page)).toEqual([]);
			// Retirée aussi de ce qui est enregistré.
			await expect
				.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rampe.audit.session") ?? "{}").evaluatedBy))
				.toBeUndefined();

			await page.getByRole("button", { name: "Annuler", exact: true }).click();
			await expect.poll(() => banner(page)).toContain(NOTICE);
			expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Je reprends cet audit à mon compte");
			expect(await result(page)).toContain(NOTICE);
			expect(await preview(page)).toContain(`réalisé ${IA} révèle`);
			// Persistée : enregistrée, puis relue après rechargement.
			await expect
				.poll(() =>
					page.evaluate(() => JSON.parse(localStorage.getItem("rampe.audit.session") ?? "{}").evaluatedBy?.name),
				)
				.toBe("Claude");
			await page.reload();
			await page.waitForSelector("astro-island:not([ssr])");
			expect(await banner(page)).toContain(NOTICE);
			await page.close();
		});
	});
});
