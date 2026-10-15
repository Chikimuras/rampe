// Bout en bout : la vraie CLI (processus enfant, vrai Chromium) contre des pages servies en local.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const FIXTURES = new Set(["propre", "defauts", "region", "boucle", "quitte", "csp"]);
const json = join(tmpdir(), `rampe-e2e-${process.pid}.json`);
const html = join(tmpdir(), `rampe-e2e-${process.pid}.html`);
let server: Server;
let port: number;
let base: string;

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const name = req.url?.slice(1) ?? "";
		// Redirection vers une autre origine (localhost au lieu de 127.0.0.1).
		if (name === "redirige") return res.writeHead(302, { location: `http://localhost:${port}/propre` }).end();
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

		for (const id of ["1.1", "3.2", "8.3", "11.1"]) expect(stdout).toContain(`Critère ${id} — `);
		expect(stdout).toContain(
			"Les 106 critères demandent une vérification humaine. 79 d’entre eux n’ont même aucune vérification automatique directe.",
		);
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
		expect(stdout).toContain("règle de bonne pratique d’axe : à confirmer par un humain");
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
