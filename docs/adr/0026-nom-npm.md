---
title: "ADR-0026 — La CLI est publiée sur npm sous le nom « @chikimuras/rampe »"
status: Accepted
date: 2026-10-22
deciders: "Claude (délégation, ADR-0001), nom choisi par Alexandre"
---

## Contexte

L’ADR-0025 publiait la CLI sous le nom sans portée `rampe`. Lors de la première publication, le registre l’a refusé : « Package name too similar to existing packages ramda, tape » (HTTP 403). C’est la protection de npm contre l’usurpation de noms proches ; elle n’est pas documentée précisément, et un autre nom sans portée pourrait être refusé de la même façon. Les noms à portée n’y sont pas soumis. Rien n’avait été publié.

## Décision

1. Le paquet est publié sous **`@chikimuras/rampe`**, la portée du compte npm d’Alexandre, qui l’a choisie parmi : `@chikimuras/rampe` (immédiat), `@rampe/cli` (organisation npm à créer, disponibilité du nom non vérifiable) et `rampe-rgaa` (même risque de refus).
2. **La commande installée reste `rampe`** : seul le nom du paquet change (`npx @chikimuras/rampe audit …`, ou `npm i -g @chikimuras/rampe` puis `rampe audit …`).
3. Le reste de l’ADR-0025 est inchangé : un seul fichier, publication par la CI sans jeton stocké, environnement `npm`, étiquettes `v*` protégées. L’archive produite par `npm pack` s’appelle désormais `chikimuras-rampe-<version>.tgz`.

## Conséquences

- Remplace le point 1 de l’ADR-0025 (nom publié) ; l’ADR-0025 n’est pas réécrit (ADR-0001).
- `pnpm --filter rampe …` devient `pnpm --filter @chikimuras/rampe …` ; `pnpm rampe …` depuis la racine ne change pas.
- Le nom du paquet est lié au compte d’Alexandre ; passer plus tard à une organisation demanderait un nouveau paquet et la dépréciation de celui-ci.
