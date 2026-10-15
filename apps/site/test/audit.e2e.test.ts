// Bout en bout de l'audit guidé (ADR-0013) : build réel du site, servi en local, piloté dans un vrai Chromium.
// Preuves : axe sans violation (clair, sombre, mobile) après interactions, parcours au clavier seul,
// reprise de la session, stockage indisponible ou corrompu, aucune autre page avec du JavaScript, et import d'un
// rapport produit par la VRAIE CLI (ADR-0014) sur sa page de test à défauts connus.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { rgaa } from "@rampe/core";
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
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
		execFile(process.execPath, [astro, "build", "--outDir", out], { cwd: root }, (error, _o, stderr) =>
			error ? reject(new Error(stderr)) : resolve(),
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
		const bodies: Promise<number>[] = [];
		page.on("response", (r) => {
			if (r.url().endsWith(".js")) bodies.push(r.body().then((b) => b.length));
		});
		await openAudit(page);
		await page.waitForLoadState("networkidle");
		const files = bodies.length;
		const js = (await Promise.all(bodies)).reduce((a, b) => a + b, 0);
		const inline = await page.evaluate(() =>
			[...document.querySelectorAll("script:not([src])")].reduce((n, s) => n + (s.textContent?.length ?? 0), 0),
		);
		console.log(
			`/audit/ : ${files} modules JS, ${js} octets non compressés ; scripts en ligne d'Astro : ${inline} octets`,
		);
		expect(js).toBeGreaterThan(0);
		// Budget relevé de 60 000 à 70 000 avec l'écran « Résultat » (ADR-0015) : 62 299 octets à ce moment-là.
		expect(js).toBeLessThan(70_000);
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
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(1);
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
		await expect(page.locator("article").count()).resolves.toBe(0);
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
		await expect(page.getByLabel("Note sur Contact (facultative)").count()).resolves.toBe(1);
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
			await expect(list.count()).resolves.toBe(width < 700 ? 1 : 0);
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
		await expect(alert.count()).resolves.toBe(1);
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
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(2);
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
		await expect(page.getByText("Votre travail ne sera pas conservé si vous fermez cette page.").count()).resolves.toBe(
			1,
		);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(1);
		await page.close();
	});

	it("session corrompue : avertissement, valeur mise de côté, nouvel audit sans plantage", async () => {
		const page = await browser.newPage();
		await page.addInitScript(() => {
			if (!sessionStorage.getItem("seeded")) {
				localStorage.setItem("rampe.audit.session", '{"schemaVersion":2,"pages":"abîmé"}');
				sessionStorage.setItem("seeded", "1");
			}
		});
		await openAudit(page);
		await expect(page.getByText(/n’a pas pu être relue/).count()).resolves.toBe(1);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session.ignoree"))).resolves.toBe(
			'{"schemaVersion":2,"pages":"abîmé"}',
		);
		await addPage(page, "https://exemple.fr/", "Accueil");
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(1);
		await page.close();
	});

	it("« Recommencer » demande confirmation puis efface l'audit", async () => {
		const page = await browser.newPage();
		await openAudit(page);
		await addPage(page, "https://exemple.fr/", "Accueil");
		page.once("dialog", (d) => d.dismiss());
		await page.getByRole("button", { name: "Effacer cet audit et recommencer" }).click();
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(1);
		page.once("dialog", (d) => d.accept());
		await page.getByRole("button", { name: "Effacer cet audit et recommencer" }).click();
		await expect(page.locator(".audit-page-list li").count()).resolves.toBe(0);
		await page.close();
	});

	describe("import d'un rapport de la CLI (ADR-0014)", () => {
		const IMPORT_LABEL = "Importer un rapport de la CLI (JSON)";
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
			await expect(page.locator(".audit-page-list li").count()).resolves.toBe(1);

			// 1.1 : l'humain avait dit « Conforme » ; l'import n'y touche pas, mais l'indice image-alt est visible.
			const g11 = group(page, "1.1");
			await expect(g11.getByLabel("Conforme", { exact: true }).isChecked()).resolves.toBe(true);
			await expect(g11.locator(".audit-auto").count()).resolves.toBe(0);
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
			await expect(group(page, "3.2").locator(".audit-auto").count()).resolves.toBe(0);
			await page.waitForFunction(() => localStorage.getItem("rampe.audit.session")?.includes("2,0:1"));
			const saved = JSON.parse((await stored(page)) ?? "{}");
			expect(saved.schemaVersion).toBe(2);
			const [pageId] = saved.pages.map((p: { id: string }) => p.id);
			expect(saved.evaluations["1.1"][pageId]).toMatchObject({ status: "C", source: "humain" });
			expect(saved.evaluations["3.2"][pageId]).toMatchObject({ status: "NC", source: "humain" });
			expect(saved.evaluations["8.3"][pageId]).toMatchObject({ status: "NC", source: "auto" });
			// Plus d'annulation possible après une autre modification.
			await expect(page.getByRole("button", { name: "Annuler cet import" }).count()).resolves.toBe(0);
			await page.close();
		});

		it("« Confirmer » garde le statut et le rend humain ; changer un statut automatique vide la note générée", async () => {
			const page = await browser.newPage();
			await importScenario(page);
			await showCriterion(page, "8.3");
			const g = group(page, "8.3");
			await g.getByRole("button", { name: "Confirmer « Non conforme » pour Défauts" }).click();
			await expect(g.locator(".audit-auto").count()).resolves.toBe(0);
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
			await expect(page.locator(".audit-findings").count()).resolves.toBe(0);
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
			const invalid = "Ce fichier n’est pas un rapport de la CLI Rampe, ou il a été modifié. Rien n’a été importé.";
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
				await expect(error.locator("details").count()).resolves.toBe(detail ? 1 : 0);
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
			await expect(page.locator(".audit-import-summary").count()).resolves.toBe(0);
			await page.close();

			// Autre site : l'audit en cours porte sur exemple.fr.
			const other = await browser.newPage();
			await openAudit(other);
			await addPage(other, "https://exemple.fr/", "Accueil");
			await other.getByLabel(IMPORT_LABEL).setInputFiles(reportPath);
			await expect(other.locator("#audit-rapport-erreur").textContent()).resolves.toMatch(
				/^Ce rapport porte sur un autre site \(http:\/\/127\.0\.0\.1:\d+\) que l’audit en cours \(https:\/\/exemple\.fr\)\./,
			);
			await expect(other.locator(".audit-page-list li").count()).resolves.toBe(1);
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
	describe("taux de conformité (ADR-0015)", () => {
		const [P1, P2, P3] = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`) as [string, string, string];
		const PCT = "\u202f%";
		/** Tout NA sur les 3 pages, sauf 1.1, 3.2 et 8.3 (exemple chiffré du test de conformity.ts). */
		function sessionJson(patch: (evaluations: Record<string, Record<string, unknown>>) => void = () => {}) {
			const evaluations: Record<string, Record<string, unknown>> = {};
			const e = (status: string) => ({ status, note: "", source: "humain" });
			for (const c of rgaa.criteria) evaluations[c.id] = { [P1]: e("NA"), [P2]: e("NA"), [P3]: e("NA") };
			evaluations["1.1"] = { [P1]: e("C"), [P2]: e("C"), [P3]: e("NC") };
			evaluations["3.2"] = { [P1]: e("C"), [P2]: e("C"), [P3]: e("C") };
			evaluations["8.3"] = { [P1]: e("NC"), [P2]: e("NA"), [P3]: e("C") };
			patch(evaluations);
			const at = "2026-10-15T10:00:00.000Z";
			return JSON.stringify({
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
			});
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
			await expect(region.evaluate((el) => el.scrollWidth > el.clientWidth)).resolves.toBe(true);
			await region.focus();
			await page.keyboard.press("ArrowRight");
			// Défilement éventuellement animé : on attend qu'il ait eu lieu.
			await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
			if (captures) await page.locator(".audit-result").screenshot({ path: join(captures, "resultat-320.png") });
			expect(await axeViolations(page)).toEqual([]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
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
});
