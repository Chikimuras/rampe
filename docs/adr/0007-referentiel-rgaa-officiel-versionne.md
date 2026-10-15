---
title: "ADR-0007 — Le référentiel RGAA est une copie versionnée de la source officielle DINUM"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Tout Rampe repose sur le référentiel RGAA : les critères, les tests, les méthodologies et le glossaire. La DINUM le publie en JSON dans `DISIC/accessibilite.numerique.gouv.fr` :
- `RGAA/*.json` contient la version en vigueur, le **RGAA 4.1.2** (publiée le 18/04/2023, basée sur WCAG 2.1) ;
- `RGAA/4.1/` n’est qu’une archive.

Le contenu est sous Licence Ouverte 2.0.

## Décision

1. Les trois fichiers officiels (`criteres.json`, `methodologies.json`, `glossaire.json`) sont **copiés tels quels** dans `packages/core/data/rgaa/`, avec un `source.json` qui indique le dépôt, le **SHA du commit** source (`ca4019f95073b6cbd2482a16e9f12b52d8de678d`), la version du RGAA et la date d’import.
2. On ne modifie jamais ces fichiers à la main. Un script (`pnpm --filter @rampe/core sync-rgaa`) les remplace depuis un commit donné, ce qui permet de rejouer l’import et de lire les écarts dans un diff.
3. `packages/core` expose un **modèle normalisé et typé** construit à partir de ces fichiers : thématiques, critères `"1.1"`, tests `"1.1.1"` avec leur méthodologie, références WCAG analysées (`{ sc: "1.1.1", level: "A" }`), glossaire indexé par ancre. Le reste du code ne lit jamais le JSON brut.
4. Des tests verrouillent les invariants du référentiel : 13 thématiques, 106 critères, identifiants uniques, chaque test a une méthodologie, chaque lien de glossaire mène à une entrée.

## Conséquences

- On fonctionne hors ligne et de façon reproductible : le build ne dépend pas de GitHub.
- Une mise à jour officielle devient une PR lisible, puis automatique en phase 1 (cron).
- Si la DINUM change le format, ce sont les tests qui casseront, pas la production.

## Alternatives écartées

- **Récupérer le référentiel au moment du build** : le build ne serait pas reproductible et dépendrait du réseau.
- **Ressaisir ou réécrire les critères** : risque d’erreur, et on perdrait la traçabilité avec le texte officiel.
