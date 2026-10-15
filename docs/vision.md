---
title: Vision produit
order: 1
---

## Le problème

Depuis le **28 juin 2025**, l’*European Accessibility Act* (directive (UE) 2019/882) oblige une large partie du secteur privé — e-commerce, banque, transport, services numériques grand public — à rendre ses services numériques accessibles. En France, la référence technique est le **RGAA** : 106 critères, une **déclaration d’accessibilité** à publier, un schéma pluriannuel.

Les PME n’ont ni l’expertise ni le budget d’un audit complet. Les outils existants sont soit payants, soit en anglais et calés sur WCAG (pas sur les critères RGAA), soit des « overlays » qui promettent une conformité magique et sont rejetés par les personnes concernées.

## La réponse : Rampe

Un outil **gratuit et open source** qui :

1. **audite automatiquement** ce qui peut l’être, et rattache chaque problème au **critère RGAA exact** ;
2. **guide**, en langage simple, la vérification des critères qu’aucune machine ne sait juger ;
3. **calcule** le taux de conformité selon la méthode officielle ;
4. **produit** les livrables légaux (déclaration d’accessibilité, schéma pluriannuel).

## Pour qui

- **Principal** : la personne qui, dans une PME, « hérite » du sujet accessibilité sans en être experte (dirigeant·e, responsable marketing, chef·fe de projet web).
- **Secondaire** : développeurs et agences qui corrigent, et veulent un rapport rattaché au RGAA dans leur CI.

## Ce que Rampe ne sera jamais

- **Un certificat.** L’automatique couvre une minorité des critères ; Rampe accompagne, il ne certifie pas. Il le dit partout.
- **Un overlay.** Rampe ne modifie jamais le site audité.
- **Un aspirateur de données.** Les audits restent chez l’utilisateur tant qu’aucun besoin ne justifie l’inverse (voir ADR-0005).
- **Payant.**

## Mesure du succès

- Rampe obtient 100 % de conformité RGAA sur son propre site (dogfooding).
- Une PME peut, sans aide, passer d’une URL à une déclaration d’accessibilité publiable.
