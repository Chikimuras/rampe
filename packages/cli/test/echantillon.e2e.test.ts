// Bout en bout : `rampe echantillon` puis `rampe audit --echantillon`, vraie CLI et vrai Chromium, sur un mini-site local.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Pages sans défaut du mini-site ; /contact a une image sans alternative (critère 1.1).
const PAGES = new Set([
	"/services",
	"/services/renovation",
	"/realisations",
	"/a-propos",
	"/recherche",
	"/devis",
	"/blog/article-1",
	"/blog/article-2",
	"/mentions-legales",
	"/accessibilite",
	"/plan-du-site",
]);
const page = (title: string, body = "<p>Contenu.</p>") =>
	`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "rampe-echantillon-"));
	server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		const html = (body: string | Buffer) =>
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
		// Chemins fixes : aucun chemin venu de la requête n'atteint le disque ni la page.
		if (path === "/") return html(await readFile(join(fixtures, "site-accueil.html")));
		if (path === "/boucle") return html(await readFile(join(fixtures, "boucle.html")));
		if (path === "/contact") return html(page("Contact", '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'));
		if (PAGES.has(path)) return html(page("Page du mini-site"));
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("rampe echantillon puis audit --echantillon (bout en bout)", { timeout: 120_000 }, () => {
	it("propose l'échantillon RGAA, avec raisons et manques, puis audite toutes ses pages", async () => {
		const file = join(dir, "echantillon.txt");
		const proposed = await run("echantillon", `${base}/`, "--sortie", file, "--graine", "1");
		expect(proposed.code, proposed.stderr).toBe(0);
		const text = await readFile(file, "utf8");

		expect(text).toContain(`# accueil — page indiquée en entrée\n${base}/\n`);
		expect(text).toContain(
			`# contact — lien « Contact », texte reconnu, adresse « /contact » reconnue, dans l’en-tête\n${base}/contact\n`,
		);
		expect(text).toContain(`dans le pied de page\n${base}/mentions-legales\n`);
		expect(text).toContain(
			`# accessibilité — lien « Accessibilité : partiellement conforme », texte reconnu, adresse « /accessibilite » reconnue, dans le pied de page\n`,
		);
		expect(text).toContain(`${base}/plan-du-site\n`);
		expect(text).toContain(
			`# recherche — formulaire dans une zone de recherche (role="search"), page de résultats pour « contact »\n${base}/recherche?q=contact&lang=fr\n`,
		);
		for (const r of ["services", "realisations", "a-propos"])
			expect(text).toMatch(
				new RegExp(`# rubrique — lien « .+ » de la navigation principale « Navigation du site »\\n${base}/${r}\\n`),
			);
		expect(text).not.toMatch(/rubrique — lien « Rénovation »/);
		expect(text).toMatch(/# hasard — tirée au hasard \(graine 1\)\n/);
		expect(text).toContain("#   aide — non trouvée automatiquement : à ajouter si elle existe");
		expect(text).toContain("#   authentification — non trouvée automatiquement : à ajouter si elle existe");
		expect(text).toContain("#   processus — ");
		expect(text).toContain("#   contenus particuliers — ");
		// Ni PDF, ni mailto, ni autre origine, ni fragment, ni le paragraphe « Contactez-nous pour un devis » comme contact.
		expect(text).not.toMatch(
			/catalogue\.pdf|mailto:|autre\.example|#suite|contact — lien « Contactez-nous pour un devis/,
		);
		expect(proposed.stdout).toContain("Échantillon proposé pour");
		expect(proposed.stdout).toContain(`rampe audit --echantillon ${file}`);
		expect(proposed.stdout).toContain("Même tirage au hasard : --graine 1");

		// Même graine, même échantillon ; le fichier existant n'est jamais écrasé.
		const again = join(dir, "encore.txt");
		expect((await run("echantillon", `${base}/`, "--sortie", again, "--graine", "1")).code).toBe(0);
		expect(await readFile(again, "utf8")).toBe(text);
		const refused = await run("echantillon", `${base}/`, "--sortie", file);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain("existe déjà");

		const json = join(dir, "echantillon.json");
		const audited = await run("audit", "--echantillon", file, "--json", json);
		expect(audited.code, audited.stderr).toBe(1);
		const report: AuditReport = JSON.parse(await readFile(json, "utf8"));
		const urls = text.split("\n").filter((l) => l.startsWith("http"));
		expect(report.schemaVersion).toBe(2);
		expect(report.pages.map((p) => p.url)).toEqual(urls);
		expect(report.pages.every((p) => p.error === null)).toBe(true);
		expect(audited.stdout).toContain(`=== Page 1/${urls.length} : ${base}/ ===`);
		expect(audited.stdout).toMatch(
			new RegExp(`Critère 1\\.1 — .* : 1 page\\n {4}- ${base.replace(/\./g, "\\.")}/contact`),
		);
		expect(audited.stdout).toContain("Les 106 critères demandent une vérification humaine.");
	});

	it("continue après une page en erreur, la signale et sort en 2", async () => {
		const file = join(dir, "erreur.txt");
		const json = join(dir, "erreur.json");
		await writeFile(file, `# test\n${base}/\n${base}/boucle\n\n${base}/inexistante\n${base}/a-propos\n`);
		const t0 = Date.now();
		const { code, stdout, stderr } = await run("audit", "--echantillon", file, "--json", json, "--timeout", "4000");
		expect(code).toBe(2);
		expect(Date.now() - t0).toBeLessThan(40_000);
		expect(stderr).toContain(`Erreur sur ${base}/boucle : audit interrompu après 4000 ms`);
		expect(stderr).toContain(`Erreur sur ${base}/inexistante : HTTP 404 pour ${base}/inexistante`);
		expect(stdout).toContain("Synthèse de l’échantillon : 2 pages auditées, 2 en erreur");
		expect(stdout).toContain(`2 pages en erreur, non auditées :\n  - ${base}/boucle\n  - ${base}/inexistante`);
		const { pages }: AuditReport = JSON.parse(await readFile(json, "utf8"));
		expect(pages.map((p) => [p.url, p.error === null])).toEqual([
			[`${base}/`, true],
			[`${base}/boucle`, false],
			[`${base}/inexistante`, false],
			[`${base}/a-propos`, true],
		]);
		expect(pages[3]?.title).toBe("Page du mini-site");
	});

	it("refuse un échantillon mêlant deux origines, sans rien auditer", async () => {
		const file = join(dir, "origines.txt");
		await writeFile(file, `${base}/\nhttps://autre.example/\n`);
		const { code, stderr, stdout } = await run("audit", "--echantillon", file);
		expect(code).toBe(2);
		expect(stderr).toContain("ligne 2 : https://autre.example/ n’est pas sur la même origine");
		expect(stdout).toBe("");
	});

	it("n'écrase jamais un fichier et vérifie les dossiers de sortie avant de charger quoi que ce soit", async () => {
		const file = join(dir, "court.txt");
		await writeFile(file, `${base}/a-propos\n`);
		const cases = [
			[["audit", "--echantillon", file, "--json", file], "--json désigne le fichier d’échantillon lui-même"],
			[["audit", "--echantillon", file, "--json", file.replace("court", "./court")], "--json désigne le fichier"],
			[["audit", "--echantillon", file, "--json", join(dir, "absent", "r.json")], "n’existe pas (--json)"],
			[["audit", `${base}/a-propos`, "--json", file], "existe déjà (--json)"],
			[["echantillon", `${base}/`, "--sortie", join(dir, "absent", "e.txt")], "n’existe pas (--sortie)"],
		] as const;
		for (const [args, message] of cases) {
			const { code, stdout, stderr } = await run(...args);
			expect(code, args.join(" ")).toBe(2);
			expect(stderr).toContain(message);
			expect(stdout).toBe("");
		}
		expect(await readFile(file, "utf8")).toBe(`${base}/a-propos\n`);
	});
});
