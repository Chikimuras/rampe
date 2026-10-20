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

- Le proxy **rtk** de la machine d’Alexandre réécrit `pnpm lint` en `eslint`, ce qui casse la commande ici (le repo utilise Biome). En session Claude, lancer `rtk proxy pnpm check`. La CI et le hook Stop ne sont pas concernés. Même chose pour Biome : `rtk proxy npx biome check --write`.
- Serveurs locaux de test : toujours un **port libre attribué dynamiquement**, et vérifier le titre de la page servie (plusieurs agents tournent en parallèle).
- Le proxy rtk réécrit aussi `grep` en `rg` (syntaxe d’expressions différente) : `rtk proxy grep` si besoin.
- Mutations temporaires d’un fichier pour éprouver un test : chemins ABSOLUS et restauration par `git checkout -- <fichier>` (arbre propre au préalable).
- Arrêter un processus de test **par son PID uniquement**, jamais `pkill -f <motif>` : plusieurs agents peuvent servir le site ou lancer des tests en parallèle, et un motif peut toucher le processus d’un autre.
- Attendre la CI d’un commit : filtrer sur le **workflow `CI`** (`gh run list --workflow ci.yml`), pas sur n’importe quel run du même commit : des runs Dependabot portent le même SHA et se terminent plus tôt.
- `cp` et `rm` sont des alias interactifs sur la machine : utiliser `command cp` / `command rm`.

## Conventions

- Doc, UI et commentaires en français ; identifiants de code en anglais.
- Le cockpit est une vue de `docs/` : on n’écrit jamais l’état du projet ailleurs.
- Le site de Rampe doit lui-même être conforme RGAA.
