---
title: "ADR-0022 — Une session d’audit dit qui l’a évaluée : une évaluation par IA ne peut jamais passer pour un audit humain"
status: Accepted
date: 2026-10-17
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

L’auto-évaluation de Rampe (ADR-0021 §2) est réalisée par une IA. Les fragments portent `evaluator: "Claude (IA)"`, mais la session construite enregistre chaque évaluation avec `source: "humain"`, la seule source qui permette un taux (ADR-0014, ADR-0015).

La relecture de la PR #24 l’a prouvé : une fois cette session importée dans l’audit guidé, **le taux, puis la déclaration d’accessibilité générée, se lisent comme ceux d’un audit humain**. Le texte produit est « L’audit de conformité réalisé […] révèle que : 0 % des critères RGAA sont respectés », sans aucune mention d’IA. Cela contredit l’ADR-0002 §1 et l’ADR-0021 §2.

## Décision

1. **Attribution au niveau de la session** : nouveau champ facultatif `evaluatedBy: { kind: "ia", name: string, certified: false }`, avec `schemaVersion` 5. Les sessions v1 à v4 sont migrées sans perte, sans attribution. La protection « version future » reste en place. La validation suit l’ADR-0016 : stricte à l’import, tolérante à la relecture du stockage. Les sources `auto` et `humain` des évaluations gardent le sens de l’ADR-0014.
2. **La construction de l’auto-évaluation** pose `evaluatedBy: { kind: "ia", name: "Claude", certified: false }`.
3. **Partout où le résultat apparaît, l’attribution apparaît** :
   - un bandeau permanent dans l’audit guidé : « Cet audit a été réalisé par une IA (Claude). Il n’est pas certifié et ne remplace pas un audit humain. » ;
   - la section « Résultat » ;
   - l’aperçu et les exports de la déclaration. Le passage « réalisé [en interne / par la société NNN] » est rempli par « par une IA (Claude), auto-évaluation non certifiée » et n’est **pas modifiable** tant que l’attribution existe ;
   - l’export de la session, qui la conserve.
4. **Reprise par un humain** : l’utilisateur peut retirer l’attribution **seulement par une action explicite**, avec un bouton « Je reprends cet audit à mon compte ». Une confirmation rappelle qu’il endosse alors chaque évaluation, et l’action est réversible par « Annuler ». Modifier une évaluation ne retire pas l’attribution.

## Conséquences

- Une évaluation par IA ne peut plus être confondue avec un audit humain, ni à l’écran, ni dans un document publié.
- L’ADR-0021 §2 s’appuie désormais sur cette attribution. Le cockpit conserve sa mention propre.
