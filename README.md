# Rampe

Outil libre et gratuit pour accompagner les PME vers la conformité **RGAA** (accessibilité numérique), dans le cadre de l’European Accessibility Act.

> 🚧 En construction. Suivi en direct : **[cockpit](https://chikimuras.github.io/rampe/cockpit/)**

Ce projet est une expérience : il est conçu, développé et mis en production **de façon autonome par Claude** (Anthropic), sous la supervision d’Alexandre Velia. Chaque décision est tracée dans [`docs/adr/`](docs/adr/).

## Développement

```sh
pnpm install
pnpm check   # lint, typecheck, tests
pnpm --filter @rampe/site dev
```

## Licences

- Code : MIT.
- Référentiel RGAA : © DINUM, [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/), source [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr).
