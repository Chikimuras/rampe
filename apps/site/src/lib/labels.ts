// Libellés français des données de docs/ (le frontmatter, lui, reste en anglais : format des ADR, ADR-0001).

/** Statut d'ADR affiché (critère 8.7 : pas de mot anglais courant sans `lang`). */
export const ADR_STATUS = {
	Proposed: "Proposée",
	Accepted: "Acceptée",
	Superseded: "Remplacée",
	Deprecated: "Dépréciée",
	Rejected: "Rejetée",
} as const;

/** Date en toutes lettres : « 15 octobre 2026 ». UTC : les dates du frontmatter sont des jours, sans heure. */
export const frDate = (d: Date) =>
	d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Titre d'une entrée du journal, pour `<title>` et `<h1>` (critères 8.6 et 9.1) : la date d'abord. */
export const journalTitle = (entry: { data: { title: string; date: Date } }) =>
	`Journal du ${frDate(entry.data.date)} — ${entry.data.title}`;
