---
title: "ADR-0003 — Dépôt unique TypeScript (pnpm) : core, cli, site"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La même logique (référentiel RGAA, correspondance axe → RGAA, calcul du taux) doit servir à trois endroits : la CLI d’audit, le site web, et plus tard le scanner hébergé et l’extension.

## Décision

- Un seul dépôt, workspace **pnpm** :
  - `packages/core` : référentiel, correspondances, calculs. Code pur, sans I/O, très testé.
  - `packages/cli` : audit automatisé (Playwright + axe-core).
  - `apps/site` : le site (produit et cockpit).
- **TypeScript 6**, en mode strict. TypeScript 7 est écarté pour l’instant parce que `@astrojs/check` ne le supporte pas. À réévaluer.
- **Biome** pour le lint et le formatage : un outil au lieu de deux (ESLint + Prettier).
- **Vitest** pour les tests.
- Un paquet n’est créé que lorsqu’il a du code à contenir.

## Alternatives écartées

- **Plusieurs dépôts** : il faudrait synchroniser les versions du cœur entre eux pour rien.
- **Python pour la CLI** : axe-core et Playwright sont nativement JS, et le site l’est aussi. Un seul langage.
