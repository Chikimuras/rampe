// Changements de langue (critère RGAA 8.7) : des mots anglais du texte reçoivent `lang="en"`, au rendu.
// Règle (consignée au journal du 20 octobre 2026, délégation ADR-0001), d'après les notes du critère 8.7 :
//   a) mot du dictionnaire de l'Académie française (note 1 : « le dictionnaire de référence est celui de l'Académie
//      française ») : pas de `lang` ;
//   b) mot passé dans le langage commun, présent dans un dictionnaire d'usage (Larousse, Robert) : pas de `lang`, sauf
//      risque d'incompréhension (note 2, exemple officiel : « newsletter ») ;
//   c) jargon technique ou mot absent des dictionnaires d'usage : `lang` exigé. SEULS ces mots figurent dans les listes ;
//   d) nom propre, nom d'outil, titre d'œuvre, identifiant ou code : exempté.
// Listes FERMÉES : un mot absent n'est jamais deviné. Seuls les nœuds texte sont touchés, jamais le contenu de
// <code>, <pre>, etc., ni un passage déjà marqué par un `lang`, ni un attribut, ni le texte d'un lien qui est une URL.
// Analyse : satteri, déjà utilisé par render.ts (aucune dépendance de plus).
import type { Element, ElementContent, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { htmlToHast } from "satteri";

/**
 * Jargon technique anglais des pages du cockpit (ADR, journal, documentation), cas (c). Pluriel en -s reconnu.
 * Hors liste : cas (a) et (b) (squash, job, focus, bug, cookie, e-mail, proxy, plugin, widget…) et (d) (titres
 * d'œuvres comme les OWASP Cheat Sheets).
 */
export const TECH_TERMS = [
	"backend",
	"bidi",
	"build",
	"check",
	"checkout",
	"commit",
	"cron",
	"diff",
	"dogfooding",
	"fixture",
	"force-push",
	"fork",
	"fuzzer",
	"fuzzing",
	"gate",
	"golden",
	"headless",
	"hook",
	"incomplete",
	"lint",
	"merge",
	"monorepo",
	"overlay",
	"push",
	"roadmap",
	"run",
	"runner",
	"shell",
	"token",
	"typecheck",
	"workflow",
	"workspace",
	"worktree",
];

/**
 * Mots anglais des intitulés et définitions officiels du RGAA, cas (c). Le texte officiel n'est pas modifié (ADR-0010) :
 * `lang` est un balisage, ajouté autour des mots tels quels.
 * Hors liste : cas (a) et (b) (focus, pop-up, e-mail, plugin, widget, newsletter, bitmap…), et (d) : noms propres et
 * d'outils (Ace by DAISY, PAC, W3C Nu markup checker, Word Accessibility Plug-in), identifiants (`submit`, `click`…),
 * titres d'œuvres (notes et techniques du W3C, vidéo citée).
 */
export const OFFICIAL_TERMS = ["all frames", "field name", "landmark", "pop-under", "style switcher"];

const SKIP = new Set(["code", "kbd", "pre", "samp", "script", "style", "var"]);

/** Expression des termes : mots entiers, casse ignorée, pluriel en -s. Plus longs d'abord (« force-push » > « push »). */
export function termsPattern(terms: readonly string[]): RegExp {
	const alts = [...terms]
		.sort((a, b) => b.length - a.length)
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	// Un mot collé à une lettre, un chiffre, un trait d'union ou pris dans un chemin (`a/build`, `x.commit`, `lint.config`)
	// n'est pas un mot entier ; un point final de phrase, si.
	return new RegExp(`(?<![\\p{L}\\p{N}_\\-/.@#])(?:${alts})s?(?![\\p{L}\\p{N}_\\-/@]|\\.[\\p{L}\\p{N}])`, "giu");
}

const text = (n: ElementContent): string =>
	n.type === "text" ? n.value : n.type === "element" ? n.children.map(text).join("") : "";

/** Entoure de <span lang="en"> chaque terme des nœuds texte de `node` (modifie l'arbre). */
export function markEnglish(node: Root | Element, pattern: RegExp): void {
	node.children = (node.children as ElementContent[]).flatMap((child): ElementContent[] => {
		if (child.type === "element") {
			const isUrlLink = child.tagName === "a" && /^\s*https?:\/\//i.test(text(child));
			if (!SKIP.has(child.tagName) && child.properties.lang === undefined && !isUrlLink) markEnglish(child, pattern);
			return [child];
		}
		if (child.type !== "text") return [child];
		const out: ElementContent[] = [];
		let last = 0;
		for (const m of child.value.matchAll(pattern)) {
			if (m.index > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
			out.push({
				type: "element",
				tagName: "span",
				properties: { lang: "en" },
				children: [{ type: "text", value: m[0] }],
			});
			last = m.index + m[0].length;
		}
		if (out.length === 0) return [child];
		if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
		return out;
	});
}

/** Fragment HTML → même fragment, termes anglais balisés. */
export function markEnglishHtml(html: string, terms: readonly string[]): string {
	const tree = htmlToHast(html, { fragment: true }) as Root;
	markEnglish(tree, termsPattern(terms));
	return toHtml(tree);
}

/** Texte brut (ex. intitulé) → HTML échappé, termes anglais balisés. */
export function markEnglishText(value: string, terms: readonly string[]): string {
	const tree: Root = { type: "root", children: [{ type: "text", value }] };
	markEnglish(tree, termsPattern(terms));
	return toHtml(tree);
}
