---
title: "ADR-0020 — axe-core dans un monde isolé, sans messagerie vers les iframes : une page ne peut pas falsifier son propre audit"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La relecture de l’extension (PR #21) a établi un défaut de la CLI déjà en production. La CLI (ADR-0011) injecte axe-core et l’exécute dans le **monde principal** de la page (`page.evaluate`). Une page hostile, ou simplement une page qui modifie des objets globaux, peut donc :
- redéfinir `window.axe` ;
- altérer `Element.prototype.getAttribute`, `getComputedStyle`, `Array.prototype.filter` ou `JSON.stringify`.

Elle fait alors afficher « Aucune non-conformité », avec le code de sortie 0. La preuve a été exécutée. Pour un outil d’audit, c’est une atteinte à l’**intégrité du résultat**. L’extension s’exécute déjà dans un monde isolé (`chrome.scripting`).

La relecture de la PR #22 a établi un second canal, commun à la CLI et à l’extension : la **messagerie `postMessage`** d’axe. Avec son option par défaut `iframes: true`, axe interroge chaque iframe par `postMessage` et fait confiance aux réponses. Une page hostile répond depuis une iframe de même origine (`source: "axeAPI.4.14.0"`, `channelId` recopié). Elle fait alors passer toutes ses non-conformités en « à vérifier » (code 0, « Aucune non-conformité »), ou en ajoute de fausses. La preuve a été exécutée avec la vraie CLI. Le monde isolé ne protège pas de ce canal, puisque le message vient d’un autre cadre.

## Décision

1. La CLI exécute axe-core dans un **monde isolé**, créé par CDP (`Page.createIsolatedWorld` sur le cadre principal, puis `Runtime.evaluate` avec son `contextId`). Le DOM y est partagé, mais **pas les objets JavaScript globaux de la page**. C’est le même modèle que les scripts de contenu des extensions.
   Cela vaut pour **toute lecture de la page par la CLI**, pas seulement pour axe : la collecte des liens, de la navigation principale et du formulaire de recherche de `rampe echantillon` (ADR-0012) passe par le même mécanisme, avec une seule implémentation.
2. Le résultat est sérialisé **dans le monde isolé** (`JSON.stringify` du monde isolé, pas celui de la page). Il est relu côté Node puis validé avant usage.
3. **Test de non-régression** : une page piège redéfinit `window.axe` et casse les prototypes cités. Elle doit produire les mêmes non-conformités qu’une page saine équivalente, et le même code de sortie. Le test doit **échouer** sur l’ancien code (preuve par mutation).
   De même, un accueil piège falsifie `querySelectorAll`, `getAttribute` et d’autres primitives pour cacher la page « accessibilité » et injecter un faux lien. Il doit produire le même échantillon que l’accueil sain équivalent.
4. axe est lancé avec **`iframes: false`**, dans la CLI **et** dans l’extension, par une seule constante partagée (`AXE_RUN_OPTIONS` dans `@rampe/core`). C’est cohérent avec le périmètre : Rampe n’analyse pas les iframes (cadre principal seulement), donc toute réponse d’un cadre serait forgée. La règle `frame-tested` reste signalée (« à vérifier ») : la personne qui audite sait qu’il reste des cadres à examiner. Test : deux pages pièges (`ifr-null`, `ifr-fake`) donnent exactement le résultat d’une page témoin à iframe muette, en CLI (code 1) comme dans l’extension. Le test échoue sans l’option (preuve par mutation).
5. Chromium reste la seule cible de la CLI : CDP est donc toujours disponible. Si la page navigue pendant l’évaluation, le monde isolé est détruit : l’audit s’arrête avec « La page a navigué pendant l’analyse : audit impossible. » (code 2). Le titre de la page est lu dans la même évaluation que l’analyse.

## Conséquences

- Ni les objets JavaScript de la page, ni ses réponses par `postMessage` ne peuvent plus fausser le résultat d’audit de la CLI et de l’extension, ou l’échantillon que propose la CLI. Les limites ci-dessous restent.
- Une page peut toujours modifier son **DOM** de façon dynamique : axe juge alors ce que la page affiche vraiment, ce qui est correct.

## Limites connues

- **Masquage par détection d’automatisation.** Une page peut détecter le navigateur automatisé (`navigator.webdriver`, agent utilisateur « Headless ») et se corriger pour lui seul. Elle affiche alors un DOM sans défaut à la CLI. C’est indétectable par un audit automatique : seul l’audit humain, dans un navigateur ordinaire, le révèle. L’extension, lancée dans le navigateur de la personne, y est moins exposée.
- **Shadow DOM fermé.** Le contenu d’un Shadow DOM en mode `closed` est invisible pour axe, qu’il s’exécute dans un monde isolé ou non : il n’est pas analysé.
- **Iframes.** Leur contenu n’est pas analysé (décision 4) : `frame-tested` le signale.
