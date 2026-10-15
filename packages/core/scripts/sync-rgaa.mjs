// Synchronise le référentiel RGAA depuis la source officielle DINUM (ADR-0007).
// Usage : node scripts/sync-rgaa.mjs [ref|sha] [version RGAA]
//   ref     : défaut "main", résolu en SHA complet pour que l'import soit rejouable à l'identique.
//   version : obligatoire si le commit change (le JSON officiel ne la contient pas).
import { readFile, writeFile } from "node:fs/promises";

const repository = "DISIC/accessibilite.numerique.gouv.fr";
const files = ["criteres.json", "methodologies.json", "glossaire.json"];
const outDir = new URL("../data/rgaa/", import.meta.url);
const sourceFile = new URL("source.json", outDir);

const headers = { "User-Agent": "rampe-sync-rgaa" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function get(url) {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`${url} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

const [ref = "main", rgaaVersion] = process.argv.slice(2);
const { sha } = JSON.parse(await get(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`));
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA inattendu : ${sha}`);

// Même commit : rien à réécrire (pas de diff parasite sur importedAt).
const current = JSON.parse(await readFile(sourceFile, "utf8").catch(() => "{}"));
if (sha === current.commit) {
	console.log(`Déjà à jour (${repository}@${sha}).`);
	process.exit(0);
}
if (!rgaaVersion) throw new Error(`Nouveau commit ${sha} : préciser la version du RGAA en 2e argument (ex. 4.1.2).`);

// Tout télécharger et valider en mémoire avant d'écrire quoi que ce soit.
const contents = await Promise.all(
	files.map((file) => get(`https://raw.githubusercontent.com/${repository}/${sha}/RGAA/${file}`)),
);
const parsed = contents.map((buf, i) => {
	try {
		return JSON.parse(buf.toString("utf8"));
	} catch (err) {
		throw new Error(`${files[i]} n'est pas du JSON valide : ${err.message}`);
	}
});

// Copie octet pour octet ; source.json en dernier.
for (const [i, file] of files.entries()) await writeFile(new URL(file, outDir), contents[i]);
const source = {
	repository: `https://github.com/${repository}`,
	commit: sha,
	rgaaVersion,
	wcagVersion: String(parsed[0].wcag.version),
	importedAt: new Date().toISOString().slice(0, 10),
	license: "Licence Ouverte 2.0",
};
await writeFile(sourceFile, `${JSON.stringify(source, null, "\t")}\n`);
console.log(`RGAA ${rgaaVersion} importé depuis ${repository}@${sha}`);
