import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://chikimuras.github.io",
	base: "/rampe",
	// Un seul îlot, sur /audit/ (ADR-0013 §2) : le reste du site reste sans JavaScript.
	integrations: [preact()],
});
