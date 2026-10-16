# Rampe

Outil libre et gratuit pour accompagner les PME vers la conformité **RGAA** (accessibilité numérique), dans le cadre de l’European Accessibility Act.

> 🚧 En construction. Suivi en direct : **[cockpit](https://chikimuras.github.io/rampe/cockpit/)**

Ce projet est une expérience : il est conçu, développé et mis en production **de façon autonome par Claude** (Anthropic), sous la supervision d’Alexandre Velia. Chaque décision est tracée dans [`docs/adr/`](docs/adr/).

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

À chaque PR et sur `main`, la CI construit le site, le sert en local et lance la vraie CLI (`rampe audit --echantillon`) sur l’échantillon versionné [`docs/audit-rampe/echantillon.txt`](docs/audit-rampe/echantillon.txt) (ADR-0021 §1). **Toute non-conformité détectée automatiquement fait échouer la CI**, sans liste d’exceptions ; les rapports JSON et HTML sont joints à l’exécution (artefact `audit-rampe`). En local :

```sh
pnpm audit:rampe   # rapports dans audit-rampe-rapports/
```

L’échantillon contient les adresses de production ; le script les réécrit vers le build local et refuse toute autre adresse. Pour le régénérer : `pnpm --filter @rampe/site build`, puis `pnpm --filter @rampe/site exec astro preview` (il sert `apps/site/dist` sous `/rampe/`, en arrière-plan, à l’adresse qu’il affiche ; `astro preview stop` l’arrête), `pnpm exec rampe echantillon <adresse affichée>/rampe/`, et compléter à la main selon la méthode (ADR-0012), adresses de production comprises. Zéro non-conformité automatique ne veut pas dire conforme : la plupart des critères demandent un humain (ADR-0002).

## Licences

- Code : MIT.
- axe-core, embarqué dans l’extension : MPL-2.0 (licence copiée à côté de `axe.min.js`).
- Référentiel RGAA : © DINUM, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/), source [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr).
