// Rendu du texte officiel du RGAA (Markdown des critères, HTML du glossaire), exécuté au build uniquement.
// La source est épinglée et relue, mais traitée comme non fiable (ADR-0010 §5) : tout passe par un
// assainissement par liste blanche — OWASP Cross Site Scripting Prevention Cheat Sheet, « HTML Sanitization ».
// Analyse : satteri, déjà embarqué par Astro. Assainissement : hast-util-sanitize (le cœur de rehype-sanitize).
import { getGlossaryEntry } from "@rampe/core";
import type { Element, ElementContent, Nodes, Root } from "hast";
import { type Schema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { htmlToHast, markdownToHast } from "satteri";
import { url } from "./url";

// Exactement ce que le référentiel utilise (inventaire des données 4.1.2) : ni image, ni id, ni style, ni événement.
const schema: Schema = {
	tagNames: ["a", "abbr", "br", "code", "em", "li", "ol", "p", "pre", "span", "strong", "ul"],
	attributes: { a: ["href"], abbr: ["lang", "title"], ol: ["start"], span: ["lang"] },
	protocols: { href: ["http", "https", "mailto"] },
	strip: ["script", "style"],
	clobber: [],
	clobberPrefix: "",
};

type Parent = { children: ElementContent[] };

/** Applique `fn` à chaque lien du sous-arbre ; `fn` renvoie les nœuds qui remplacent le lien. */
function mapLinks(node: Parent, fn: (a: Element) => ElementContent[]): void {
	node.children = node.children.flatMap((child) => {
		if (child.type !== "element") return [child];
		mapLinks(child, fn);
		return child.tagName === "a" ? fn(child) : [child];
	});
}

// Seules formes de lien gardées : ancre, URL absolue http(s), mailto. Les protocoles de hast-util-sanitize
// laissent passer les URL relatives, dont `//hote` et `/\hote` qui sortent du site : on les retire.
const SAFE_HREF = /^(#|https?:\/\/|mailto:)/i;

/** Retire (en gardant leur texte) les liens hors des formes sûres ; `fn` traite ensuite les liens restants. */
function mapSafeLinks(tree: Root, fn: (a: Element, href: string) => ElementContent[] = (a) => [a]): void {
	mapLinks(tree as Parent, (a) => {
		const href = a.properties.href;
		return typeof href === "string" && SAFE_HREF.test(href) ? fn(a, href) : a.children;
	});
}

/** Ancre ciblée par `#…`, `null` si l'encodage est invalide, `undefined` pour un lien qui n'est pas une ancre. */
function anchorOf(href: string): string | null | undefined {
	if (!href.startsWith("#")) return undefined;
	try {
		return decodeURIComponent(href.slice(1));
	} catch {
		return null;
	}
}

/**
 * Markdown d'un titre, test, méthodologie ou note → HTML sûr.
 * Les liens `#ancre` du glossaire pointent vers la page du glossaire ; une ancre inconnue
 * (ex. `#table-descriptions-techniques` en 5.1) ne mène nulle part : le lien est retiré, le texte gardé.
 * `inline` retire le paragraphe englobant (titres, énoncés de tests) ; `stripLinks` ne garde que le texte
 * des liens (titre placé dans un lien, où un lien imbriqué serait invalide).
 */
export function renderMarkdown(markdown: string, { inline = false, stripLinks = false } = {}): string {
	const tree = sanitize(
		markdownToHast(markdown, { features: { rawHtml: true }, position: false }) as Nodes,
		schema,
	) as Root;
	mapSafeLinks(tree, (a, href) => {
		if (stripLinks) return a.children;
		const anchor = anchorOf(href);
		if (anchor === undefined) return [a];
		if (anchor === null || !getGlossaryEntry(anchor)) return a.children;
		a.properties.href = url(`referentiel/glossaire/#${anchor}`);
		return [a];
	});
	const [only] = tree.children;
	if (inline && tree.children.length === 1 && only?.type === "element" && only.tagName === "p")
		return toHtml(only.children);
	return toHtml(tree);
}

/** HTML d'une définition du glossaire → HTML sûr. Ses liens `#ancre` restent internes à la page du glossaire. */
export function renderGlossaryHtml(html: string): string {
	const tree = sanitize(htmlToHast(html, { fragment: true }) as Nodes, schema) as Root;
	mapSafeLinks(tree);
	return toHtml(tree);
}
