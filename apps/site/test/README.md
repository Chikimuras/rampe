# Tests de bout en bout du site

`audit.e2e.test.ts` construit le site (`astro build` vers un dossier temporaire), le sert sur un port libre et le pilote dans Chromium.

Limite connue : deux builds lancés en même temps depuis le même dossier (deux agents, ou `pnpm check` et `pnpm build` en parallèle) partagent `apps/site/.astro/` et le dossier de prérendu d’Astro, et peuvent se gêner. Lancez-les l’un après l’autre.
