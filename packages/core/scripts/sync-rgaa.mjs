// Synchronise le référentiel RGAA depuis la source officielle DINUM (ADR-0007, ADR-0009).
// Usage : node scripts/sync-rgaa.mjs [ref|sha] [version RGAA] [--if-changed]
//   ref          : défaut "main", résolu en SHA complet pour que l'import soit rejouable à l'identique.
//   version      : obligatoire si le commit change (le JSON officiel ne la contient pas),
//                  sauf avec --if-changed où celle de source.json est reprise (à confirmer en PR).
//   --if-changed : n'écrit rien si les trois JSON sont identiques octet pour octet à ceux du dépôt.
// Sous GitHub Actions, écrit changed=true|false, sha et previous dans $GITHUB_OUTPUT.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repository = "DISIC/accessibilite.numerique.gouv.fr";
const files = ["criteres.json", "methodologies.json", "glossaire.json"];
const outDir = new URL("../data/rgaa/", import.meta.url);
const sourceFile = new URL("source.json", outDir);

/** Vrai si chaque fichier téléchargé est identique octet pour octet au fichier local (null = absent). */
export function isUnchanged(downloaded, current) {
	return downloaded.length === current.length && downloaded.every((buf, i) => current[i]?.equals(buf) === true);
}

async function get(url, headers) {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`${url} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

async function main() {
	const headers = { "User-Agent": "rampe-sync-rgaa" };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

	const args = process.argv.slice(2);
	const ifChanged = args.includes("--if-changed");
	const [ref = "main", versionArg] = args.filter((a) => a !== "--if-changed");

	const { sha } = JSON.parse(
		await get(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, headers),
	);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`SHA inattendu : ${sha}`);

	const current = JSON.parse(await readFile(sourceFile, "utf8").catch(() => "{}"));
	const report = async (changed) => {
		if (!process.env.GITHUB_OUTPUT) return;
		await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nsha=${sha}\nprevious=${current.commit ?? ""}\n`);
	};

	// Même commit : rien à réécrire (pas de diff parasite sur importedAt).
	if (sha === current.commit) {
		console.log(`Déjà à jour (${repository}@${sha}).`);
		return report(false);
	}
	const rgaaVersion = versionArg ?? (ifChanged ? current.rgaaVersion : undefined);
	if (!rgaaVersion) throw new Error(`Nouveau commit ${sha} : préciser la version du RGAA en 2e argument (ex. 4.1.2).`);

	// Tout télécharger et valider en mémoire avant d'écrire quoi que ce soit.
	const contents = await Promise.all(
		files.map((file) => get(`https://raw.githubusercontent.com/${repository}/${sha}/RGAA/${file}`, headers)),
	);
	const parsed = contents.map((buf, i) => {
		try {
			return JSON.parse(buf.toString("utf8"));
		} catch (err) {
			throw new Error(`${files[i]} n'est pas du JSON valide : ${err.message}`);
		}
	});

	if (ifChanged) {
		const local = await Promise.all(files.map((file) => readFile(new URL(file, outDir)).catch(() => null)));
		if (isUnchanged(contents, local)) {
			console.log(`Référentiel inchangé (${repository}@${sha}).`);
			return report(false);
		}
	}

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
	await report(true);
}

// Exécuté seulement en ligne de commande : l'import (tests) ne déclenche aucun appel réseau.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
