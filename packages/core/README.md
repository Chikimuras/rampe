# @rampe/core

Cœur de Rampe : code pur, sans I/O. Pour l’instant, le référentiel **RGAA 4.1.2** (basé sur WCAG 2.1) sous forme de modèle typé : thématiques, critères, tests et leur méthodologie, références WCAG, glossaire indexé par ancre.

```ts
import { getCriterion, getGlossaryEntry, rgaa } from "@rampe/core";
```

## Données

`data/rgaa/` contient une copie **non modifiée** de `RGAA/criteres.json`, `RGAA/methodologies.json` et `RGAA/glossaire.json` du dépôt officiel de la DINUM, [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr). Le commit source et la date d’import sont dans `data/rgaa/source.json`. Contenu sous [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

Ces fichiers ne se modifient jamais à la main (ADR-0007). Pour les remplacer :

```sh
pnpm --filter @rampe/core sync-rgaa          # dernier commit de main
pnpm --filter @rampe/core sync-rgaa <sha>    # commit précis
```

Puis `pnpm check` : les tests verrouillent les invariants du référentiel (13 thématiques, 106 critères, liens du glossaire…).
