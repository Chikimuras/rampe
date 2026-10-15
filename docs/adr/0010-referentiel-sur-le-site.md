---
title: "ADR-0010 — Afficher le référentiel : texte officiel intact, explications en langage simple clairement séparées"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

Le public visé, la PME non experte, ne lit pas facilement le RGAA : formulations normatives, renvois au glossaire, jargon technique. La tentation est de réécrire chaque critère. Mais une reformulation peut trahir la norme, et Rampe accompagne vers une conformité légale (ADR-0002).

## Décision

1. **Pages statiques générées au build** : `/referentiel/` (les 13 thématiques), une page par critère (`/referentiel/1-1/`), et le glossaire. Le site lit uniquement le modèle typé de `@rampe/core`, jamais le JSON brut (ADR-0007).
2. **Le texte officiel est affiché intact** et étiqueté comme tel : titre, tests, cas particuliers, notes techniques, méthodologies, références WCAG. La source et la licence (DINUM, Licence Ouverte 2.0) sont citées sur chaque page.
3. **Le langage simple est un ajout, jamais un remplacement.**
   - Chaque thématique reçoit une introduction rédigée par Rampe : de quoi on parle, et qui est gêné quand c’est raté.
   - Ces textes sont visuellement distingués du texte officiel et signés « Explication Rampe — non normative ».
   - Les explications critère par critère viendront plus tard, si l’usage le justifie.
4. **Chaque critère indique ce qu’axe-core peut en détecter**, avec les règles et le niveau de rattachement (ADR-0008). C’est calculé au build à partir d’axe-core, pour qu’on voie tout de suite ce que l’automatique couvre et ce qui demande un humain.
5. **Sécurité** : le glossaire officiel contient du HTML, et les méthodologies du Markdown. Bien que la source soit épinglée et relue en PR (ADR-0007, ADR-0009), on le traite comme une donnée non fiable par défense en profondeur. Le rendu passe par un **assainissement par liste blanche** de balises et d’attributs (OWASP *Cross Site Scripting Prevention Cheat Sheet*, section « HTML Sanitization »). Aucun JavaScript côté client n’est nécessaire pour ces pages.
6. Ces pages doivent elles-mêmes respecter le RGAA. Elles sont contrôlées avec axe-core avant le merge.

## Conséquences

- Aucun risque de déformer la norme : ce qui fait foi reste lisible tel quel.
- Treize textes à rédiger et à maintenir, au lieu de 106.
- axe-core devient une dépendance de build du site (pas du navigateur).
