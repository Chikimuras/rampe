---
title: "ADR-0002 — Rampe accompagne vers la conformité, sans jamais la certifier ni modifier le site audité"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Les tests automatiques ne savent juger qu’une minorité des critères RGAA : la pertinence d’une alternative textuelle, la cohérence d’un parcours ou la compréhension d’un contenu demandent un humain. Le marché propose des « overlays » qui promettent une conformité automatique en injectant un script. La communauté du handicap les rejette (cf. *Overlay Fact Sheet*, overlayfactsheet.com) et ils n’apportent pas la conformité.

## Décision

1. Rampe **ne délivre aucun score de conformité sans audit manuel**. Un résultat purement automatique est présenté comme « problèmes détectés », jamais comme un taux de conformité.
2. Chaque résultat automatique indique s’il est **certain** (non-conformité avérée) ou **à vérifier**.
3. Rampe **ne modifie jamais** le site audité et ne propose aucun script à injecter.
4. L’interface rappelle, à chaque rapport, ce que l’automatique ne couvre pas.

## Conséquences

- Le produit est moins « magique » que la concurrence, mais il est honnête. C’est la seule position défendable pour un document légal comme la déclaration d’accessibilité.
- L’audit guidé (phase 3) devient le cœur du produit, pas un accessoire.
