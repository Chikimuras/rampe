// Rampe audite Rampe (ADR-0021 §1) : gate CI, lancé par `pnpm audit:rampe`.
// 1. construit le site en production dans un dossier temporaire ;
// 2. le sert sur 127.0.0.1, port libre, sous la base /rampe (404 ailleurs) ;
// 3. lance la VRAIE CLI `rampe audit --echantillon … --strict` en trois passages :
//    - toutes les pages construites (chaque index.html du build, triées), thème clair ;
//    - les mêmes, thème sombre ;
//    - l'échantillon méthodologique versionné (docs/audit-rampe/echantillon.txt), fenêtre étroite (375 px) ;
// 4. sort en 0 si les trois passages sont à 0, sinon avec le code le plus grave (2 > 1).
// --strict : un résultat « incertain » ou « à vérifier » fait aussi échouer le gate. Aucune liste d'exceptions.
//
// L'échantillon versionné contient les adresses de production (https://chikimuras.github.io/rampe/…) : il reste
// lisible et réutilisable tel quel contre le site publié. La CLI n'accepte que des adresses absolues, donc ce script
// en écrit une copie temporaire où ce seul préfixe est remplacé par l'origine locale. Toute autre adresse est refusée
// (code 2) : le gate n'audite jamais autre chose que le build qu'il vient de produire.
//
// Rapports : dossier `RAMPE_RAPPORTS` (défaut : audit-rampe-rapports/, ignoré par git), un JSON et un HTML par
// passage, retirés avant l'audit puisque la CLI n'écrase jamais un fichier.
//
// `pnpm audit:rampe --servir` construit et sert le site sans l'auditer (Ctrl+C pour arrêter), par exemple pour
// régénérer l'échantillon avec `rampe echantillon`.
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const serveOnly = process.argv.includes("--servir");
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};

const t0 = Date.now();
// realpath : sous macOS, le dossier temporaire est un lien symbolique (/var → /private/var).
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "rampe-audit-")));
const out = join(tmp, "dist");

/** Résout un chemin d'URL dans le build, liens symboliques compris ; null s'il en sort ou n'existe pas. */
function resolveFile(path) {
	try {
		let file = realpathSync(normalize(join(out, path.slice(BASE.length))));
		if (file !== out && !file.startsWith(out + sep)) return null;
		if (!extname(file)) file = realpathSync(join(file, "index.html"));
		return file.startsWith(out + sep) ? file : null;
	} catch {
		return null;
	}
}

/** Chemins de toutes les pages construites (`<dossier>/index.html`), triés. */
function builtPages(dir = out, prefix = "") {
	const pages = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) pages.push(...builtPages(join(dir, entry.name), `${prefix}${entry.name}/`));
		else if (entry.name === "index.html") pages.push(prefix);
	}
	return pages.sort();
}

/** Lance la CLI ; code 2 si elle ne démarre pas ou meurt sur un signal. */
function runCli(args) {
	return new Promise((ok) => {
		const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`La CLI n’a pas pu être lancée : ${error.message}`);
			ok(2);
		});
		child.on("exit", (code) => ok(code ?? 2));
	});
}

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
		const file = path.startsWith(BASE) ? resolveFile(path) : null;
		if (!file) return res.writeHead(404).end();
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	const local = `http://127.0.0.1:${server.address().port}${BASE}`;

	// Garde-fou contre un autre serveur sur ce port (plusieurs agents en parallèle) : on vérifie le titre servi.
	const accueil = await (await fetch(local)).text();
	if (!accueil.includes("<title>Accueil · Rampe</title>")) throw new Error(`${local} ne sert pas le site de Rampe`);

	if (serveOnly) {
		console.log(`Site servi sur ${local} (Ctrl+C pour arrêter)`);
		await new Promise((ok) => process.once("SIGINT", ok));
		code = 0;
	} else code = await audit(local);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
} finally {
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
	console.log(`Durée totale : ${Math.round((Date.now() - t0) / 1000)} s`);
}
process.exit(code);

/** Les trois passages de la CLI sur le site servi à `local` ; renvoie le code le plus grave. */
async function audit(local) {
	const pages = builtPages();
	// Le cockpit annonce « 0 non-conformité automatique sur les N pages » : N doit être le nombre réellement audité.
	const claim = `0 non-conformité automatique sur les ${pages.length} pages`;
	if (!readFileSync(join(out, "cockpit/index.html"), "utf8").includes(claim))
		throw new Error(`Le cockpit n’annonce pas « ${claim} » : corrigez le décompte dans cockpit/index.astro.`);
	const toutes = join(tmp, "toutes.txt");
	writeFileSync(
		toutes,
		`# Toutes les pages du build (${pages.length}), générées par scripts/audit-rampe.mjs\n${pages.map((p) => local + p).join("\n")}\n`,
	);

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
	const passes = [
		{ name: "toutes-clair", file: toutes, args: ["--theme", "clair"], expected: pages.length },
		{ name: "toutes-sombre", file: toutes, args: ["--theme", "sombre"], expected: pages.length },
		{ name: "echantillon-375px", file: copie, args: ["--largeur", "375"] },
	];
	const written = [];
	let code = 0;
	for (const pass of passes) {
		const json = join(rapports, `${pass.name}.json`);
		const html = join(rapports, `${pass.name}.html`);
		rmSync(json, { force: true });
		rmSync(html, { force: true });
		console.log(`\n##### Passage « ${pass.name} » #####`);
		if (pass.expected !== undefined)
			console.log("Toutes les pages sont auditées : l’avertissement sur le tirage « hasard » ne s’applique pas ici.");
		let c = await runCli([
			"audit",
			"--echantillon",
			pass.file,
			"--strict",
			...pass.args,
			"--json",
			json,
			"--html",
			html,
		]);
		for (const f of [json, html]) if (existsSync(f)) written.push(f);
		// Le gate ne peut pas passer en auditant moins de pages qu'il n'en a construit.
		if (pass.expected !== undefined) {
			const audited = existsSync(json)
				? JSON.parse(readFileSync(json, "utf8")).pages.filter((p) => p.error === null).length
				: 0;
			if (audited < pass.expected) {
				console.error(`Passage « ${pass.name} » : ${audited} pages auditées sur ${pass.expected} construites.`);
				c = 2;
			}
		}
		code = Math.max(code, c);
	}
	console.log(`\nAudit de Rampe : ${pages.length} pages construites, code ${code}.`);
	if (written.length > 0) console.log(`Rapports :\n  ${written.join("\n  ")}`);
	return code;
}
