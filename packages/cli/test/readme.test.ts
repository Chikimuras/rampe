// Les commandes d'installation du navigateur des README citent la version exacte de Playwright de la CLI (ADR-0025 §4).
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("README : version de Playwright", () => {
	for (const readme of ["../../../README.md", "../README.md"])
		it(`${readme} cite playwright@${pkg.dependencies.playwright}`, async () => {
			const text = await readFile(new URL(readme, import.meta.url), "utf8");
			const versions = [...text.matchAll(/playwright@([^\s`]+)/g)].map((m) => m[1]);
			expect(versions.length).toBeGreaterThan(0);
			expect(new Set(versions)).toEqual(new Set([pkg.dependencies.playwright]));
		});
});
