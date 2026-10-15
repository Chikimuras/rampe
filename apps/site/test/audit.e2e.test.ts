// Bout en bout de l'audit guidé (ADR-0013) : build réel du site, servi en local, piloté dans un vrai Chromium.
// Preuves : axe sans violation (clair, sombre, mobile) après interactions, parcours au clavier seul,
// reprise de la session, stockage indisponible ou corrompu, et aucune autre page avec du JavaScript.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const astro = fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url));
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

beforeAll(async () => {
	out = await mkdtemp(join(tmpdir(), "rampe-site-"));
	await new Promise<void>((resolve, reject) =>
		execFile(process.execPath, [astro, "build", "--outDir", out], { cwd: root }, (error, _o, stderr) =>
			error ? reject(new Error(stderr)) : resolve(),
		),
	);
	server = createServer(async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
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
}, 120_000);

afterAll(async () => {
	await browser?.close();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (out) await rm(out, { recursive: true, force: true });
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
		expect(js).toBeLessThan(60_000);
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
		await expect(page.locator(".audit-help").isVisible()).resolves.toBe(true);
		await expect(page.locator(".audit-help").textContent()).resolves.toContain(
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
				localStorage.setItem("rampe.audit.session", '{"schemaVersion":99}');
				sessionStorage.setItem("seeded", "1");
			}
		});
		await openAudit(page);
		await expect(page.getByText(/n’a pas pu être relue/).count()).resolves.toBe(1);
		await expect(page.evaluate(() => localStorage.getItem("rampe.audit.session.ignoree"))).resolves.toBe(
			'{"schemaVersion":99}',
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
});
