---
title: "ADR-0025 — La CLI est publiée sur npm sous le nom « rampe », en un seul fichier JavaScript, depuis la CI sans secret"
status: Accepted
date: 2026-10-20
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La CLI (ADR-0011) n’est utilisable que depuis le dépôt. Son binaire est `src/cli.ts`, exécuté tel quel par Node grâce à la suppression native des types : **Node refuse cette suppression pour un fichier situé dans `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, vérifié avec Node 22.21). Publiée telle quelle, la CLI planterait dès son installation. Elle dépend aussi de `@rampe/core`, paquet interne non publié.

Alexandre a un compte npm. Les noms `rampe`, `@rampe/cli` et `@rampe/core` sont libres sur le registre (2026-10-20).

## Décision

1. **Nom publié : `rampe`**, sans portée. `npx rampe audit https://…` se lit et se retient, et aucune organisation npm n’est à créer. Le paquet de l’espace de travail `@rampe/cli` est renommé `rampe` ; la racine du dépôt, privée, prend un autre nom pour éviter le doublon.
2. **Un seul fichier JavaScript** (`dist/rampe.mjs`), produit par rolldown, déjà présent dans le verrou des dépendances (outil de Vite) : ajouté en dépendance de développement à la version verrouillée, il n’ajoute aucun paquet téléchargé. `@rampe/core` y est intégré : il n’est pas publié, et reste un détail interne. `playwright` et `axe-core` restent des dépendances, à version exacte (ADR-0011, ADR-0020).
3. **Contenu publié minimal** : `dist/`, `README.md`, `LICENSE`, vérifié par un test sur la liste de `npm pack`. Un test installe l’archive produite dans un dossier vierge et audite une page de test : c’est le paquet réel qui est testé, pas les sources.
4. **Navigateur manquant** : si Chromium n’est pas installé, la CLI sort en 2 en affichant la commande exacte à lancer, à la version de Playwright utilisée.
5. **Publication depuis la CI, sans jeton stocké** : un workflow déclenché par une étiquette `v<version>` publie avec le *Trusted Publishing* de npm (identité OIDC de GitHub Actions) et une attestation de provenance. Il vérifie que l’étiquette correspond à la version du paquet et que le gate complet passe avant de publier. Deux jobs : la construction et les tests tournent sans `id-token` ; seul le job de publication, qui ne fait que `npm publish` de l’archive construite, reçoit `id-token: write`. Ce job s’exécute dans l’environnement GitHub `npm`, limité aux étiquettes `v*`, et cet environnement est exigé par l’éditeur de confiance déclaré sur npm. Une règle du dépôt réserve la création, la modification et la suppression des étiquettes `v*` aux administrateurs (Alexandre). Actions épinglées par SHA (ADR-0006).
6. **Première publication** : faite par Alexandre depuis sa machine (`npm login`, puis une commande documentée), si npm n’accepte pas de déclarer l’éditeur de confiance d’un paquet qui n’existe pas encore. Les suivantes passent par la CI.

## Sources (sécurité)

- OWASP Top 10 CI/CD Security Risks, **CICD-SEC-6 Insufficient Credential Hygiene** : pas de jeton npm de longue durée dans les secrets du dépôt ; l’identité est un jeton OIDC éphémère.
- OWASP Top 10 CI/CD Security Risks, **CICD-SEC-9 Improper Artifact Integrity Validation** : attestation de provenance liant le paquet au commit et au workflow qui l’ont produit.
- OWASP Top 10 CI/CD Security Risks, **CICD-SEC-5 Insufficient PBAC** et GitHub, *Security hardening with OpenID Connect* : `id-token` accordé au seul job qui publie.
- OWASP Top 10 CI/CD Security Risks, **CICD-SEC-3 Dependency Chain Abuse** : aucun script d’installation de dépendance ne tourne avec le droit de publier.
- OWASP Top 10 CI/CD Security Risks, **CICD-SEC-1 Insufficient Flow Control** et **CICD-SEC-4 Poisoned Pipeline Execution** : sans environnement ni protection des étiquettes, quiconque peut écrire dans le dépôt pourrait étiqueter une branche au workflow modifié et publier.

## Conséquences

- Les commandes `pnpm --filter @rampe/cli …` deviennent `pnpm --filter rampe …` (documentation, scripts, CI).
- Le binaire du dépôt reste exécutable sans build pour le développement ; seul le paquet publié passe par `dist/`.
- Publier une version = changer la version dans `packages/cli/package.json` par PR, puis poser l’étiquette `v<version>` sur `main`.
- Écarté : publier `@rampe/core` à part (deux paquets à maintenir et à déclarer, sans usage public prévu) ; compiler avec `tsc` (ne résout pas la dépendance interne) ; un jeton npm en secret (CICD-SEC-6).
- Le point 1 (nom publié) est remplacé par l’ADR-0026 : npm a refusé le nom `rampe`. Renvoi ajouté au titre des corrections éditoriales (ADR-0024).
