// Bout en bout : la vraie CLI (processus enfant, vrai Chromium) contre des pages servies en local.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditReport } from "../src/audit.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

const run = (...args: string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => {
			resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr });
		});
	});

let server: Server;
let base: string;

beforeAll(async () => {
	server = createServer(async (req, res) => {
		try {
			// Noms de fichiers fixes : pas de chemin venu de la requête.
			const name = req.url === "/propre" ? "propre.html" : req.url === "/defauts" ? "defauts.html" : null;
			if (!name) throw new Error("introuvable");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(join(fixtures, name)));
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("rampe audit (bout en bout)", { timeout: 60_000 }, () => {
	it("détecte les défauts connus, rangés par critère RGAA, et sort en 1", async () => {
		const json = join(tmpdir(), `rampe-e2e-${process.pid}.json`);
		const { code, stdout, stderr } = await run("audit", `${base}/defauts`, "--json", json);
		expect(code, stderr).toBe(1);

		const report: AuditReport = JSON.parse(await readFile(json, "utf8"));
		expect(report.schemaVersion).toBe(1);
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
		expect(stdout).toContain("n’ont aucune vérification automatique directe : audit humain indispensable");
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
		const { code } = await run("audit", "http://127.0.0.1:1/", "--timeout", "5000");
		expect(code).toBe(2);
	});
});
