---
title: "ADR-0016 — Export et import de l’audit en fichier JSON : sauvegarde locale, validation stricte, jamais d’écrasement sans filet"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

L’ADR-0005 garde les audits dans le navigateur. Sa conséquence assumée, c’est que changer de navigateur ou effacer ses données fait perdre le travail si l’on n’a pas exporté. L’export et l’import sont donc la sauvegarde de l’utilisateur, et sa seule manière de transmettre un audit, par exemple à un prestataire. Un fichier de session importé vient de l’extérieur de l’application, comme le rapport de la CLI (ADR-0014).

## Décision

1. **Export** : un bouton « Télécharger l’audit (JSON) » produit le fichier `audit-<site>-<date>.json` dans le navigateur (`Blob` et lien de téléchargement), sans serveur. Le contenu est la session complète, avec son `schemaVersion` et `tool: { name: "@rampe/site" }`.
2. **Import** : un champ fichier étiqueté. La taille est vérifiée avant lecture (20 Mo au plus). La validation est **stricte**, sur le même modèle que l’ADR-0014 §4 :
   - liste blanche des champs, types et bornes ;
   - critères **existants dans le référentiel** ;
   - identifiants de page au format UUID ;
   - URL http(s) ;
   - lecture par `Object.hasOwn` uniquement ;
   - refus de `__proto__`, `constructor` et `prototype` ;
   - caractères de contrôle et bidi retirés ;
   - **tout ou rien** ;
   - message en clair, puis le détail technique replié.

   Une session d’une version **future** est refusée avec « créée par une version plus récente de Rampe ». Les versions antérieures sont migrées.
3. **Jamais d’écrasement sans filet** : importer remplace l’audit en cours. Si l’audit courant contient au moins une évaluation ou une page, Rampe demande confirmation et propose d’abord de **télécharger l’audit actuel**. Après l’import, « Annuler cet import » restaure l’audit précédent, selon le même mécanisme que l’ADR-0014 §5.
4. **Rappel de sauvegarde** : l’interface rappelle, de façon sobre et non intrusive, que l’audit n’existe que dans ce navigateur. Elle indique la date du dernier export, ou « jamais exporté ».

## Conséquences

- L’utilisateur peut sauvegarder, transmettre et reprendre son audit, sans compte et sans serveur.
- Règle de validation de la session :
  - **structure et types partout** : import de fichier comme relecture du stockage local (objet, ids UUID, même origine, clés interdites, critères du référentiel, statuts et sources connus, version future protégée avant tout autre contrôle) ;
  - **bornes à l’écriture et à l’import de fichier** : longueurs, nombre de pages et d’indices, avec une seule définition partagée, pour que tout audit produit par l’interface se réimporte à l’identique ;
  - **jamais de borne à la relecture du stockage** : un audit écrit par une version précédente, aux textes plus longs que les bornes d’aujourd’hui, est relu sans perte ni modification ;
  - **aucune session mise de côté n’est écrasée** : une session illisible est copiée sous une clé horodatée (3 copies au plus, la plus ancienne retirée seulement au-delà), et l’utilisateur peut la télécharger telle quelle.
