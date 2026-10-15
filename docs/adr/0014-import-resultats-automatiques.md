---
title: "ADR-0014 — Import des résultats automatiques : la machine propose, l’humain garde le dernier mot ; validation stricte à l’entrée"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La CLI produit un JSON v2 (ADR-0011, ADR-0012) qui contient, pour chaque page, des résultats classés en non-conformité, rattachement incertain, bonne pratique ou point à vérifier. L’audit guidé (ADR-0013) doit pouvoir les reprendre pour ne pas tout ressaisir. Deux questions se posent :
1. Que devient une évaluation humaine déjà saisie quand un import arrive ?
2. Ce fichier vient de l’extérieur de l’application : il peut avoir été modifié à la main, tronqué, ou fabriqué.

## Décision

1. **La machine ne remplace jamais un jugement humain.**
   - Une **non-conformité** détectée (classe `non-conformite`, ADR-0011) fixe le statut **Non conforme** uniquement si le critère est encore **Non testé** sur cette page. L’évaluation porte alors une **source** `auto` et une note générée, par exemple « Détecté automatiquement : image-alt (3 éléments) ».
   - Une évaluation saisie par l’humain (source `humain`, valeur par défaut) n’est jamais modifiée par un import.
   - L’interface affiche la source (« Détecté automatiquement, à confirmer »). Dès que l’humain change le statut ou la note, la source devient `humain`.
2. **Les autres classes ne fixent aucun statut.** Les rattachements incertains, les points à vérifier et les bonnes pratiques sont rangés comme **indices** (`findings`) sous le critère et la page concernés. L’humain les voit pendant son évaluation, mais ils ne valent ni conformité ni non-conformité (ADR-0002).
3. **Correspondance des pages** : par URL normalisée (sans fragment ni identifiants). Une page absente de la session est ajoutée. Le site du fichier doit être le même que celui de la session ; sinon l’import est refusé avec un message clair. Les pages en erreur du fichier sont listées comme non importées.
4. **Validation stricte à la frontière** (OWASP *Input Validation Cheat Sheet* : validation par liste blanche du type, de la forme et des bornes ; OWASP *Deserialization Cheat Sheet* : ne jamais faire confiance à une structure désérialisée) :
   - taille maximale du fichier : 20 Mo ;
   - `JSON.parse` est la seule désérialisation ; aucun `eval` ni `new Function` ;
   - `schemaVersion` égal à 2 et `tool.name` égal à `rampe` ;
   - chaque champ utilisé est validé en type et en bornes : URL http(s), critères **existants dans le référentiel**, classes connues, nombres positifs, textes bornés ;
   - les propriétés inconnues sont ignorées ;
   - lecture par `Object.hasOwn` uniquement, et refus des clés `__proto__`, `constructor` et `prototype` ;
   - les caractères de contrôle et bidi sont retirés des textes importés ;
   - **tout ou rien** : un fichier invalide ne modifie pas la session, et le message indique le premier défaut trouvé.
5. **Annulation** : un import affiche un bilan (pages ajoutées, statuts fixés, indices ajoutés, pages ignorées) et propose **« Annuler cet import »**, qui restaure l’état précédent, tant qu’aucune autre modification n’a été faite.

## Conséquences

- Le modèle de session gagne `source` sur les évaluations et `findings` par critère et par page. Son `schemaVersion` passe de 1 à 2, et une session v1 relue est migrée sans perte.
- La validation de l’existence des critères contre le référentiel se fait **au moment de l’import**. Le modèle pur ne vérifie que le format (décision de la PR #15).
