// Synchronise le référentiel RGAA depuis la source officielle DINUM (ADR-0007).
// Usage : node scripts/sync-rgaa.mjs [ref|sha]   (défaut : HEAD de main)
import { writeFile } from "node:fs/promises";

const repository = "DISIC/accessibilite.numerique.gouv.fr";
const files = ["criteres.json", "methodologies.json", "glossaire.json"];
const outDir = new URL("../data/rgaa/", import.meta.url);

async function get(url) {
	const res = await fetch(url, { headers: { "User-Agent": "rampe-sync-rgaa" } });
	if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
	return res.text();
}

// Résout la ref en SHA complet pour que l'import soit rejouable à l'identique.
const ref = process.argv[2] ?? "main";
const { sha } = JSON.parse(await get(`https://api.github.com/repos/${repository}/commits/${ref}`));

for (const file of files) {
	const text = await get(`https://raw.githubusercontent.com/${repository}/${sha}/RGAA/${file}`);
	JSON.parse(text); // échoue si le contenu n'est pas du JSON valide
	await writeFile(new URL(file, outDir), text); // copie telle quelle, octet pour octet
}

const source = {
	repository: `https://github.com/${repository}`,
	commit: sha,
	rgaaVersion: "4.1.2",
	wcagVersion: "2.1",
	importedAt: new Date().toISOString().slice(0, 10),
	license: "Licence Ouverte 2.0",
};
await writeFile(new URL("source.json", outDir), `${JSON.stringify(source, null, "\t")}\n`);
console.log(`RGAA importé depuis ${repository}@${sha}`);
