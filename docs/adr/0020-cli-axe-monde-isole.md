---
title: "ADR-0020 — La CLI exécute axe-core dans un monde isolé : une page ne peut pas falsifier son propre audit"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La relecture de l’extension (PR #21) a établi un défaut de la CLI déjà en production. La CLI (ADR-0011) injecte axe-core et l’exécute dans le **monde principal** de la page (`page.evaluate`). Une page hostile, ou simplement une page qui modifie des objets globaux, peut donc :
- redéfinir `window.axe` ;
- altérer `Element.prototype.getAttribute`, `getComputedStyle`, `Array.prototype.filter` ou `JSON.stringify`.

Elle fait alors afficher « Aucune non-conformité », avec le code de sortie 0. La preuve a été exécutée. Pour un outil d’audit, c’est une atteinte à l’**intégrité du résultat**. L’extension n’est pas concernée : `chrome.scripting` s’exécute dans un monde isolé.

## Décision

1. La CLI exécute axe-core dans un **monde isolé**, créé par CDP (`Page.createIsolatedWorld` sur le cadre principal, puis `Runtime.evaluate` avec son `contextId`). Le DOM y est partagé, mais **pas les objets JavaScript globaux de la page**. C’est le même modèle que les scripts de contenu des extensions.
   Cela vaut pour **toute lecture de la page par la CLI**, pas seulement pour axe : la collecte des liens, de la navigation principale et du formulaire de recherche de `rampe echantillon` (ADR-0012) passe par le même mécanisme, avec une seule implémentation.
2. Le résultat est sérialisé **dans le monde isolé** (`JSON.stringify` du monde isolé, pas celui de la page). Il est relu côté Node puis validé avant usage.
3. **Test de non-régression** : une page piège redéfinit `window.axe` et casse les prototypes cités. Elle doit produire les mêmes non-conformités qu’une page saine équivalente, et le même code de sortie. Le test doit **échouer** sur l’ancien code (preuve par mutation).
   De même, un accueil piège falsifie `querySelectorAll`, `getAttribute` et d’autres primitives pour cacher la page « accessibilité » et injecter un faux lien. Il doit produire le même échantillon que l’accueil sain équivalent.
4. Chromium reste la seule cible de la CLI : CDP est donc toujours disponible.

## Conséquences

- Le résultat d’audit de la CLI, comme l’échantillon qu’elle propose, ne dépend plus de la bonne foi des scripts de la page.
- Une page peut toujours modifier son **DOM** de façon dynamique : axe juge alors ce que la page affiche vraiment, ce qui est correct.
