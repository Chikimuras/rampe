import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Toute la doc vit dans /docs à la racine du repo : le cockpit n'en est qu'une vue.
const docs = (dir: string) => glob({ pattern: "*.md", base: `../../docs/${dir}` });

export const collections = {
	adr: defineCollection({
		loader: docs("adr"),
		schema: z.object({
			title: z.string(),
			status: z.enum(["Proposed", "Accepted", "Superseded", "Deprecated", "Rejected"]),
			date: z.coerce.date(),
			deciders: z.string(),
			supersededBy: z.string().optional(),
		}),
	}),
	journal: defineCollection({
		loader: docs("journal"),
		schema: z.object({ title: z.string(), date: z.coerce.date() }),
	}),
	docs: defineCollection({
		loader: docs(""),
		schema: z.object({ title: z.string(), order: z.number() }),
	}),
};
