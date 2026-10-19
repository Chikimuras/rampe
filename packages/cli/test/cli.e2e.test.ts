// Bout en bout : la vraie CLI (processus enfant, vrai Chromium) contre des pages servies en local.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAuditReport, rgaa } from "@rampe/core";
import axe from "axe-core";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditReport } from "../src/audit.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

// --json et --html n'écrasent jamais : les fichiers du test précédent sont retirés avant chaque lancement.
const run = async (...args: string[]) => {
	await rm(json, { force: true });
	await rm(html, { force: true });
	return runCli(...args);
};
const runCli = (...args: string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => {
			resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr });
		});
	});

const FIXTURES = new Set([
	"propre",
	"defauts",
	"region",
	"boucle",
	"quitte",
	"csp",
	"titre-long",
	"hostile",
	"ifr-honest",
	"ifr-null",
	"ifr-fake",
	"navdrift",
	"docwrite",
	"media",
]);
const json = join(tmpdir(), `rampe-e2e-${process.pid}.json`);
const html = join(tmpdir(), `rampe-e2e-${process.pid}.html`);
let server: Server;
let port: number;
let base: string;

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const name = new URL(req.url ?? "/", "http://x").pathname.slice(1);
		// Redirection vers une autre origine (localhost au lieu de 127.0.0.1).
		if (name === "redirige") return res.writeHead(302, { location: `http://localhost:${port}/propre` }).end();
		// Cible de navigation qui ne répond jamais : la requête part, le nouveau document n'est jamais validé.
		if (name === "lent") return;
		// Noms de fichiers fixes : aucun chemin venu de la requête n'atteint le disque.
		if (!FIXTURES.has(name)) return res.writeHead(404).end();
		res
			.writeHead(200, { "content-type": "text/html; charset=utf-8" })
			.end(await readFile(join(fixtures, `${name}.html`)));
	});
	// Toutes les interfaces : `localhost` peut se résoudre en ::1 ou en 127.0.0.1.
	await new Promise<void>((resolve) => server.listen(0, resolve));
	port = (server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await rm(json, { force: true });
	await rm(html, { force: true });
	server.closeAllConnections(); // requêtes vers /lent, restées sans réponse
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Port libre : ouvert puis refermé, donc personne n'y écoute. */
const freePort = async () => {
	const s = createServer();
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const { port } = s.address() as AddressInfo;
	await new Promise<void>((resolve) => s.close(() => resolve()));
	return port;
};

const readReport = async (): Promise<AuditReport> => JSON.parse(await readFile(json, "utf8"));

describe("rampe audit (bout en bout)", { timeout: 60_000 }, () => {
	it("détecte les défauts connus, rangés par critère RGAA, et sort en 1", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/defauts`, "--json", json);
		expect(code, stderr).toBe(1);

		const report = await readReport();
		expect(report.schemaVersion).toBe(2);
		expect(report.pages[0]?.error).toBeNull();
		const [page] = report.pages;
		expect(page?.finalUrl).toBe(`${base}/defauts`);
		const nc = page?.results.filter((r) => r.kind === "non-conformite") ?? [];
		expect(Object.fromEntries(nc.map((r) => [r.ruleId, r.criteria]))).toMatchObject({
			"image-alt": ["1.1"],
			label: ["11.1"],
			"color-contrast": ["3.2"],
			"html-has-lang": ["8.3"],
		});
		const deprecated = new Set(
			axe
				.getRules()
				.filter((r) => r.tags.includes("deprecated"))
				.map((r) => r.ruleId),
		);
		expect(page?.results.filter((r) => deprecated.has(r.ruleId))).toEqual([]);
		// Le fichier écrit est importable tel quel dans l'audit guidé (ADR-0014), description des règles comprise.
		expect(nc.find((r) => r.ruleId === "image-alt")?.help).toBe("Images must have alternative text");
		const importable = parseAuditReport(report, new Set(rgaa.criteria.map((c) => c.id)));
		expect(importable.pages[0]?.results.length).toBe(page?.results.length);

		for (const id of ["1.1", "3.2", "8.3", "11.1"]) expect(stdout).toContain(`Critère ${id} — `);
		expect(stdout).toContain(
			"Les 106 critères demandent une vérification humaine. 79 d’entre eux n’ont même aucune vérification automatique directe.",
		);
	});

	it("une page qui falsifie window.axe et casse les primitives JS ne trompe pas l'audit (ADR-0020)", async () => {
		const nonConformities = (report: AuditReport) =>
			(report.pages[0]?.results ?? [])
				.filter((r) => r.kind === "non-conformite")
				.map((r) => [r.ruleId, r.criteria] as const)
				.sort();
		const sain = await run("audit", `${base}/defauts`, "--json", json);
		expect(sain.code, sain.stderr).toBe(1);
		const attendu = nonConformities(await readReport());

		const { code, stdout, stderr } = await run("audit", `${base}/hostile`, "--json", json);
		expect(stdout).not.toContain("Aucune non-conformité");
		expect(code, stderr).toBe(1);
		const report = await readReport();
		expect(report.pages[0]?.error).toBeNull();
		expect(nonConformities(report)).toEqual(attendu);
		for (const id of ["1.1", "3.2", "8.3", "11.1"]) expect(stdout).toContain(`Critère ${id} — `);
	});

	it("une iframe qui répond à la messagerie d'axe ne change pas le résultat (ADR-0020, iframes: false)", async () => {
		// Témoin : même page, iframe muette. Pièges : l'iframe répond à axe par postMessage, soit en faisant passer les
		// non-conformités en « à vérifier » (ifr-null), soit en ajoutant un faux élément en défaut (ifr-fake).
		const witness = await run("audit", `${base}/ifr-honest`, "--json", json);
		expect(witness.code, witness.stderr).toBe(1);
		const expected = (await readReport()).pages[0]?.results;
		expect(expected?.find((r) => r.ruleId === "frame-tested")?.kind).toBe("a-verifier");
		for (const trap of ["ifr-null", "ifr-fake"]) {
			const { code, stdout, stderr } = await run("audit", `${base}/${trap}`, "--json", json);
			expect(code, `${trap} : ${stderr}`).toBe(1);
			expect(stdout).not.toContain("Aucune non-conformité");
			expect((await readReport()).pages[0]?.results, trap).toEqual(expected);
		}
	});

	it("sort en 2 si la page navigue pendant l'analyse, sans aucun rapport", async () => {
		// Ordre forcé : la requête de navigation part pendant l'analyse, la validation du nouveau document n'arrive
		// jamais. Un audit qui ne guette que la destruction du monde isolé le rate, quelle que soit la charge.
		const { code, stderr } = await run("audit", `${base}/navdrift`, "--json", json, "--timeout", "20000");
		expect(code, stderr).toBe(2);
		expect(stderr).toContain("La page a navigué pendant l’analyse : audit impossible.");
		// Aucun résultat attribué à une page, ni à navdrift ni à la cible de la navigation.
		await expect(readFile(json, "utf8")).rejects.toThrow();
	});

	it("sort en 2 si l'URL change pendant l'analyse sans requête (history.pushState), sans aucun rapport", async () => {
		const { code, stderr } = await run("audit", `${base}/navdrift?historique`, "--json", json, "--timeout", "20000");
		expect(code, stderr).toBe(2);
		expect(stderr).toContain("La page a navigué pendant l’analyse : audit impossible.");
		await expect(readFile(json, "utf8")).rejects.toThrow();
	});

	it("titre lu avec l'analyse : une page qui se réécrit pendant l'analyse ne change pas le titre", async () => {
		const { code, stderr } = await run("audit", `${base}/docwrite`, "--json", json);
		expect(code, stderr).toBe(1);
		expect((await readReport()).pages[0]?.title).toBe("Piege docwrite");
	});

	it("borne le titre de la page à 300 caractères dans le JSON", async () => {
		const { code, stderr } = await run("audit", `${base}/titre-long`, "--json", json);
		expect(code, stderr).toBe(0);
		expect((await readReport()).pages[0]?.title).toBe(`${"T".repeat(300)}… (tronqué)`);
	});

	it("sort en 0 sur une page sans non-conformité détectée", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/propre`);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("Aucune non-conformité détectée automatiquement");
	});

	it("refuse un schéma autre que http(s) avec le code 2", async () => {
		const { code, stderr } = await run("audit", "file:///etc/passwd");
		expect(code).toBe(2);
		expect(stderr).toMatch(/http/);
	});

	it("sort en 2 si la page est injoignable", async () => {
		const { code } = await run("audit", `http://127.0.0.1:${await freePort()}/`, "--timeout", "5000");
		expect(code).toBe(2);
	});

	it("bonne pratique d'axe rattachée au RGAA (region) : incertain, sort en 0", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/region`, "--json", json);
		expect(code, stderr).toBe(0);
		const results = (await readReport()).pages[0]?.results ?? [];
		expect(results.map((r) => [r.ruleId, r.kind])).toEqual([["region", "incertain"]]);
		expect(stdout).toContain("Aucune non-conformité détectée automatiquement");
		expect(stdout).toContain("règle indicative d’axe : à confirmer par une personne");
	});

	it("--strict : un résultat incertain (region) fait aussi sortir en 1, avec l'explication", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/region`, "--strict");
		expect(code, stderr).toBe(1);
		expect(stdout).toContain("Aucune non-conformité détectée automatiquement");
		expect(stdout).toContain("Mode --strict");
	});

	it("--theme sombre audite la page en prefers-color-scheme: dark", async () => {
		const contrast = async (...args: string[]) => {
			const { code, stderr } = await run("audit", `${base}/media`, "--json", json, ...args);
			const nc = (await readReport()).pages[0]?.results.filter((r) => r.kind === "non-conformite") ?? [];
			return { code, stderr, rules: nc.map((r) => [r.ruleId, r.nodes.map((n) => n.target.join(" "))]) };
		};
		const clair = await contrast();
		expect(clair.code, clair.stderr).toBe(0);
		expect((await contrast("--theme", "clair")).code).toBe(0);
		const sombre = await contrast("--theme", "sombre");
		expect(sombre.code, sombre.stderr).toBe(1);
		expect(sombre.rules).toEqual([["color-contrast", ["h1", "p"]]]);
	});

	it("--largeur fixe la largeur de la fenêtre (hauteur 720)", async () => {
		const { code, stderr } = await run("audit", `${base}/media`, "--json", json, "--largeur", "375");
		expect(code, stderr).toBe(1);
		const nc = (await readReport()).pages[0]?.results.filter((r) => r.kind === "non-conformite") ?? [];
		expect(nc.map((r) => [r.ruleId, r.nodes.map((n) => n.target.join(" "))])).toEqual([["color-contrast", ["p"]]]);
	});

	it("refuse un thème, une largeur ou une option d'audit invalides avec le code 2", async () => {
		for (const args of [
			["audit", `${base}/propre`, "--theme", "bleu"],
			["audit", `${base}/propre`, "--largeur", "100"],
			["audit", `${base}/propre`, "--largeur", "12.5"],
			["echantillon", `${base}/propre`, "--strict"],
			["echantillon", `${base}/propre`, "--theme", "sombre"],
		]) {
			const { code, stderr } = await run(...args);
			expect(code, args.join(" ")).toBe(2);
			expect(stderr).toMatch(/--theme|--largeur|--strict/);
		}
	});

	it("borne toute l'opération par --timeout, même si la page bloque son fil principal", async () => {
		const t0 = Date.now();
		const { code, stderr } = await run("audit", `${base}/boucle`, "--timeout", "4000");
		expect(code).toBe(2);
		expect(stderr).toContain("audit interrompu après 4000 ms");
		expect(Date.now() - t0).toBeLessThan(20_000);
	});

	it("refuse une page qui quitte le web (about:blank) avec le code 2", async () => {
		const { code, stderr } = await run("audit", `${base}/quitte`);
		expect(code).toBe(2);
		expect(stderr).toContain("about:blank");
	});

	it("injecte axe malgré une CSP script-src 'none'", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/csp`);
		expect(code, stderr).toBe(1);
		expect(stdout).toContain("image-alt (test 1.1.1)");
	});

	it("avertit d'un changement d'origine et masque les identifiants partout", async () => {
		const { code, stdout, stderr } = await run(
			"audit",
			`http://alice:secret@127.0.0.1:${port}/redirige`,
			"--json",
			json,
		);
		expect(code, stderr).toBe(0);
		expect(stderr).toContain(
			`Avertissement : La page finale est sur une autre origine que celle demandée : http://localhost:${port}/propre`,
		);
		const raw = await readFile(json, "utf8");
		const [page] = JSON.parse(raw).pages;
		expect(page.url).toBe(`http://***:***@127.0.0.1:${port}/redirige`);
		expect(page.warnings).toHaveLength(1);
		for (const out of [stdout, stderr, raw]) expect(out).not.toContain("secret");
	});

	it("--json et --html ensemble : le rapport HTML est lui-même sans violation axe, en clair et en sombre", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/defauts`, "--json", json, "--html", html);
		expect(code, stderr).toBe(1);
		expect(stdout).toContain(`Rapport HTML écrit dans ${html}`);
		await readReport();
		const report = await readFile(html, "utf8");
		for (const id of ["1-1", "3-2", "8-3", "11-1"]) expect(report).toContain(`id="critere-${id}"`);
		expect(report).not.toMatch(/<script/i);

		const browser = await chromium.launch({ chromiumSandbox: true });
		try {
			for (const colorScheme of ["light", "dark"] as const) {
				const page = await browser.newPage({ colorScheme });
				await page.goto(pathToFileURL(html).href);
				await page.evaluate(() => {
					for (const d of document.querySelectorAll("details")) d.open = true;
				});
				await page.evaluate(axe.source);
				const violations = await page.evaluate(async () => {
					const r = await (window as unknown as { axe: typeof axe }).axe.run();
					return r.violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
				});
				expect(violations, colorScheme).toEqual([]);
				await page.close();
			}
		} finally {
			await browser.close();
		}
	});

	it("refuse --html égal à --json, avant tout chargement", async () => {
		const { code, stdout, stderr } = await run("audit", `${base}/propre`, "--json", json, "--html", json);
		expect(code).toBe(2);
		expect(stderr).toContain("--json et --html désignent le même fichier");
		expect(stdout).toBe("");
	});
});
