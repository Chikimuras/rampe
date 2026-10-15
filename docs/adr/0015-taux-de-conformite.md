---
title: "ADR-0015 — Taux de conformité : la formule officielle, et rien tant que l’audit n’est pas complet"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La méthode officielle (dépôt DINUM, `src/obligations/evaluation-conformite.md`, sections « Test des pages » et « Taux de conformité à la norme ») définit :
- **par page** : le nombre de critères validés et non validés, et le **taux de conformité de la page** ;
- **dans un processus**, un critère n’est validé pour une page que s’il est validé pour **toutes** les pages du processus ;
- **critère validé** (échantillon) : validé sur toutes les pages ; invalidé sur une seule page, il n’est pas validé ;
- **critère applicable** (échantillon) : applicable sur au moins une page ; non applicable seulement s’il l’est sur **toutes** les pages ;
- **pourcentage de critères respectés** = critères validés ÷ critères applicables ;
- **taux moyen** = moyenne des taux de conformité de chaque page.

C’est le premier chiffre de conformité que Rampe affichera. L’ADR-0002 interdit tout score qui ne repose pas sur un audit humain complet.

## Décision

1. **Calcul pur dans `@rampe/core`** (`conformity.ts`), qui suit la méthode à la lettre et dont chaque règle est testée :
   - par page, en tenant compte de la règle des processus : critères validés, non validés et non applicables ; taux de la page = validés ÷ (validés + non validés) ;
   - pour l’échantillon : critères validés, non validés et non applicables ; **taux global** = validés ÷ applicables ; **taux moyen** = moyenne des taux des pages qui ont au moins un critère applicable. Une page où tout est non applicable n’a pas de taux et n’entre pas dans la moyenne ; ce choix d’interprétation est documenté ;
   - aucun arrondi dans le calcul. L’affichage arrondit à **deux décimales, vers le bas** : un taux de 99,996 % ne devient jamais « 100 % ».
2. **Pas de taux tant que l’audit n’est pas complet.** S’il reste une évaluation « Non testé » ou une non-conformité automatique « à confirmer » (ADR-0014), aucun pourcentage n’est affiché. L’interface indique à la place « Audit incomplet : N évaluations restantes, M statuts à confirmer », avec des liens vers les critères concernés.
3. **Pas de taux sans échantillon minimal** : au moins une page.
4. **Affichage** : les deux taux, avec leur définition officielle en une phrase et la source citée ; le détail par page et par critère (validé, non validé, non applicable). Le taux n’est pas présenté comme une certification. Le niveau de conformité de la déclaration (« totalement », « partiellement », « non conforme ») relève de la phase 4 et n’est pas affiché ici.
5. Les processus se déclarent dans l’interface en attribuant un même nom de processus à plusieurs pages (champ `process` existant du modèle).

## Conséquences

- Rampe affiche enfin un chiffre, mais seulement quand il a un sens.
- Deux interprétations sont tranchées et documentées : la page « tout non applicable » exclue de la moyenne, et l’arrondi vers le bas. Une évolution de la méthode officielle demandera un nouvel ADR.
