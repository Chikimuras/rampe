// Pages fixes du plan du site (critère RGAA 12.1), tirées des sources de src/pages : aucune liste à la main.

/** Rubriques du plan, dans l'ordre. Un dossier de pages absent d'ici fait échouer le build : à classer d'abord. */
export const SECTIONS = { "": "Rampe", referentiel: "Référentiel", audit: "Audit guidé", cockpit: "Cockpit" } as const;
export type Section = keyof typeof SECTIONS;

export interface FixedPage {
	path: string;
	title: string;
	section: Section;
}

/** Rubrique d’une source (`./referentiel/glossaire.astro`) : son dossier ; une page hors dossier appartient à « Rampe ». */
export function sectionOf(file: string): Section {
	const parts = file.replace(/^\.\//, "").split("/");
	if (parts.length === 1) return "";
	const head = parts[0] ?? "";
	if (Object.hasOwn(SECTIONS, head)) return head as Section;
	throw new Error(`plan du site : rubrique inconnue pour ${file}, à ajouter dans lib/sitemap.ts`);
}

/**
 * Sources `./chemin.astro` → pages fixes, triées par chemin. Ignore les routes à paramètre (`[id]`) et la page 404
 * (servie pour une adresse inconnue : ce n'est pas une page du site). Le titre est celui du `<Base title="…">`.
 */
export function fixedPages(sources: Record<string, string>): FixedPage[] {
	return Object.entries(sources)
		.filter(([file]) => !file.includes("[") && !/(^|\/)404\.astro$/.test(file))
		.map(([file, source]) => {
			const title = source.match(/<Base\s[^>]*?\btitle="([^"]+)"/)?.[1];
			if (!title) throw new Error(`plan du site : ${file} n’a pas de <Base title="…"> littéral`);
			const path = file
				.replace(/^\.\//, "")
				.replace(/(^|\/)index\.astro$/, "$1")
				.replace(/\.astro$/, "/");
			return { path, title, section: sectionOf(file) };
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}
