# @rampe/core

Cœur de Rampe : code pur, sans I/O. Le référentiel **RGAA 4.1.2** (basé sur WCAG 2.1) sous forme de modèle typé : thématiques, critères, tests et leur méthodologie, références WCAG, glossaire indexé par ancre.

```ts
import { getCriterion, getGlossaryEntry, rgaa } from "@rampe/core";
```

## Correspondance axe-core → RGAA

`classifyAxeRule(tags)` rattache une règle [axe-core](https://github.com/dequelabs/axe-core) au RGAA à partir des étiquettes qu’axe fournit avec chaque règle et chaque résultat (ADR-0008). Aucune table maintenue à la main. Trois niveaux, du plus précis au moins précis :

- **`rgaa`** : la règle porte des étiquettes `RGAA-x.y.z` ; elle est rattachée à ces tests et à leurs critères ;
- **`wcag`** : rattachement *indirect* via les étiquettes de critères de succès WCAG (`wcag111`, `wcag1412`…) et les références WCAG du référentiel ; il demande plus de vérification humaine (4.1.2, par exemple, renvoie à 17 critères RGAA) ;
- **`hors-rgaa`** : aucun rattachement RGAA possible (bonnes pratiques d’axe sans étiquette, critères WCAG absents du RGAA 4.1.2 comme 2.5.8 ou les AAA) ; `wcag` liste quand même les critères de succès trouvés, pour l’affichage. Jamais compté dans la conformité.

Le niveau qualifie la **précision du rattachement**, pas la certitude du défaut. Les drapeaux `bestPractice` (étiquette `best-practice`), `experimental` et `deprecated` sont présents sur les trois niveaux : certaines bonnes pratiques d’axe (`region`, `skip-link`, `table-duplicate-name`, `focus-order-semantics`) portent des étiquettes RGAA et sont au niveau `rgaa`. Une étiquette `RGAA-x.y.z` qui ne désigne aucun test du référentiel est écartée du rattachement et renvoyée dans `unknownRgaaTags`. Les règles dépréciées par axe 4.14.0 (`aria-roledescription`, `audio-caption`, `duplicate-id`, `duplicate-id-active`, `landmark-complementary-is-top-level`) gardent leur niveau mais ne doivent plus être présentées comme une vérification : le site les écarte.

```ts
classifyAxeRule(["wcag2a", "wcag111", "RGAA-1.1.1"]); // { level: "rgaa", tests: ["1.1.1"], criteria: ["1.1"], unknownRgaaTags: [], bestPractice: false, experimental: false, deprecated: false }
```

`isDirectCheck(mapping)` dit si une règle **vérifie directement** un critère : niveau `rgaa`, et ni bonne pratique, ni expérimentale, ni dépréciée. C’est la seule source de vérité : seule une telle règle peut signaler une non-conformité dans la CLI, et seule elle compte comme couverture sur le site. `criteriaWithDirectRule(rulesTags)` renvoie les critères ainsi couverts : 27 avec axe-core 4.14.0, donc 79 critères sur 106 sans aucune vérification automatique directe.

axe-core n’est qu’une dépendance de développement, épinglée : les tests vérifient sur toutes ses règles que chaque étiquette RGAA désigne un test existant, et figent le décompte par niveau (axe-core 4.14.0 : 67 `rgaa`, 8 `wcag`, 30 `hors-rgaa`). Une montée de version se lit donc dans le diff des tests.

## Audit guidé : session et import des résultats automatiques

`audit-session.ts` est le modèle pur d’un audit manuel (ADR-0013). Il n’embarque pas le référentiel, pour que l’îlot de `/audit/` reste léger. La session (`schemaVersion: 2`) range `evaluations[critère][pageId]` = `{ status, note, source }` et `findings[critère][pageId]` = indices automatiques. `source` vaut `humain` (par défaut) ou `auto`. Une session v1 relue par `parseSession` est migrée sans perte : toutes ses évaluations sont humaines, et elle n’a aucun indice.

`audit-report.ts` porte la forme du JSON v2 de la CLI (`AuditReport`, partagé par la CLI qui l’écrit et le site qui le relit) et son import (ADR-0014) :

```ts
import { importAutomaticResults, MAX_REPORT_BYTES, parseAuditReport } from "@rampe/core/audit-report";

// file.size <= MAX_REPORT_BYTES (20 Mo) vérifié AVANT lecture ; JSON.parse est la seule désérialisation.
const report = parseAuditReport(JSON.parse(text), new Set(rgaa.criteria.map((c) => c.id))); // lève une erreur sinon
const { session: next, summary } = importAutomaticResults(session, report);
// summary : { pagesAdded, statusesSet, findingsAdded, pagesSkipped: [{ url, reason }] }
```

- `parseAuditReport` valide par liste blanche, tout ou rien (OWASP *Input Validation* et *Deserialization Cheat Sheets*). Elle vérifie `schemaVersion` 2 et `tool.name` `@rampe/cli`, puis, pour chaque champ utilisé, son type et ses bornes : URL http(s) d’un seul site, critères existants dans le référentiel passé en paramètre, classes connues, textes bornés et débarrassés des caractères de contrôle et bidi. Elle refuse les clés `__proto__`, `constructor` et `prototype` à toute profondeur, ainsi qu’une imbrication anormale, et ignore les propriétés inconnues. Le message d’erreur nomme le premier défaut (« pages[0].results[2].criteria[0] : critère "99.1" inexistant dans le référentiel »).
- `importAutomaticResults` est pure. Une non-conformité ne fixe « Non conforme » (`source: "auto"`, note générée) que sur une évaluation encore « non testé » et sans note. Tous les résultats sont rangés comme indices. Une évaluation humaine n’est jamais modifiée. Les pages sont rapprochées par adresse normalisée (`urlKey`). Un rapport d’un autre site est refusé. Réimporter le même rapport ne change rien.

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

## Synchronisation automatique

Le workflow `.github/workflows/sync-rgaa.yml` (ADR-0009) tourne chaque lundi à 06:17 UTC, depuis `main` uniquement,, et à la demande depuis l’onglet Actions avec un `ref` DINUM facultatif. Il lance :

```sh
node packages/core/scripts/sync-rgaa.mjs <ref> --if-changed
```

Avec `--if-changed`, le script compare les trois JSON téléchargés aux fichiers du dépôt. S’ils sont identiques octet pour octet, il n’écrit rien et affiche « Référentiel inchangé » : un commit DINUM qui ne touche que leur site ne produit pas de PR. La version du RGAA, si elle n’est pas donnée, est reprise de `source.json`. Le commit demandé doit appartenir à l’historique de `main` du dépôt DINUM, sinon le script s’arrête en erreur. Sous GitHub Actions, il écrit `changed`, `sha` et `previous` dans `$GITHUB_OUTPUT`.

Si le contenu a changé, le workflow pousse une branche `chore/sync-rgaa-<sha court>`, ouvre une PR, puis déclenche `ci.yml` sur cette branche pour que le check `check` s’y attache (une PR ouverte avec le `GITHUB_TOKEN` ne déclenche pas `pull_request`). Il est idempotent : après un échec partiel, il ne recrée que ce qui manque (branche, PR, exécution de la CI) et n’ouvre jamais de doublon. Le relecteur **confirme la version du RGAA** dans `source.json`, relit le diff des données, et la PR suit le flux normal : jamais de merge automatique.

Dependabot (`.github/dependabot.yml`) surveille de son côté les dépendances npm et les actions GitHub chaque semaine ; axe-core a sa propre PR, puisque sa montée change la correspondance RGAA.

## Exception connue

La note technique du critère 5.1 contient un lien `#table-descriptions-techniques` qui ne mène à aucune entrée du glossaire : c’est une ancre de la spécification HTML du WHATWG, laissée en lien relatif dans la source. Elle est listée explicitement dans les tests (`KNOWN_DANGLING_ANCHORS`) ; tout autre lien non résolu les fait échouer.
