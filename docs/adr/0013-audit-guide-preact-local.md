---
title: "ADR-0013 — Audit guidé : un îlot Preact, un modèle d’audit pur dans @rampe/core, sauvegarde locale"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La phase 3 est le cœur du produit (ADR-0002) : 79 critères n’ont aucune vérification automatique directe, et les 27 autres demandent un jugement humain. L’utilisateur doit pouvoir parcourir les 106 critères, pour chaque page de son échantillon, et attribuer un statut à chacun. C’est la première interface **interactive** du site, qui jusqu’ici ne contient aucun JavaScript côté client.

La méthode RGAA (`src/obligations/evaluation-conformite.md`) définit les statuts et les règles de calcul :
- par page, un critère est **conforme**, **non conforme** ou **non applicable** ;
- un critère est validé pour l’échantillon s’il l’est sur **toutes** les pages ;
- il est applicable s’il l’est sur **au moins une** page ;
- dans un processus, un critère n’est validé sur une page que s’il l’est sur **toutes** les pages du processus.

## Décision

1. **Modèle d’audit pur dans `@rampe/core`** (`audit-session.ts`), sans dépendance et entièrement testé :
   - session `{ schemaVersion, site, createdAt, updatedAt, pages: [{ id, url, title, process? }], evaluations: { [critère]: { [pageId]: { status: "C" | "NC" | "NA" | "NT", note } } } }`. `NT` signifie « non testé » : c’est l’état initial, jamais confondu avec « conforme » ;
   - opérations pures : créer une session, ajouter ou retirer une page, fixer un statut, calculer l’avancement.
   - Le calcul du taux de conformité (tâche suivante) et l’import des résultats automatiques viendront s’y greffer. Ils restent hors du périmètre de cette tâche.
2. **Interface** : une page `/audit/` du site, avec **un seul îlot Preact** (`@astrojs/preact` 6.0.6, Preact 10.29.8 : ce sont les versions compatibles, et elles respectent le délai de 7 jours).
   - Le reste du site reste sans JavaScript.
   - Le texte officiel affiché réutilise le rendu assaini existant (ADR-0010), produit **au build** et transmis à l’îlot comme données. Aucun Markdown ou HTML n’est rendu dans le navigateur.
3. **Parcours** : par thématique puis par critère, avec le texte officiel, les tests, la méthodologie, l’explication Rampe et le lien vers la fiche. Pour chaque page de l’échantillon : un statut et une note. On peut filtrer (non testés, non conformes) et l’avancement est visible.
4. **Persistance locale** (ADR-0005) : sauvegarde automatique dans `localStorage`. Toute lecture ou écriture est protégée, car le stockage peut être absent, plein ou refusé. Dans ce cas, l’utilisateur est **prévenu** que son travail ne sera pas conservé. Aucune donnée ne quitte le navigateur. L’export et l’import en fichier JSON sont une tâche distincte.
5. **Accessibilité de l’interface** (c’est un outil d’accessibilité) :
   - contrôles natifs : boutons radio groupés dans un `fieldset` avec `legend` pour les statuts, `textarea` étiquetée pour la note ;
   - pas de composant ARIA maison quand un élément HTML natif suffit ;
   - gestion du focus lors des changements de critère ;
   - annonces de sauvegarde et de filtrage par une région `aria-live` sobre ;
   - contrôle axe en clair et en sombre, plus une vérification au clavier.

## Conséquences

- Le site embarque désormais du JavaScript, mais uniquement sur `/audit/`.
- Le modèle de session devient un **format d’échange** : l’export, l’import et les futures versions passeront par `schemaVersion` et une validation stricte à l’import (frontière de confiance, tâche « export / import »).
- Preact 11 est écarté tant que `@astrojs/preact` ne le supporte pas.
