---
title: "ADR-0012 — Échantillon de pages : proposition automatique selon la méthode RGAA, toujours modifiable, jamais présentée comme complète"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La méthode officielle (dépôt DINUM, `src/obligations/evaluation-conformite.md`, section « Échantillon ») impose que l’audit porte au moins sur ces pages, **lorsqu’elles existent** :
- accueil, contact, mentions légales, page « accessibilité » (déclaration), plan du site, aide, authentification ;
- au moins une page par type de service ou utilisation principale (rubriques de premier niveau), **recherche comprise** ;
- l’ensemble des pages d’un **processus** (formulaire ou transaction sur plusieurs pages) ;
- des pages au contenu sensiblement différent (tableaux, multimédia, formulaires…) ;
- et des pages **tirées au hasard**, au moins 10 % de l’échantillon.

Une PME ne connaît pas ces règles. Les deviner automatiquement n’est que partiellement possible : un robot ne sait ni dérouler un processus ni juger qu’une page est « représentative ».

## Décision

1. **Nouvelle commande `rampe echantillon <url>`.** Elle ouvre la page d’accueil dans le navigateur, collecte les liens **de même origine** et **propose** un échantillon :
   - les 7 pages types sont repérées par des indices explicables (texte du lien, attribut `href`, présence dans le pied de page ou l’en-tête). Chaque page proposée indique **pourquoi** elle a été retenue ;
   - les rubriques de premier niveau sont les liens de la navigation principale (`nav`, `role="navigation"` dans l’en-tête) ;
   - la recherche est repérée par un formulaire de recherche (`role="search"`, `input[type=search]`) ;
   - le tirage au hasard porte sur les autres liens de même origine, avec une **graine** affichée et réutilisable (`--graine`), pour que l’échantillon soit reproductible.
2. **Ce qui ne peut pas être deviné est signalé, jamais inventé.**
   - Une page type introuvable est notée « non trouvée automatiquement : à ajouter si elle existe ». Rampe ne conclut jamais qu’elle n’existe pas.
   - L’absence de page « accessibilité » est mise en avant : la déclaration est une obligation légale.
   - Les processus et les pages au contenu particulier sont toujours listés comme **à compléter par l’humain**.
3. **L’échantillon est un fichier texte modifiable** (une URL par ligne, avec en commentaire le type et la raison). `rampe audit --echantillon <fichier>` audite toutes ses pages et produit un seul JSON, avec un élément par page dans `pages[]` (ADR-0011).
4. **Politesse et sécurité** :
   - même origine uniquement ;
   - 50 pages au plus par défaut ;
   - requêtes **séquentielles** ;
   - seuls les schémas http(s) sont acceptés ;
   - les mêmes garde-fous que pour `audit` s’appliquent : délai global, URL finale contrôlée, identifiants masqués.
   - une page de l’échantillon qui redirige vers une autre origine pendant l’audit est auditée, avec un avertissement (comme pour `audit`, ADR-0011) ;
   - une page qui répond avec un statut HTTP ≥ 400 est en erreur, pas auditée : son résultat serait trompeur ;
   - les adresses dont la simple visite déclenche une action (déconnexion, suppression, désinscription…) ne sont jamais proposées.

   Le fichier `robots.txt` n’est pas lu : l’outil audite des pages que son utilisateur désigne sur son propre site, à faible volume. Ce n’est pas un robot d’indexation.

## Conséquences

- Une PME obtient un point de départ conforme à la méthode, en sachant exactement ce qui reste à faire à la main.
- L’heuristique de repérage, essentiellement francophone (« mentions légales », « plan du site », « accessibilité : non/partiellement/totalement conforme »…), sera imparfaite. Des tests fixent les cas connus, et chaque proposition reste vérifiable puisque sa raison est affichée.
