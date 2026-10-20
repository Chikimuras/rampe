// Paquet npm réel (ADR-0025 §3) : build, liste de `npm pack`, puis installation de l'archive dans un dossier vierge et
// audit d'une page de test par le binaire installé. Teste ce qui est publié, pas les sources.
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditReport } from "../src/audit.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
const playwrightVersion: string = pkg.dependencies.playwright;

const npm = (args: string[], cwd: string) => execFileSync("npm", args, { cwd, encoding: "utf8" });

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "rampe-paquet-"));
	npm(["run", "build"], pkgDir);
	server = createServer(async (req, res) => {
		// Une seule page servie, nom fixe : aucun chemin venu de la requête n'atteint le disque.
		if (req.url !== "/defauts") return res.writeHead(404).end();
		res
			.writeHead(200, { "content-type": "text/html; charset=utf-8" })
			.end(await readFile(join(fixtures, "defauts.html")));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("paquet npm rampe", () => {
	it("contient exactement le binaire, le README, la licence et package.json", () => {
		const [packed] = JSON.parse(npm(["pack", "--dry-run", "--json"], pkgDir));
		expect(packed.files.map((f: { path: string }) => f.path).sort()).toEqual([
			"LICENSE",
			"README.md",
			"dist/rampe.mjs",
			"package.json",
		]);
	});

	it("installé dans un dossier vierge, son binaire audite une page", { timeout: 300_000 }, async () => {
		const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", dir], pkgDir));
		const project = join(dir, "projet");
		await mkdir(project);
		await writeFile(join(project, "package.json"), '{ "private": true }\n');
		// Navigateurs déjà installés sur la machine (même version de Playwright) : rien à télécharger.
		execFileSync("npm", ["install", "--no-audit", "--no-fund", join(dir, packed.filename)], {
			cwd: project,
			env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
		});

		const bin = join(project, "node_modules/.bin/rampe");
		const json = join(dir, "rapport.json");
		const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
			new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
				execFile(bin, ["audit", `${base}/defauts`, ...args], { cwd: project, env }, (error, stdout, stderr) => {
					resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr });
				});
			});

		const { code, stderr } = await run(["--json", json]);
		expect(code, stderr).toBe(1);
		const report: AuditReport = JSON.parse(await readFile(json, "utf8"));
		expect(report.tool).toEqual({ name: "@rampe/cli", version: pkg.version });
		const nc = report.pages[0]?.results.filter((r) => r.kind === "non-conformite") ?? [];
		expect(nc.find((r) => r.ruleId === "image-alt")?.criteria).toEqual(["1.1"]);

		// Navigateur absent : la commande d'installation exacte, à la version de Playwright du paquet.
		const empty = join(dir, "navigateurs-vides");
		await mkdir(empty);
		const missing = await run([], { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty });
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain(`npx playwright@${playwrightVersion} install chromium`);
	});
});
