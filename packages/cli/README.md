# @rampe/cli

Audit automatique d’une page web ou d’un échantillon de pages, avec les résultats rangés par **critère RGAA** (ADR-0011). Le moteur est axe-core 4.14.0, exécuté dans un vrai Chromium par Playwright : les contrastes, la visibilité et les noms accessibles dépendent du rendu.

## Utilisation depuis le dépôt

Le paquet n’est pas encore publié sur npm. Depuis la racine du dépôt, après `pnpm install` :

```sh
pnpm --filter @rampe/cli exec playwright install chromium   # une fois
pnpm exec rampe audit https://exemple.fr/
pnpm exec rampe audit https://exemple.fr/ --json rapport.json --timeout 60000
```

`pnpm --filter @rampe/cli exec rampe audit https://…` fonctionne aussi, mais un chemin `--json` relatif part alors de `packages/cli`.

Le binaire est `src/cli.ts`, exécuté tel quel par Node ≥ 22.18 (suppression native des types TypeScript) : pas d’étape de build.

| Option | Effet |
|---|---|
| `--json <fichier>` | écrit le résultat détaillé en JSON (voir plus bas) |
| `--timeout <ms>` | durée maximale de tout l’audit d’une page : chargement, injection et analyse (défaut : 60 000) ; au-delà, la page est fermée et la CLI sort en 2 |
| `--echantillon <fichier>` | audite les pages d’un fichier d’échantillon au lieu d’une seule URL (voir plus bas) |

Codes de sortie : **0** aucune non-conformité détectée, **1** au moins une non-conformité détectée (pratique en CI), **2** erreur d’usage ou page injoignable.

## Auditer un échantillon de pages (ADR-0012)

La méthode officielle (DINUM, [« Évaluation de la conformité », section « Échantillon »](https://accessibilite.numerique.gouv.fr/obligations/evaluation-conformite/)) dit que l’échantillon « porte au moins sur les pages suivantes, lorsqu’elles existent » : accueil, contact, mentions légales, page « accessibilité », plan du site, aide, authentification. S’y ajoutent « au moins une page pertinente pour chaque type de service fourni […] (ex. : rubriques de 1er niveau dans l’arborescence…), y compris la fonctionnalité de recherche », « l’ensemble des pages constituant un processus », des pages au contenu sensiblement différent, au moins un document téléchargeable pertinent le cas échéant, et enfin « des pages sélectionnées au hasard représentant au moins 10 % des pages de l’échantillon ».

Le flux de travail :

```sh
# 1. Rampe propose un échantillon (accueil chargé dans Chromium, liens de même origine)
pnpm exec rampe echantillon https://exemple.fr/ --sortie echantillon.txt
# 2. Vous relisez et modifiez echantillon.txt : ajoutez ce que Rampe n’a pas trouvé, retirez ce qui ne convient pas
# 3. Rampe audite chaque page, une à une, et produit un seul JSON
pnpm exec rampe audit --echantillon echantillon.txt --json rapport.json
```

| Option de `rampe echantillon` | Effet |
|---|---|
| `--sortie <fichier>` | fichier à écrire (défaut : `echantillon.txt`) ; un fichier existant n’est **jamais écrasé**, puisqu’il a pu être modifié à la main |
| `--max <n>` | nombre maximal de pages proposées (défaut : 50, minimum 2) ; les pages écartées sont listées « à compléter » |
| `--graine <n>` | graine du tirage au hasard (entier de 0 à 4 294 967 295) ; sans elle, une graine est tirée et affichée pour rejouer le même échantillon |
| `--timeout <ms>` | durée maximale du chargement et de l’analyse de l’accueil (défaut : 60 000) |

Ce que Rampe propose, avec pour chaque page la **raison** de sa présence :

- **les 7 pages types**, repérées par des indices explicables : le texte du lien (sans accents ni majuscules), un segment de son adresse, et sa présence dans l’en-tête (`header`, `role="banner"`) ou le pied de page (`footer`, `role="contentinfo"`). Le texte doit être l’intitulé entier du lien, éventuellement suivi d’un séparateur : « Accessibilité : partiellement conforme » ou « Mentions légales & CGU » sont reconnus, « Contactez-nous pour un devis » dans un paragraphe ne l’est pas. La position seule ne suffit jamais. « Aide à domicile » n’est pas une page d’aide : la méthode vise l’aide à l’utilisation du site, pas une offre. Les intitulés sont surtout français, avec quelques équivalents anglais (*contact us*, *legal notice*, *accessibility*, *sitemap*, *help*, *sign in*…) ;
- **les rubriques** : liens de premier niveau de la navigation principale (celle de l’en-tête nommée « principal »/*main*, sinon celle qui a le plus de liens) ;
- **la recherche** : formulaire dans `role="search"`, ou avec un champ `type="search"`, ou formulaire GET avec un champ `q`, `recherche`, `search`… ; Rampe ajoute la page de résultats pour le mot « contact ». Si l’adresse des résultats n’est pas déterminable (formulaire POST, recherche en JavaScript), Rampe le signale ;
- **un tirage au hasard** parmi les autres liens de même origine, d’au moins 10 % de l’échantillon (au moins une page), par un générateur à graine (mulberry32) : même graine et mêmes liens, même tirage.

Ce que Rampe ne devine pas est **signalé, jamais inventé** : une page type introuvable est notée « non trouvée automatiquement : à ajouter si elle existe » (Rampe ne conclut jamais qu’elle n’existe pas), l’absence de page « accessibilité » est mise en avant (la déclaration est une obligation légale), et les processus, les pages au contenu particulier et les documents téléchargeables sont toujours listés « à compléter ».

Format du fichier : une adresse par ligne ; les lignes vides et celles qui commencent par `#` sont ignorées. Rampe écrit en commentaire, au-dessus de chaque adresse, son type et sa raison :

```text
# contact — lien « Contact », texte reconnu, adresse « /contact » reconnue, dans le pied de page
https://exemple.fr/contact
```

Garde-fous : seuls les liens **de même origine** que l’accueil (après redirections) sont retenus, sans fragment, sans doublon, sans fichiers non HTML (PDF, images…). Les identifiants éventuels de l’adresse (`https://moi:secret@…`) ne sont pas écrits dans le fichier : ajoutez-les à la main si besoin. Le fichier `robots.txt` n’est pas lu : Rampe audite, à faible volume, des pages que vous désignez sur votre propre site.

`rampe audit --echantillon <fichier>` vérifie d’abord tout le fichier (http(s) uniquement, toutes les adresses sur la même origine que la première ; sinon erreur avec le numéro de ligne), puis audite les pages **une à une**, dans un seul Chromium, chaque page dans un contexte neuf. `--timeout` s’applique alors à chaque page. La console affiche un bloc par page puis une synthèse : critères avec une non-conformité détectée sur au moins une page, pages en erreur, et le rappel que les 106 critères demandent une vérification humaine.

Codes de sortie avec `--echantillon` : **0** aucune non-conformité détectée, **1** une non-conformité détectée sur au moins une page, **2** au moins une page en erreur (indiquée en console et dans `error` du JSON ; les autres pages sont quand même auditées) ou fichier invalide.

Sous Ubuntu 23.10 ou plus récent, Chromium peut refuser de démarrer (« No usable sandbox! ») : AppArmor y interdit les espaces de noms utilisateur dont son bac à sable a besoin. Rampe ne désactive jamais ce bac à sable ; suivez plutôt la [documentation de Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) (profil AppArmor ciblé, comme dans `.github/workflows/ci.yml`).

## Ce que fait l’audit

1. Seules les adresses `http://` et `https://` sont acceptées. Des identifiants dans l’URL (`https://moi:secret@preprod…`, authentification basique) sont acceptés mais masqués (`***`) dans toutes les sorties : console, erreurs, JSON.
2. Chromium headless, bac à sable activé (jamais `--no-sandbox`), charge la page : événement `load`, puis jusqu’à 5 s de réseau calme. Si la page a quitté le web entre-temps (ex. `about:blank`), l’audit s’arrête en erreur ; si elle a fini sur une autre origine que celle demandée (redirection), un avertissement s’affiche et figure dans `warnings` du JSON.
3. axe-core est injecté par le protocole de débogage du navigateur, ce qui n’est pas soumis à la CSP de la page (sans la désactiver), puis lancé avec sa configuration par défaut (sans règles expérimentales). Seul le cadre principal est analysé : le contenu des iframes ne l’est pas encore.
4. Chaque résultat est classé avec `classifyAxeRule` et `isDirectCheck` de `@rampe/core` (ADR-0008, ADR-0011 §3) :

| Résultat axe | Rattachement | `kind` | Présenté comme |
|---|---|---|---|
| violation | direct (`rgaa`), ni bonne pratique ni expérimentale | `non-conformite` | non-conformité détectée, avec les tests RGAA cités |
| violation | direct (`rgaa`), bonne pratique ou expérimentale | `incertain` | sous son critère, « à confirmer par un humain » |
| violation | indirect (`wcag`) | `incertain` | problème détecté, rattachement RGAA incertain |
| violation | `hors-rgaa` | `bonne-pratique` | bonne pratique, hors conformité |
| incomplete | tout niveau | `a-verifier` | à vérifier par un humain |

Les règles dépréciées par axe sont exclues. Seule une `non-conformite` fait sortir la CLI en 1 : `region`, bonne pratique d’axe qui cite le test 9.2.1, reste `incertain`.

## Ce que l’outil ne fait pas

- **Aucun score ni taux de conformité** (ADR-0002) : un audit automatique ne vérifie directement qu’une minorité des critères. Chaque rapport le rappelle : « Les 106 critères demandent une vérification humaine. 79 d’entre eux n’ont même aucune vérification automatique directe. » (axe-core 4.14.0 ; même décompte que le site, via `criteriaWithDirectRule`).
- **Aucune certification**, et aucune modification du site audité.
- Le rapport HTML viendra ensuite.

## Format JSON (`schemaVersion: 2`)

```jsonc
{
  "schemaVersion": 2,
  "tool": { "name": "@rampe/cli", "version": "0.0.0" },
  "engine": { "axe": "4.14.0", "browser": "156.0.8078.4" },
  "startedAt": "2026-10-15T09:25:01.779Z",
  "pages": [
    {
      "url": "https://exemple.fr/",
      "finalUrl": "https://exemple.fr/",   // après redirections
      "title": "Accueil",
      "warnings": [],                    // ex. redirection vers une autre origine
      "error": null,                     // message si la page n'a pas pu être auditée (échantillon) ;
                                         // finalUrl et title sont alors null, results vide
      "results": [
        {
          "ruleId": "image-alt",
          "kind": "non-conformite",
          "level": "rgaa",                 // précision du rattachement : rgaa | wcag | hors-rgaa
          "tests": ["1.1.1"],              // tests RGAA cités (niveau rgaa)
          "criteria": ["1.1"],
          "wcag": [],                      // critères de succès WCAG (niveaux wcag et hors-rgaa)
          "flags": { "bestPractice": false, "experimental": false },
          "impact": "critical",
          "nodes": [{ "target": ["img"], "html": "<img src=…>", "failureSummary": "…" }]
        }
      ]
    }
  ]
}
```

`html` est tronqué à 500 caractères. `pages` contient une entrée par page auditée, dans l’ordre du fichier d’échantillon.

Version 2 : ajout de `error` par page, et `finalUrl`/`title` à `null` pour une page en erreur. Sans ce changement, un lecteur de la version 1 aurait pris une page en erreur, sans résultats, pour une page sans défaut.

## Tests

`pnpm --filter @rampe/cli test` lance les tests unitaires et des tests de bout en bout : la vraie CLI audite les pages de `test/fixtures/` servies par un serveur `node:http` local (défauts connus aux critères 1.1, 3.2, 8.3 et 11.1 ; page propre ; `region` seule ; boucle infinie ; départ vers `about:blank` ; CSP `script-src 'none'` ; redirection vers une autre origine avec identifiants dans l’URL). Un mini-site local (`test/fixtures/site-accueil.html` et des pages générées) sert à enchaîner `rampe echantillon` puis `rampe audit --echantillon` : pages types et raisons, page manquante signalée, JSON multi-pages, page en erreur et codes de sortie. Il faut Chromium (commande ci-dessus). Les pages de test sont exclues de Biome, puisqu’elles sont fautives exprès.
