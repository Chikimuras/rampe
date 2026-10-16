# @rampe/cli

Audit automatique d’une page web ou d’un échantillon de pages, avec les résultats rangés par **critère RGAA** (ADR-0011). Le moteur est axe-core 4.14.0, exécuté dans un vrai Chromium par Playwright : les contrastes, la visibilité et les noms accessibles dépendent du rendu.

## Utilisation depuis le dépôt

Le paquet n’est pas encore publié sur npm. Depuis la racine du dépôt, après `pnpm install` :

```sh
pnpm --filter @rampe/cli exec playwright install chromium   # une fois
pnpm exec rampe audit https://exemple.fr/
pnpm exec rampe audit https://exemple.fr/ --json rapport.json --html rapport.html --timeout 60000
```

`pnpm --filter @rampe/cli exec rampe audit https://…` fonctionne aussi, mais un chemin `--json` relatif part alors de `packages/cli`.

Le binaire est `src/cli.ts`, exécuté tel quel par Node ≥ 22.18 (suppression native des types TypeScript) : pas d’étape de build.

| Option | Effet |
|---|---|
| `--json <fichier>` | écrit le résultat détaillé en JSON (voir plus bas) ; un fichier existant n’est jamais écrasé, et l’absence du dossier est signalée avant l’audit |
| `--html <fichier>` | écrit un rapport HTML lisible par un non-expert (voir plus bas) ; mêmes règles que `--json` : jamais d’écrasement, dossier vérifié avant l’audit, ni le fichier d’échantillon ni le fichier `--json` |
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
- **les rubriques** : liens de premier niveau de la navigation principale (celle de l’en-tête nommée « principal »/*main*, sinon celle qui a le plus de liens). Une navigation de langues, un fil d’Ariane, des liens d’évitement ou une navigation de moins de 3 liens ne comptent pas ; sans navigation principale, les rubriques sont « à compléter ». Les liens vers l’accueil lui-même (ancres, liens d’évitement) sont ignorés ;
- **la recherche** : formulaire dans `role="search"`, ou avec un champ `type="search"`, ou formulaire GET avec un champ `q`, `recherche`, `search`… ; Rampe ajoute la page de résultats pour le mot « contact ». Si l’adresse des résultats n’est pas déterminable (formulaire POST, recherche en JavaScript), Rampe le signale ;
- **un tirage au hasard** parmi les autres liens de même origine, d’au moins 10 % de l’échantillon (au moins une page), par un générateur à graine (mulberry32) : même graine et mêmes liens, même tirage.

Ce que Rampe ne devine pas est **signalé, jamais inventé** : une page type introuvable est notée « non trouvée automatiquement : à ajouter si elle existe » (Rampe ne conclut jamais qu’elle n’existe pas), l’absence de page « accessibilité » est mise en avant (la déclaration est une obligation légale), et les processus, les pages au contenu particulier et les documents téléchargeables sont toujours listés « à compléter ».

Format du fichier : une adresse par ligne ; les lignes vides et celles qui commencent par `#` sont ignorées. Au plus 1 000 adresses et 2 048 caractères par ligne ; une même adresse (sans fragment ni identifiants) n’est auditée qu’une fois. **Tirage au hasard** : si vous ajoutez des pages, ajoutez-en au hasard pour garder au moins 10 % de l’échantillon (1 pour 9). Rampe compte les adresses précédées d’une note `# hasard — …` et avertit, à la relecture, s’il en manque. Rampe écrit en commentaire, au-dessus de chaque adresse, son type et sa raison :

```text
# contact — lien « Contact », texte reconnu, adresse « /contact » reconnue, dans le pied de page
https://exemple.fr/contact
```

Garde-fous : seuls les liens **de même origine** que l’accueil (après redirections) sont retenus, sans fragment, sans doublon, sans fichiers non HTML (PDF, images…), et jamais une adresse dont la visite déclencherait une action (déconnexion, `delete`, suppression, désinscription…). Si l’accueil redirige vers une autre origine, un avertissement le dit (console et fichier) et l’échantillon est construit sur l’origine finale. Si `--max` écarte des pages obligatoires (pages types, recherche), un avertissement en tête dit que l’échantillon n’est pas conforme à la méthode tant qu’elles n’y sont pas ; les pages écartées ne reviennent pas par le tirage au hasard. Les identifiants éventuels de l’adresse (`https://moi:secret@…`) ne sont pas écrits dans le fichier : ajoutez-les à la main si besoin. Le fichier `robots.txt` n’est pas lu : Rampe audite, à faible volume, des pages que vous désignez sur votre propre site.

`rampe audit --echantillon <fichier>` vérifie d’abord tout le fichier (http(s) uniquement, toutes les adresses sur la même origine que la première ; sinon erreur avec le numéro de ligne), puis audite les pages **une à une**, dans un seul Chromium, chaque page dans un contexte neuf. `--timeout` s’applique alors à chaque page. Une page qui répond avec un statut HTTP ≥ 400 est en erreur (« HTTP 404 »), pas auditée. La console affiche un bloc par page puis une synthèse (« N pages auditées, M en erreur ») : critères avec une non-conformité détectée sur au moins une page, pages en erreur, et le rappel que les 106 critères demandent une vérification humaine.

Codes de sortie avec `--echantillon` : **0** aucune non-conformité détectée, **1** une non-conformité détectée sur au moins une page, **2** au moins une page en erreur (indiquée en console et dans `error` du JSON ; les autres pages sont quand même auditées) ou fichier invalide.

Sous Ubuntu 23.10 ou plus récent, Chromium peut refuser de démarrer (« No usable sandbox! ») : AppArmor y interdit les espaces de noms utilisateur dont son bac à sable a besoin. Rampe ne désactive jamais ce bac à sable ; suivez plutôt la [documentation de Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) (profil AppArmor ciblé, comme dans `.github/workflows/ci.yml`).

## Ce que fait l’audit

1. Seules les adresses `http://` et `https://` sont acceptées. Des identifiants dans l’URL (`https://moi:secret@preprod…`, authentification basique) sont acceptés mais masqués (`***`) dans toutes les sorties : console, erreurs, JSON.
2. Chromium headless, bac à sable activé (jamais `--no-sandbox`), charge la page : événement `load`, puis jusqu’à 5 s de réseau calme. Si la page a quitté le web entre-temps (ex. `about:blank`), l’audit s’arrête en erreur ; si elle a fini sur une autre origine que celle demandée (redirection), un avertissement s’affiche et figure dans `warnings` du JSON.
3. axe-core est injecté par le protocole de débogage du navigateur, ce qui n’est pas soumis à la CSP de la page (sans la désactiver), puis lancé avec sa configuration par défaut (sans règles expérimentales). Il s’exécute dans un **monde isolé** (ADR-0020) : il partage le DOM de la page, mais pas ses objets JavaScript, si bien qu’une page qui redéfinit `window.axe` ou casse `getAttribute`, `getComputedStyle`, `Array.prototype.filter` ou `JSON.stringify` ne peut pas fausser son audit (c’est testé). Seul le cadre principal est analysé : le contenu des iframes ne l’est pas encore.
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

## Rapport HTML (`--html`)

Pour la personne qui, dans la PME, reçoit le résultat sans être experte. Il fonctionne avec une page seule comme avec `--echantillon`, seul ou avec `--json`, et il est produit à partir du même JSON v2 (`renderHtmlReport` de `src/rapport.ts`, fonction pure).

- **Un seul fichier, autonome** : CSS dans une balise `<style>`, aucune ressource externe, **aucun JavaScript**. Il s’ouvre hors ligne, se joint à un courriel, s’imprime (les blocs repliés s’ouvrent à l’impression).
- **Accessible** (ADR-0011 §4) : `lang="fr"`, titres hiérarchisés, repères `header`/`main`/`footer`, lien d’évitement, longues listes repliées dans `<details>`, diagnostics d’axe en anglais marqués `lang="en"`, couleurs du site Rampe en clair et en sombre (`prefers-color-scheme`), lisible sur mobile. Un test de bout en bout lance axe-core 4.14.0 sur le rapport lui-même, en clair et en sombre, blocs ouverts : 0 violation attendue.
- **Échappé** (ADR-0011 §6) : titre, adresses, sélecteurs, extraits HTML, messages d’axe et avertissements passent tous par `escapeHtml` (OWASP *Cross Site Scripting Prevention Cheat Sheet*, « Output Encoding » pour le contexte HTML). Seules les adresses `http(s)` deviennent des liens. Les contrôles de direction bidirectionnelle (U+202A–202E, U+2066–2069) sont retirés, partout dans le rapport comme en console, et chaque donnée est isolée du texte de Rampe (`<bdi>`, `unicode-bidi: isolate`) : un titre piégé ne peut pas retourner le verdict qui le suit. Titre et sélecteur sont bornés à 300 caractères. Une page hostile (titre `<script>`, sélecteur `"><img onerror>`, U+202E…) ne peut pas piéger son rapport : c’est testé.
- **Honnête** (ADR-0002) : ni score ni taux. Un encadré, en tête, rappelle que ce n’est pas un audit de conformité et combien de critères n’ont aucune vérification automatique directe (même décompte que la console et le site).

Structure :

```text
Rapport d’audit automatique — exemple.fr
  Date · Pages auditées · Pages en erreur · Moteur (axe-core, Chromium)
  [Encadré] Ce rapport n’est pas un audit de conformité.
            Les 106 critères demandent une vérification humaine ; 79 n’ont aucune vérification automatique directe.
  Avertissements            (pages en erreur, redirection vers une autre origine…), s’il y en a
  Synthèse
    Non-conformités détectées   Critère 1.1 — titre officiel : 2 pages   (lien vers le détail)
    Rattachement incertain      règle, rattachement à confirmer, nombre de pages
    À vérifier par un humain
    Bonnes pratiques
  Non-conformités, critère par critère
    Critère 1.1 — titre officiel
      Explication Rampe — non normative (intro de la thématique, la même que sur le site)
      Lien vers la fiche du critère sur le site Rampe
      Règle image-alt « Images must have alternative text », test 1.1.1 : N éléments
        [replié] Voir les N éléments concernés par image-alt sur <page> : sélecteur, extrait HTML, diagnostic d’axe (en anglais)
  Autres résultats          détail : rattachement incertain, à vérifier, bonnes pratiques ; par règle
  Pages de l’audit          statut de chaque page (non-conformités ; points à vérifier) et pages en erreur
  Ce qui reste à faire      corriger (s’il y a lieu), audit humain des 106 critères, déclaration d’accessibilité
                            si l’organisation y est soumise (lien vers les obligations officielles)
  Pied : version de Rampe ; référentiel RGAA © DINUM, Licence Ouverte 2.0
```

Une page en erreur n’est jamais comptée comme « sans défaut » : elle est listée à part, avec la raison en clair (délai dépassé, adresse injoignable, HTTP 404…) et le message technique replié. Si aucune page n’a pu être auditée, la synthèse le dit en une phrase.

En mode URL unique (`rampe audit <url>`), une page en erreur arrête la CLI en 2 **sans écrire ni JSON ni HTML** : il n’y a rien à rapporter. Avec `--echantillon`, les autres pages sont auditées et les deux fichiers sont écrits.

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
          "help": "Images must have alternative text", // description de la règle par axe, en anglais
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

`html` est tronqué à 500 caractères, marqué « … (tronqué) », sans couper un caractère en deux. `pages` contient une entrée par page auditée, dans l’ordre du fichier d’échantillon.

Version 2 : ajout de `error` par page, et `finalUrl`/`title` à `null` pour une page en erreur. Sans ce changement, un lecteur de la version 1 aurait pris une page en erreur, sans résultats, pour une page sans défaut.

## Reprendre le JSON dans l’audit guidé (ADR-0014)

Le fichier `--json` s’importe dans la page `/audit/` du site Rampe, pour ne pas ressaisir ce que la machine a trouvé :

```sh
pnpm exec rampe echantillon https://exemple.fr/ --sortie echantillon.txt   # 1. proposer l’échantillon
pnpm exec rampe audit --echantillon echantillon.txt --json rapport.json     # 2. audit automatique
# 3. Sur /audit/ : « Importer un rapport de la CLI (JSON) », choisir rapport.json
```

- Les pages du rapport absentes de l’audit sont ajoutées. Elles sont rapprochées par adresse, sans fragment ni identifiants. Les pages en erreur ne sont pas importées et sont listées dans le bilan.
- Une **non-conformité** passe le critère à « Non conforme » **seulement si rien n’a encore été saisi** pour ce critère sur la page. L’évaluation est alors marquée « Détecté automatiquement, à confirmer », avec une note générée (« Détecté automatiquement : image-alt (3 éléments) ») et un bouton « Confirmer ». Dès que la personne confirme, change le statut ou la note, l’évaluation devient la sienne.
- Les autres résultats (rattachement incertain, à vérifier) deviennent des **indices** sous le critère et la page. Ils ne valent ni conformité ni non-conformité. Une non-conformité trouvée sur un critère déjà évalué y figure aussi, sans toucher à l’évaluation ; si la personne l’avait jugé « Conforme », un avertissement l’invite à vérifier.
- Réimporter un rapport plus récent remplace les indices des pages qu’il contient : un défaut corrigé disparaît des indices.
- Une évaluation saisie par une personne n’est jamais modifiée. Réimporter le même fichier ne change rien. « Annuler cet import » restaure l’état précédent tant que rien d’autre n’a été modifié.
- Le fichier vient de l’extérieur de l’application : il est validé strictement, tout ou rien (`parseAuditReport` de `@rampe/core`). Un fichier refusé ne modifie pas l’audit, et le message nomme le premier défaut trouvé.

Le titre de page est borné à 300 caractères dans le JSON (« … (tronqué) »). Le champ `help` est apparu après la première version du format 2. Il reste facultatif à l’import, donc un fichier plus ancien s’importe aussi, sans les descriptions.

## Tests

`pnpm --filter @rampe/cli test` lance les tests unitaires et des tests de bout en bout : la vraie CLI audite les pages de `test/fixtures/` servies par un serveur `node:http` local (défauts connus aux critères 1.1, 3.2, 8.3 et 11.1 ; page propre ; `region` seule ; boucle infinie ; départ vers `about:blank` ; CSP `script-src 'none'` ; page piège qui falsifie `window.axe` et casse des primitives JavaScript ; redirection vers une autre origine avec identifiants dans l’URL). Un mini-site local (`test/fixtures/site-accueil.html` et des pages générées) sert à enchaîner `rampe echantillon` puis `rampe audit --echantillon` : pages types et raisons, page manquante signalée, JSON multi-pages, page en erreur et codes de sortie. Il faut Chromium (commande ci-dessus). Les pages de test sont exclues de Biome, puisqu’elles sont fautives exprès.
