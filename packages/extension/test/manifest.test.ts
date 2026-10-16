// Manifeste (ADR-0019 §1 à §3) : moindre privilège, aucune permission d'hôte, CSP stricte, rien de chargé à distance.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));
const popup = readFileSync(new URL("../src/popup.html", import.meta.url), "utf8");

describe("manifest.json", () => {
	it("Manifest V3, version du paquet", () => {
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.version).toBe(pkg.version);
	});

	it("permissions EXACTEMENT activeTab et scripting ; aucun hôte, aucun script permanent, aucun fond", () => {
		expect(manifest.permissions).toEqual(["activeTab", "scripting"]);
		for (const key of [
			"host_permissions",
			"optional_permissions",
			"optional_host_permissions",
			"content_scripts",
			"background",
			"web_accessible_resources",
			"externally_connectable",
		])
			expect(manifest, key).not.toHaveProperty(key);
		expect(Object.keys(manifest).sort()).toEqual(
			[
				"action",
				"browser_specific_settings",
				"content_security_policy",
				"description",
				"manifest_version",
				"name",
				"permissions",
				"version",
			].sort(),
		);
	});

	it("CSP des pages d'extension : scripts de l'extension seulement, aucun objet, aucune connexion", () => {
		const csp = new Map<string, string>(
			manifest.content_security_policy.extension_pages
				.split(";")
				.map((d: string) => d.trim().split(/\s+/))
				.map(([name, ...values]: string[]) => [name, values.join(" ")]),
		);
		expect(csp.get("script-src")).toBe("'self'");
		expect(csp.get("object-src")).toBe("'none'");
		// default-src 'none' couvre connect-src : aucune requête possible depuis le panneau.
		expect(csp.get("default-src")).toBe("'none'");
		expect(csp.has("connect-src")).toBe(false);
		expect(manifest.content_security_policy.extension_pages).not.toMatch(/unsafe|https?:|\*/);
	});

	it("Firefox : identifiant factice et aucune collecte de données déclarée", () => {
		expect(manifest.browser_specific_settings.gecko.id).toMatch(/@rampe\.invalid$/);
		expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ["none"] });
	});

	it("panneau en français, sans script en ligne ni ressource distante", () => {
		expect(popup).toMatch(/<html lang="fr">/);
		expect(popup).not.toMatch(/<script>|<script(?![^>]*\bsrc=)[^>]*>|https?:\/\//);
	});
});
