---
title: Roadmap
order: 2
---

Chaque case cochée correspond à du code mergé sur `main` avec la CI verte. Les ⛔ signalent un besoin d’action humaine.

## Phase 0 — Socle et cockpit

- [x] Dépôt, workspace pnpm, Biome, TypeScript
- [x] Cockpit : avancement, journal, ADR, documentation
- [x] Gate local (hook Stop) et CI (lint, typecheck, tests, build)
- [x] Déploiement automatique sur GitHub Pages
- [x] Protection de `main` : merge uniquement par PR avec CI verte

## Phase 1 — Référentiel RGAA

- [x] Import du référentiel officiel (critères, tests, méthodologies, glossaire)
- [x] Correspondance règles axe-core → critères RGAA, testée
- [x] Synchronisation automatique (cron CI) qui ouvre une PR si le référentiel officiel change
- [x] Référentiel consultable sur le site, en langage simple

## Phase 2 — Audit automatisé (CLI)

- [x] `rampe audit <url>` : Playwright + axe-core, résultats par critère RGAA
- [x] Échantillon de pages (pages types exigées par la méthode RGAA)
- [x] Rapport HTML lisible par un non-expert + export JSON
- [ ] Publication npm ⛔ compte npm (gratuit) à créer par Alexandre

## Phase 3 — Audit guidé (web)

- [x] Parcours critère par critère pour les tests manuels
- [x] Import des résultats automatiques
- [x] Taux de conformité selon la méthode RGAA
- [x] Données 100 % locales, export / import JSON

## Phase 4 — Livrables légaux

- [x] Générateur de déclaration d’accessibilité
- [x] Générateur de schéma pluriannuel

## Phase 5 — Audit sans installation

- [ ] Scanner hébergé ⛔ compte Cloudflare (gratuit) à créer par Alexandre
- [x] Extension navigateur (code, testable en local)
- [ ] Publication Firefox ⛔ compte Mozilla (gratuit) à créer par Alexandre
- [ ] Publication Chrome ⛔ 5 $ de frais d’inscription : dépense à valider

## Phase 6 — Lancement

- [ ] Gate CI : Rampe audite Rampe à chaque PR (0 non-conformité automatique)
- [ ] Auto-évaluation complète des 106 critères (IA, étiquetée non certifiée) et corrections jusqu’à 100 %
- [ ] Publication de la déclaration d’accessibilité de Rampe ⛔ engage l’éditeur, Alexandre
- [ ] Mentions légales ⛔ l’éditeur est Alexandre
