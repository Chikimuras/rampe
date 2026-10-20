# Rampe

Outil libre et gratuit pour accompagner les PME vers la conformité **RGAA** (accessibilité numérique), dans le cadre de l’European Accessibility Act.

> 🚧 En construction. Suivi en direct : **[cockpit](https://chikimuras.github.io/rampe/cockpit/)**

Ce projet est une expérience : il est conçu, développé et mis en production **de façon autonome par Claude** (Anthropic), sous la supervision d’Alexandre Velia. Chaque décision est tracée dans [`docs/adr/`](docs/adr/).

## Audit automatique en ligne de commande

```sh
npx playwright@1.64.0 install chromium   # une fois
npx rampe audit https://exemple.fr/
```

Options, échantillon de pages et publication sur npm : [`packages/cli/`](packages/cli/).

## Sauvegarde de l’audit guidé

L’audit guidé (`/audit/`) n’a pas de serveur : l’audit n’existe que dans le navigateur où il a été saisi (ADR-0005). Changer de navigateur ou effacer ses données le fait perdre. Pour le garder ou le transmettre :

- **« Télécharger l’audit (JSON) »** produit `audit-<site>-<date>.json` dans le navigateur, sans rien envoyer. L’interface rappelle la date du dernier téléchargement.
- **« Importer un audit (JSON) »** reprend ce fichier, dans n’importe quel navigateur. Il remplace l’audit en cours : Rampe demande d’abord confirmation et propose de télécharger l’audit actuel, puis permet d’annuler l’import.

Ne pas confondre avec le **rapport de la CLI** (`rampe audit --json`) ou de l’[extension navigateur](packages/extension/) (« Télécharger le rapport (JSON) »), qui s’importe dans la section « 1. Pages de l’échantillon » et complète l’audit sans le remplacer. Un fichier donné au mauvais champ est refusé, avec un message qui indique le bon (ADR-0016).

## Développement

```sh
pnpm install
pnpm check   # lint, typecheck, tests
pnpm --filter @rampe/site dev
```

## Rampe audite Rampe

À chaque PR et sur `main`, la CI construit le site, le sert en local et lance la vraie CLI en `--strict` (ADR-0021 §1). Le partage est le suivant :

- **le gate** (`pnpm audit:rampe`) audite les pages **telles qu’elles se chargent** : toutes les pages construites, en thème clair puis en thème sombre, et l’échantillon versionné [`docs/audit-rampe/echantillon.txt`](docs/audit-rampe/echantillon.txt) en 375 px ;
- **les tests de bout en bout du site** (`apps/site/test/`) couvrent les **états interactifs** de l’audit guidé (pages ajoutées, import d’un rapport, déclaration, schéma et plan), où ils lancent axe en clair, en sombre et en 375 px.

Tout signalement fait échouer la CI : non-conformité, rattachement incertain ou point à vérifier. Il n’y a aucune liste d’exceptions. Les rapports JSON et HTML de chaque passage sont joints à l’exécution (artefact `audit-rampe`). En local :

```sh
pnpm audit:rampe   # rapports dans audit-rampe-rapports/
```

L’échantillon contient les adresses de production. Le script les réécrit vers le build local et refuse toute autre adresse. Il n’est pas régénéré en CI. Pour le refaire :

```sh
pnpm audit:rampe --servir                                   # construit et sert le site sur un port libre ; affiche l’adresse
pnpm rampe echantillon http://127.0.0.1:<port>/rampe/        # dans un autre terminal
```

Ensuite, complétez le fichier à la main selon la méthode (ADR-0012), avec les adresses de production. Zéro signalement automatique ne veut pas dire conforme : la plupart des critères demandent un humain (ADR-0002).

## Licences

- Code : MIT.
- axe-core, embarqué dans l’extension : MPL-2.0 (licence copiée à côté de `axe.min.js`).
- Référentiel RGAA : © DINUM, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/), source [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr).
