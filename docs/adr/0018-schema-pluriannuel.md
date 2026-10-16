---
title: "ADR-0018 — Schéma pluriannuel : un guide de rédaction structuré par la liste officielle, et un plan d’action pré-rempli depuis l’audit"
status: Accepted
date: 2026-10-16
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La DINUM (`src/obligations/schema-pluriannuel.md`) n’impose **pas de format** au schéma pluriannuel. Elle en fixe le **contenu** :
- durée de **trois ans au plus** ;
- huit volets sur la politique d’accessibilité de l’organisme (stratégie, référent, ressources, recrutement, formation, ressources externes, organisation interne, clauses contractuelles) ;
- six volets sur les travaux de mise en conformité (nouveaux projets, tests avec des personnes handicapées, audits prévus, **mesures correctives avec calendrier, en priorisant les contenus les plus consultés**, mesures non obligatoires, bilan des plans annuels) ;
- ces travaux sont **planifiés annuellement dans des plans d’actions** ;
- le schéma et le plan de l’année en cours sont publiés en ligne, dans un format accessible, et **reliés depuis la déclaration d’accessibilité**.

Ce document décrit la politique de l’organisme, qui seul peut l’écrire. Les volets « politique » ne peuvent pas être déduits d’un audit.

## Décision

1. **Un guide de rédaction, pas un générateur de politique.** Le formulaire suit **la liste officielle, dans son ordre**. Chaque volet affiche sa description officielle (citée, Licence Ouverte 2.0) comme consigne, puis un champ de texte libre. Rampe n’écrit **aucun** texte de politique à la place de l’organisme : un volet vide reste visiblement « à compléter » dans l’aperçu.
2. **Ce que Rampe pré-remplit depuis l’audit, et seulement cela** : le volet « mesures correctives », sous forme d’un **tableau d’actions**. Chaque critère non validé (ADR-0015), avec les pages concernées, y devient une action proposée. L’utilisateur fixe pour chacune :
   - une **priorité** (haute, moyenne ou basse ; l’aide rappelle la consigne officielle : contenus les plus consultés d’abord) ;
   - une **année cible** dans la période du schéma ;
   - un commentaire facultatif.

   L’utilisateur peut ajouter des actions libres et retirer une action proposée (le retrait est conservé et visible, pour ne pas faire disparaître une non-conformité en silence). Si l’audit est incomplet, aucune action n’est inventée : le volet l’indique et renvoie vers l’audit.
3. **Période** : année de début saisie par l’utilisateur, durée de 1 à 3 ans. Une année cible hors période est refusée à la saisie.
4. **Plan d’action annuel** : produit automatiquement à partir du tableau, en filtrant sur une année. Il comporte un « bilan de l’année précédente », que l’utilisateur remplit en indiquant pour chaque action si elle est faite, en cours ou reportée.
5. **Sortie et données** : aperçu accessible, export HTML sémantique et Markdown, sans réseau. Les saisies sont rangées dans la session (nouveau `schemaVersion`, migration sans perte), avec la même règle de validation que l’ADR-0016 : structure et types partout, bornes à l’écriture et à l’import, jamais à la relecture du stockage. Toute saisie est échappée à la sortie (OWASP *XSS Prevention*, « Output Encoding »).
6. **Lien avec la déclaration** : le champ « lien vers le schéma pluriannuel et le plan d’action » de la déclaration (ADR-0017) explique où publier ces documents. Rampe ne publie rien lui-même.

## Conséquences

- L’organisme dispose d’une trame complète et conforme à la liste officielle, et d’un plan d’action chiffré à partir de son audit.
- La responsabilité du contenu reste entièrement la sienne, et c’est affiché.
