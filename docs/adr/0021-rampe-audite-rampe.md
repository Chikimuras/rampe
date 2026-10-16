---
title: "ADR-0021 — Rampe audite Rampe : un gate CI automatique, puis une auto-évaluation complète clairement étiquetée"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La phase 6 vise à ce que le site de Rampe atteigne 100 % de conformité RGAA, audité par Rampe lui-même. Un outil d’accessibilité inaccessible se discréditerait. Mais 100 % ne se proclame pas : 79 critères n’ont aucune vérification automatique directe (ADR-0015), et un taux exige que **tous** les critères soient évalués par un humain. Rampe est construit par une IA. Une évaluation menée par une IA n’est pas un audit humain certifié, et doit le dire. Enfin, publier une déclaration d’accessibilité pour Rampe engage son éditeur, Alexandre.

## Décision

1. **Gate automatique en CI**, sur chaque PR et chaque push sur `main` (`pnpm audit:rampe`, `scripts/audit-rampe.mjs`) :
   - le site est construit en production puis servi localement (port libre, base `/rampe`) ;
   - la vraie CLI et le vrai Chromium l’auditent, en **`--strict`** : un résultat « rattachement incertain » ou « à vérifier » fait échouer le gate comme une non-conformité. Il n’y a **aucune liste d’exceptions**. Trois passages :
     - **toutes les pages construites** (chaque `index.html` du build, liste générée à chaque exécution), en thème **clair** ;
     - les mêmes, en thème **sombre** (`prefers-color-scheme: dark`) ;
     - l’**échantillon méthodologique** en fenêtre **étroite** (375 px) ;
   - le gate échoue aussi si une page construite n’a pas été auditée, ou si une page de l’échantillon est en erreur ;
   - l’échantillon est un fichier versionné (`docs/audit-rampe/echantillon.txt`), construit par `rampe echantillon` puis complété à la main selon la méthode (ADR-0012). Il n’est **pas régénéré en CI**. Ses adresses sont celles de production, réécrites vers le build local, et toute autre adresse est refusée. Il sert aussi de périmètre à l’auto-évaluation (§2) ;
   - les rapports JSON et HTML de chaque passage sont conservés comme artefacts ;
   - le gate ne voit que les pages **telles qu’elles se chargent**. Les états interactifs de l’audit guidé (pages ajoutées, import, déclaration, plan) sont couverts par les tests de bout en bout du site, qui y lancent axe en clair, en sombre et en 375 px.
2. **Auto-évaluation complète, étape distincte** : un agent évaluateur parcourt les 106 critères sur chaque page de l’échantillon, en suivant les tests et méthodologies officiels. Il consigne pour chaque évaluation sa justification dans la note.
   - La session est versionnée (`docs/audit-rampe/session.json`, format de l’ADR-0016) et le taux est calculé par `@rampe/core` (ADR-0015).
   - Le cockpit affiche le résultat avec la mention **« Auto-évaluation réalisée par une IA (Claude), non certifiée : elle ne remplace pas un audit humain. »**
   - Chaque non-conformité trouvée est corrigée par PR, jusqu’à 100 %.
3. **Publication de la déclaration d’accessibilité de Rampe : ⛔ Alexandre.** Elle engage l’éditeur, et va de pair avec les mentions légales. Rampe en prépare le brouillon avec son propre générateur (ADR-0017), mais ne la publie pas.

## Conséquences

- Toute régression d’accessibilité détectable automatiquement est bloquée avant le merge, sur le site de Rampe lui-même.
- Le « 100 % » éventuel sera affiché honnêtement, comme une auto-évaluation et non comme une certification.
