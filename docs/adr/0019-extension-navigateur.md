---
title: "ADR-0019 — Extension navigateur : axe-core sur l’onglet courant, permissions minimales, aucune donnée envoyée"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Une PME ne lancera pas une CLI. Pour « l’audit sans installation » (phase 5), deux voies existent : un scanner hébergé (⛔ il faut un compte Cloudflare) ou une **extension navigateur**. L’extension analyse la page **telle que l’utilisateur la voit**, y compris derrière une connexion, ce que ni la CLI ni un scanner hébergé ne font simplement. Une extension a accès aux pages visitées : c’est un risque de vie privée et de sécurité qu’il faut borner.

## Décision

1. **Manifest V3**, un seul code source compatible Chromium et Firefox (`packages/extension`). Le code est construit et testé dans le dépôt. La publication dans les magasins est une tâche distincte (⛔ comptes et dépense).
2. **Permissions minimales** (principe du moindre privilège) : `activeTab` et `scripting` uniquement.
   - **Aucune** permission d’hôte (`host_permissions`) ;
   - aucun script de contenu permanent ;
   - aucun accès à l’historique, aux onglets ou aux cookies.

   L’extension n’agit que sur l’onglet courant, **au clic de l’utilisateur**.
3. **Aucune donnée ne quitte le navigateur** : aucun appel réseau, aucune télémétrie, aucun stockage distant. Ce que fait la page est déclaré dans `manifest.json`, avec une CSP d’extension stricte (`script-src 'self'`). axe-core est **embarqué** dans l’extension, jamais chargé à distance (OWASP *Third Party JavaScript Management Cheat Sheet*).
4. **Même logique que la CLI** :
   - axe-core 4.14.0, en configuration par défaut ;
   - classement par `@rampe/core` (ADR-0008, ADR-0011, `isDirectCheck`) ;
   - **aucun score** ;
   - le rappel « les 106 critères demandent une vérification humaine ; N n’ont aucune vérification automatique directe ».
5. **Sortie** : un panneau (popup) qui affiche les résultats par critère, en reprenant les catégories de la CLI. L’utilisateur peut aussi **télécharger un rapport JSON v2** strictement compatible avec l’import de l’audit guidé (ADR-0014, `tool.name` dédié et accepté). Les pages hors http(s) (pages internes du navigateur, magasins d’extensions, fichiers locaux) sont refusées avec un message clair.
6. **Accessibilité du panneau** : HTML natif, navigation au clavier, contrastes en clair et en sombre, contrôle axe dans les tests.
7. **Tests** : Playwright charge l’extension non empaquetée dans Chromium, ouvre une page de test aux défauts connus, déclenche l’analyse et vérifie les résultats, puis importe le JSON dans l’audit guidé. Une archive `.zip` de l’extension est produite par la CI comme artefact, pour un test manuel.

## Conséquences

- Une PME peut auditer une page en un clic, puis importer le résultat dans l’audit guidé, sans terminal.
- La publication reste bloquée sur Alexandre (Mozilla : compte gratuit ; Chrome : 5 $).
- `tool.name` admis à l’import : `@rampe/cli` et `@rampe/extension`. L’ADR-0014 §4 s’en trouve élargi, et cette décision le documente.
