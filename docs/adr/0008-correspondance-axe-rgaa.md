---
title: "ADR-0008 — Rattacher les résultats axe-core au RGAA via les étiquettes RGAA natives d’axe, WCAG en repli"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Le moteur d’audit automatique sera **axe-core** (Deque, licence MPL-2.0), la référence open source. Il faut rattacher chacun de ses résultats à un critère RGAA. Le plan initial était de déduire ce rattachement en passant par WCAG (règle axe → critère WCAG → critères RGAA). Ce détour est imprécis : un même critère WCAG correspond souvent à plusieurs critères RGAA.

Vérification faite sur axe-core 4.14.0 : les règles portent des **étiquettes RGAA natives au niveau du test** (`RGAAv4`, `RGAA-1.1.2`, `RGAA-7.1.1`…). Elles couvrent 67 règles sur 105 et sont maintenues par Deque.

## Décision

Une fonction **pure** de `@rampe/core` classe une règle à partir de ses étiquettes (celles qu’axe fournit avec chaque résultat). On ne crée aucune table maintenue à la main. Trois niveaux de rattachement, du plus précis au moins précis :

1. **`rgaa`** : la règle porte des étiquettes `RGAA-x.y.z`. Elle est rattachée à ces **tests** RGAA, donc à leurs critères.
2. **`wcag`** : pas d’étiquette RGAA, mais des étiquettes WCAG (`wcag111`…). La règle est rattachée aux critères RGAA qui référencent ces critères WCAG dans le référentiel officiel (ADR-0007). C’est marqué comme *indirect*.
3. **`hors-rgaa`** : aucun rattachement RGAA possible (bonnes pratiques d’axe sans étiquette, ou critères WCAG absents du RGAA 4.1.2 comme 2.5.8). On les affiche à part, sans jamais les compter dans la conformité.

Le niveau qualifie la précision du rattachement, pas la certitude du défaut ; les règles bonnes-pratiques/expérimentales sont signalées par des drapeaux.

Des tests vérifient, sur **toutes** les règles de la version d’axe installée, que chaque étiquette RGAA désigne un test qui existe dans le référentiel et que chaque règle tombe dans exactement un niveau. Une montée de version d’axe qui introduirait une étiquette inconnue fera donc échouer la CI.

## Conséquences

- `@rampe/core` reste sans dépendance à l’exécution. axe-core n’y est qu’une dépendance de développement, pour les tests.
- La précision suit les mises à jour d’axe sans maintenance de notre côté.
- Conformément à l’ADR-0002, le niveau de rattachement sera affiché à l’utilisateur : un rattachement *indirect* demande plus de vérification humaine.

## Alternatives écartées

- **Une table règle → critère écrite à la main** : maintenance permanente, et risque de diverger d’axe.
- **Le seul passage par WCAG** : trop imprécis alors qu’une information plus fine existe.
