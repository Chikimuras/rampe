---
title: "ADR-0009 — Synchro hebdomadaire du référentiel par PR automatique, et Dependabot"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Le référentiel RGAA est une copie épinglée sur un commit (ADR-0007), et axe-core comme les actions GitHub sont épinglés eux aussi (ADR-0006, ADR-0008). Sans automatisation, ces copies vieillissent sans que personne ne le voie.

GitHub pose une contrainte : une PR ouverte avec le `GITHUB_TOKEN` d’un workflow **ne déclenche pas** les workflows `pull_request`. Elle n’aurait donc jamais le check `check`, qui est obligatoire sur `main`, et ne pourrait pas être mergée. Les événements `workflow_dispatch` font exception : ils peuvent être déclenchés par ce token.

## Décision

1. **Workflow `sync-rgaa.yml`**, lancé chaque lundi et à la demande (`workflow_dispatch`, avec un `ref` DINUM facultatif) :
   - il télécharge le référentiel. **Si les trois fichiers JSON sont identiques octet pour octet** à ceux du dépôt, il s’arrête sans rien écrire : les commits DINUM qui ne touchent que leur site ne doivent pas produire de PR ;
   - sinon, il pousse une branche `chore/sync-rgaa-<sha court>` et ouvre une PR. Le corps de la PR indique que **la version du RGAA doit être confirmée par le relecteur** : elle n’est pas déductible des fichiers ;
   - il déclenche ensuite la CI sur cette branche par `workflow_dispatch`. Le check `check` s’attache ainsi au commit de tête et la PR peut se merger normalement.
2. **Dependabot** surveille chaque semaine les dépendances npm et les actions GitHub. Ses PR déclenchent la CI normalement. Une montée d’axe-core qui ajouterait des étiquettes RGAA inconnues ou changerait les décomptes fera donc échouer les tests (ADR-0008) au lieu de passer en silence.
3. **Sécurité** :
   - permissions accordées job par job, au strict nécessaire : `contents: write`, `pull-requests: write`, `actions: write` uniquement pour la synchro (OWASP Top 10 CI/CD, **CICD-SEC-5**) ;
   - aucun secret ni jeton personnel : seul le `GITHUB_TOKEN` éphémère est utilisé (**CICD-SEC-6**) ;
   - le contenu téléchargé n’est **jamais exécuté**. Il est seulement validé comme JSON puis écrit, et ce sont les tests de la CI qui le jugent (**CICD-SEC-4**, *Poisoned Pipeline Execution*) ;
   - la PR n’est jamais mergée automatiquement : elle suit le flux normal (ADR-0006).
4. Le réglage du dépôt « Allow GitHub Actions to create pull requests » est activé. Il ne donne aucun droit de merge, puisque la protection de `main` s’applique toujours.

## Conséquences

- Une mise à jour officielle du RGAA devient une PR testée dans la semaine.
- Nouvelle exigence pour `sync-rgaa.mjs` : un mode « seulement si le contenu change ». Aujourd’hui, le script compare le SHA du commit, qui change même quand le référentiel reste identique.
