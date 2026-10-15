---
title: "ADR-0004 — Site statique Astro sur GitHub Pages ; la doc vit dans docs/"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Il faut un site public dès le premier jour (le cockpit de suivi), puis le produit. Le budget est de 0 €.

## Décision

- **Astro** en sortie statique. Le contenu Markdown est natif (collections typées), et on n’embarque du JS que là où c’est interactif (îlots). C’est utile pour un outil qui doit lui-même être accessible et léger.
- Hébergement **GitHub Pages**, déployé par la CI à chaque push sur `main`. URL : `https://chikimuras.github.io/rampe/`.
- La documentation (ADR, journal, vision, roadmap) vit en Markdown dans `docs/` à la racine. Le cockpit n’en est qu’une **vue** : la source de vérité reste lisible directement sur GitHub.
- L’avancement affiché est **calculé** à partir des cases de `docs/roadmap.md`, jamais saisi à la main ailleurs.

## Conséquences

- Pas de backend possible sur Pages. Quand il en faudra un (scanner hébergé, phase 5), un nouvel ADR tranchera.
- Pas de domaine personnalisé tant qu’aucune dépense n’est validée.
