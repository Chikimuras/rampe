// Rampe audite Rampe (ADR-0021 §1) : gate CI, lancé par `pnpm audit:rampe`.
// 1. construit le site en production dans un dossier temporaire ;
// 2. le sert sur 127.0.0.1, port libre, sous la base /rampe (404 ailleurs) ;
// 3. lance la VRAIE CLI `rampe audit --echantillon` sur docs/audit-rampe/echantillon.txt ;
// 4. sort avec le code de la CLI : 0 aucune non-conformité, 1 non-conformité détectée, 2 page en erreur.
//
// L'échantillon versionné contient les adresses de production (https://chikimuras.github.io/rampe/…) : il reste
// lisible et réutilisable tel quel contre le site publié. La CLI n'accepte que des adresses absolues, donc ce script
// en écrit une copie temporaire où ce seul préfixe est remplacé par l'origine locale. Toute autre adresse est refusée
// (code 2) : le gate n'audite jamais autre chose que le build qu'il vient de produire.
// Rapports : dossier `RAMPE_RAPPORTS` (défaut : audit-rampe-rapports/, ignoré par git), vidé de ses deux rapports
// avant l'audit puisque la CLI n'écrase jamais un fichier.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROD = "https://chikimuras.github.io/rampe/";
const BASE = "/rampe/";
const root = fileURLToPath(new URL("..", import.meta.url));
const site = join(root, "apps/site");
const cli = join(root, "packages/cli/src/cli.ts");
const echantillon = join(root, "docs/audit-rampe/echantillon.txt");
const rapports = resolve(root, process.env.RAMPE_RAPPORTS ?? "audit-rampe-rapports");
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};

const tmp = mkdtempSync(join(tmpdir(), "rampe-audit-"));
const out = join(tmp, "dist");
let server;
let code = 2;
try {
	// NODE_ENV=production : le build publié, pas celui de développement (JSX de dev, chemins des sources).
	execFileSync(process.execPath, [join(site, "node_modules/astro/bin/astro.mjs"), "build", "--outDir", out], {
		cwd: site,
		env: { ...process.env, NODE_ENV: "production" },
		stdio: ["ignore", "ignore", "inherit"],
	});

	server = createServer((req, res) => {
		let path;
		try {
			path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		} catch {
			return res.writeHead(400).end();
		}
		if (!path.startsWith(BASE)) return res.writeHead(404).end();
		// normalize + préfixe : aucune requête ne sort du dossier de build.
		let file = normalize(join(out, path.slice(BASE.length)));
		if (file !== out && !file.startsWith(out + sep)) return res.writeHead(404).end();
		try {
			if (statSync(file).isDirectory()) file = join(file, "index.html");
			const body = readFileSync(file);
			res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	const local = `http://127.0.0.1:${server.address().port}${BASE}`;

	// Garde-fou contre un autre serveur sur ce port (plusieurs agents en parallèle) : on vérifie le titre servi.
	const accueil = await (await fetch(local)).text();
	if (!accueil.includes("<title>Accueil · Rampe</title>")) throw new Error(`${local} ne sert pas le site de Rampe`);

	const lines = readFileSync(echantillon, "utf8").split("\n");
	const rewritten = lines.map((line, i) => {
		const l = line.trim();
		if (l === "" || l.startsWith("#")) return line;
		if (!l.startsWith(PROD)) throw new Error(`${echantillon}:${i + 1} : adresse hors de ${PROD} : ${l}`);
		return local + l.slice(PROD.length);
	});
	const copie = join(tmp, "echantillon.txt");
	writeFileSync(copie, rewritten.join("\n"));

	mkdirSync(rapports, { recursive: true });
	const json = join(rapports, "rapport.json");
	const html = join(rapports, "rapport.html");
	rmSync(json, { force: true });
	rmSync(html, { force: true });
	// spawn asynchrone : ce processus doit continuer à servir le site pendant que la CLI l'audite.
	const child = spawn(process.execPath, [cli, "audit", "--echantillon", copie, "--json", json, "--html", html], {
		stdio: "inherit",
	});
	code = await new Promise((ok) => child.on("exit", (c) => ok(c ?? 2)));
	console.log(`\nRapports : ${json}, ${html}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
} finally {
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
