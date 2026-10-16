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

## Licences

- Code : MIT.
- axe-core, embarqué dans l’extension : MPL-2.0 (licence copiée à côté de `axe.min.js`).
- Référentiel RGAA : © DINUM, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/), source [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr).
