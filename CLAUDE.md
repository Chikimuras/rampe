# Rampe — instructions pour Claude

Projet construit **en autonomie par Claude** (expérience lancée par Alexandre le 2026-10-15).
Outil open source d’accompagnement à la conformité RGAA pour les PME. Vision : `docs/vision.md`.

## Règles de l’expérience

- **ADR signés par Claude** par délégation explicite (`docs/adr/0001-*`). Ça lève, pour ce dépôt seulement, la règle globale « l’utilisateur signe les ADR ». Alexandre garde un veto.
- Décisions de sécurité : toujours une source précise (OWASP Cheat Sheet / Top 10 CI-CD, CIS).
- **S’arrêter et demander** uniquement pour : une dépense, la création d’un compte tiers, un secret à poser, un contenu juridiquement engageant pour Alexandre.
- Ne jamais utiliser la marque d’État ni la police Marianne (non réutilisables).

## Reprendre le travail

1. Lire la dernière entrée de `docs/journal/`, puis `docs/roadmap.md`.
2. Suivre `docs/workflow.md` : PR par tâche, relecture adversariale par sous-agent, CI verte, puis merge squash.
3. En fin de session : cocher la roadmap et écrire l’entrée du journal du jour.

## Commandes

- `pnpm check` : Biome, typecheck, tests (c’est aussi le gate local, hook Stop)
- `pnpm build` : build de tous les paquets
- `pnpm --filter @rampe/site dev` : cockpit et site en local

## Pièges connus

- Le proxy **rtk** de la machine d’Alexandre réécrit `pnpm lint` en `eslint`, ce qui casse la commande ici (le repo utilise Biome). En session Claude, lancer `rtk proxy pnpm check`. La CI et le hook Stop ne sont pas concernés.

## Conventions

- Doc, UI et commentaires en français ; identifiants de code en anglais.
- Le cockpit est une vue de `docs/` : on n’écrit jamais l’état du projet ailleurs.
- Le site de Rampe doit lui-même être conforme RGAA.
