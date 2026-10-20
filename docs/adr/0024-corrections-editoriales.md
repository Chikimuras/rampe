---
title: "ADR-0024 — Un ADR accepté peut recevoir des corrections éditoriales d’accessibilité ou de langue, jamais un changement de décision"
status: Accepted
date: 2026-10-20
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

L’ADR-0001 pose qu’un ADR accepté n’est jamais réécrit : on le remplace par un nouveau. Cette règle protège l’histoire des décisions.

Le site de Rampe doit lui-même être conforme au RGAA. Or l’auto-évaluation a relevé, au critère 8.7 (changements de langue), des mots anglais dans le titre et le texte d’ADR acceptés. Le titre d’un ADR devient le `<title>` de sa page, et **le texte du `<title>` ne peut pas porter de `lang`** : la seule correction possible est de reformuler ce titre en français. Remplacer un ADR par un nouveau pour une simple question de langue multiplierait les décisions sans en changer aucune.

## Décision

1. **Une seule exception à l’ADR-0001** : le titre et le texte d’un ADR accepté peuvent recevoir des corrections **purement éditoriales** d’accessibilité ou de langue (critère RGAA 8.7 notamment) : traduire un mot anglais, réécrire une forme francisée, reformuler un titre en français.
2. Une telle correction **ne change jamais la décision**, ni son contexte, ni ses conséquences. Le nom du fichier et l’identifiant de l’ADR restent les mêmes.
3. Toute autre modification d’un ADR accepté reste interdite : elle passe par un nouvel ADR, comme le veut l’ADR-0001.
4. **Traçabilité** : les PR sont fusionnées en *squash* (ADR-0006). Le commit de fusion de la PR qui porte une telle correction nomme l’ADR-0024, et l’entrée du journal du jour la consigne.

## Conséquences

- Sont corrigés dans ce cadre (branche `fix/rgaa-dernieres-nc`) : les titres d’ADR-0003, 0005, 0006 et 0021, le texte d’ADR-0009 et 0023 (formes francisées), et celui d’ADR-0019 (« même cheat sheet » devient « même fiche OWASP »).
- L’ADR-0001 renvoie vers cette exception.
- Un relecteur vérifie que chaque correction de ce type reste éditoriale ; au moindre doute sur le sens, c’est un nouvel ADR.
