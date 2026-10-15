---
title: "ADR-0006 — Gates de vérification et flux de merge"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Rien n’est « terminé » parce que Claude l’affirme. Il faut des vérifications exécutées par le système, pas par le modèle.

## Décision

1. **Gate local** : le hook Claude Code `Stop` lance `.claude/gate.sh`, qui exécute `pnpm check` (Biome, typecheck, tests). En cas d’échec, Claude ne peut pas rendre la main.
2. **Gate final** : le workflow GitHub Actions `CI` (même `pnpm check`, plus le build) est un **check requis** sur `main`.
3. **Flux** : tout passe par une PR. Merge *squash* seulement si la CI est verte. Pas de push direct sur `main` (une fois la protection activée).
4. **Sécurité de la CI** :
   - actions tierces **épinglées par SHA** et installation `--frozen-lockfile` (OWASP Top 10 CI/CD Security Risks, **CICD-SEC-3** *Dependency Chain Abuse*) ;
   - permissions `GITHUB_TOKEN` minimales par défaut (`contents: read`), élargies seulement pour le job de déploiement (**CICD-SEC-5** *Insufficient PBAC*) ;
   - `persist-credentials: false` au checkout (**CICD-SEC-6** *Insufficient Credential Hygiene*) ;
   - check requis et protection de branche (**CICD-SEC-1** *Insufficient Flow Control Mechanisms*).

## Conséquences

- Le premier commit est poussé directement sur `main` (il n’existe pas encore de branche à protéger). Tous les suivants passent par une PR.
- Mettre à jour une action demande de changer son SHA. Dependabot s’en chargera (à ajouter en phase 1).
