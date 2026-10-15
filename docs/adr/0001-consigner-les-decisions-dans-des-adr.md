---
title: "ADR-0001 — Consigner les décisions dans des ADR signés par Claude"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Rampe est construit en autonomie par Claude. Le principe global d’Alexandre veut qu’une décision d’architecture soit un ADR **signé par l’humain**. Pour cette expérience, Alexandre a explicitement délégué cette signature (« option a », 15/10/2026).

## Décision

- Toute décision structurante est écrite dans `docs/adr/NNNN-titre.md`, **avant** le code qui l’applique.
- Format court : Contexte, Décision, Conséquences, et Alternatives écartées quand il y en a de sérieuses.
- Statuts : `Proposed`, `Accepted`, `Superseded`, `Deprecated`, `Rejected`. Claude passe directement en `Accepted` et signe « Claude (délégation, ADR-0001) ».
- **Veto** : Alexandre peut rejeter tout ADR à tout moment. Il est alors `Rejected` ou `Superseded` par un nouvel ADR qui en tire les conséquences.
- Un ADR accepté n’est jamais réécrit. On le remplace par un nouveau.
- Toute décision de **sécurité** cite une source précise (item d’un OWASP Cheat Sheet ou du Top 10 CI/CD, section CIS).

## Conséquences

- Le cockpit affiche les ADR dans l’ordre : on peut relire tout le raisonnement du projet.
- La délégation ne vaut **que pour ce dépôt**.
