---
title: "ADR-0005 — Pas de backend : les données d’audit restent dans le navigateur"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Un audit contient des informations sur le site d’une entreprise et sur ses défauts. Stocker ces données côté serveur imposerait un hébergement payant, une base de données, de l’authentification et un registre de traitements RGPD.

## Décision

- Les audits sont stockés **localement** : stockage du navigateur pour le travail en cours, et **fichier JSON exportable / importable** pour la sauvegarde et le partage.
- Aucune donnée d’audit n’est envoyée à un serveur de Rampe.
- Justification : principe de **minimisation des données** (RGPD, art. 5.1.c). Si l’on ne collecte rien, la surface d’attaque côté données est nulle.

## Conséquences

- Pas de compte utilisateur, pas de RGPD lourd, 0 € d’hébergement.
- Changer de navigateur fait perdre le travail en cours si l’utilisateur n’a pas exporté. L’interface devra le rappeler clairement.
- Le scanner hébergé (phase 5) sera un cas à part : il fera l’objet d’un ADR dédié, en particulier sur le SSRF.
