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
- [ ] Correspondance règles axe-core → critères RGAA, testée
- [ ] Synchronisation automatique (cron CI) qui ouvre une PR si le référentiel officiel change
- [ ] Référentiel consultable sur le site, en langage simple

## Phase 2 — Audit automatisé (CLI)

- [ ] `rampe audit <url>` : Playwright + axe-core, résultats par critère RGAA
- [ ] Échantillon de pages (pages types exigées par la méthode RGAA)
- [ ] Rapport HTML lisible par un non-expert + export JSON
- [ ] Publication npm ⛔ compte npm (gratuit) à créer par Alexandre

## Phase 3 — Audit guidé (web)

- [ ] Parcours critère par critère pour les tests manuels
- [ ] Import des résultats automatiques
- [ ] Taux de conformité selon la méthode RGAA
- [ ] Données 100 % locales, export / import JSON

## Phase 4 — Livrables légaux

- [ ] Générateur de déclaration d’accessibilité
- [ ] Générateur de schéma pluriannuel

## Phase 5 — Audit sans installation

- [ ] Scanner hébergé ⛔ compte Cloudflare (gratuit) à créer par Alexandre
- [ ] Extension Firefox (gratuit) — Chrome : 5 $ ⛔ dépense à valider

## Phase 6 — Lancement

- [ ] Le site de Rampe atteint 100 % de conformité RGAA, audité par Rampe
- [ ] Mentions légales ⛔ l’éditeur est Alexandre
