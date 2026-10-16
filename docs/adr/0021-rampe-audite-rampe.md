---
title: "ADR-0021 — Rampe audite Rampe : un gate CI automatique, puis une auto-évaluation complète clairement étiquetée"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La phase 6 vise à ce que le site de Rampe atteigne 100 % de conformité RGAA, audité par Rampe lui-même. Un outil d’accessibilité inaccessible se discréditerait. Mais 100 % ne se proclame pas : 79 critères n’ont aucune vérification automatique directe (ADR-0015), et un taux exige que **tous** les critères soient évalués par un humain. Rampe est construit par une IA. Une évaluation menée par une IA n’est pas un audit humain certifié, et doit le dire. Enfin, publier une déclaration d’accessibilité pour Rampe engage son éditeur, Alexandre.

## Décision

1. **Gate automatique en CI**, sur chaque PR et chaque push sur `main` :
   - le site est construit puis servi localement ;
   - `rampe echantillon` puis `rampe audit --echantillon` tournent dessus, avec la vraie CLI et le vrai Chromium ;
   - l’échantillon est un fichier versionné (`docs/audit-rampe/echantillon.txt`), construit par la commande puis complété à la main selon la méthode (ADR-0012), par exemple l’audit guidé, la déclaration, le référentiel et une fiche de critère ;
   - **toute non-conformité automatique fait échouer la CI**, avec le code de sortie 1 de la CLI ;
   - les rapports JSON et HTML sont conservés comme artefacts.
2. **Auto-évaluation complète, étape distincte** : un agent évaluateur parcourt les 106 critères sur chaque page de l’échantillon, en suivant les tests et méthodologies officiels. Il consigne pour chaque évaluation sa justification dans la note.
   - La session est versionnée (`docs/audit-rampe/session.json`, format de l’ADR-0016) et le taux est calculé par `@rampe/core` (ADR-0015).
   - Le cockpit affiche le résultat avec la mention **« Auto-évaluation réalisée par une IA (Claude), non certifiée : elle ne remplace pas un audit humain. »**
   - Chaque non-conformité trouvée est corrigée par PR, jusqu’à 100 %.
3. **Publication de la déclaration d’accessibilité de Rampe : ⛔ Alexandre.** Elle engage l’éditeur, et va de pair avec les mentions légales. Rampe en prépare le brouillon avec son propre générateur (ADR-0017), mais ne la publie pas.

## Conséquences

- Toute régression d’accessibilité détectable automatiquement est bloquée avant le merge, sur le site de Rampe lui-même.
- Le « 100 % » éventuel sera affiché honnêtement, comme une auto-évaluation et non comme une certification.
