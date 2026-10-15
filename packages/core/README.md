# @rampe/core

Cœur de Rampe : code pur, sans I/O. Pour l’instant, le référentiel **RGAA 4.1.2** (basé sur WCAG 2.1) sous forme de modèle typé : thématiques, critères, tests et leur méthodologie, références WCAG, glossaire indexé par ancre.

```ts
import { getCriterion, getGlossaryEntry, rgaa } from "@rampe/core";
```

## Données

`data/rgaa/` contient une copie **non modifiée** de `RGAA/criteres.json`, `RGAA/methodologies.json` et `RGAA/glossaire.json` du dépôt officiel de la DINUM, [DISIC/accessibilite.numerique.gouv.fr](https://github.com/DISIC/accessibilite.numerique.gouv.fr). Le commit source et la date d’import sont dans `data/rgaa/source.json`. Contenu sous [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

Ces fichiers ne se modifient jamais à la main (ADR-0007). Pour les remplacer :

```sh
pnpm --filter @rampe/core sync-rgaa main <version>   # dernier commit de main, ex. version 4.1.2
pnpm --filter @rampe/core sync-rgaa <sha> <version>  # commit précis
```

La version du RGAA n’est pas dans le JSON officiel : elle est obligatoire dès que le commit change (sinon le script ne fait rien). La version WCAG est lue dans `criteres.json`. Le script télécharge et valide les trois fichiers avant d’en écrire un seul ; `GITHUB_TOKEN`, s’il est défini, sert à l’appel à l’API GitHub.

Ensuite :

1. relire `git diff packages/core/data` : c’est là qu’on voit ce que la DINUM a changé ;
2. lancer `pnpm check` : les tests verrouillent les invariants du référentiel (13 thématiques, 106 critères, numérotation contiguë, une méthodologie par test, liens du glossaire…).

## Exception connue

La note technique du critère 5.1 contient un lien `#table-descriptions-techniques` qui ne mène à aucune entrée du glossaire : c’est une ancre de la spécification HTML du WHATWG, laissée en lien relatif dans la source. Elle est listée explicitement dans les tests (`KNOWN_DANGLING_ANCHORS`) ; tout autre lien non résolu les fait échouer.
