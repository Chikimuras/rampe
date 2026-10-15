# @rampe/cli

Audit automatique d’une page web, avec les résultats rangés par **critère RGAA** (ADR-0011). Le moteur est axe-core 4.14.0, exécuté dans un vrai Chromium par Playwright : les contrastes, la visibilité et les noms accessibles dépendent du rendu.

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
| `--timeout <ms>` | délai maximal de chargement de la page (défaut : 30 000) |

Codes de sortie : **0** aucune non-conformité détectée, **1** au moins une non-conformité détectée (pratique en CI), **2** erreur d’usage ou page injoignable.

## Ce que fait l’audit

1. Seules les adresses `http://` et `https://` sont acceptées.
2. Chromium headless, bac à sable activé (jamais `--no-sandbox`), charge la page : événement `load`, puis jusqu’à 5 s de réseau calme.
3. axe-core est injecté et lancé avec sa configuration par défaut (sans règles expérimentales). Seul le cadre principal est analysé : le contenu des iframes ne l’est pas encore.
4. Chaque résultat est classé avec `classifyAxeRule` de `@rampe/core` (ADR-0008) :

| Résultat axe | Rattachement | `kind` | Présenté comme |
|---|---|---|---|
| violation | direct (`rgaa`) | `non-conformite` | non-conformité détectée, avec les tests RGAA cités |
| violation | indirect (`wcag`) | `incertain` | problème détecté, rattachement RGAA incertain |
| violation | `hors-rgaa` | `bonne-pratique` | bonne pratique, hors conformité |
| incomplete | tout niveau | `a-verifier` | à vérifier par un humain |

Les règles dépréciées par axe sont exclues. Le drapeau « bonne pratique d’axe » reste affiché, même sur une non-conformité (ex. `region`, rattachée au critère 9.2).

## Ce que l’outil ne fait pas

- **Aucun score ni taux de conformité** (ADR-0002) : un audit automatique ne vérifie directement qu’une minorité des critères. Chaque rapport rappelle combien des 106 critères n’ont aucune vérification automatique directe (77 avec axe-core 4.14.0) : l’audit humain reste indispensable.
- **Aucune certification**, et aucune modification du site audité.
- Une seule page par audit pour l’instant ; l’échantillon de pages et le rapport HTML viendront ensuite.

## Format JSON (`schemaVersion: 1`)

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "@rampe/cli", "version": "0.0.0" },
  "engine": { "axe": "4.14.0", "browser": "156.0.8078.4" },
  "startedAt": "2026-10-15T09:25:01.779Z",
  "pages": [
    {
      "url": "https://exemple.fr/",
      "finalUrl": "https://exemple.fr/",   // après redirections
      "title": "Accueil",
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

`html` est tronqué à 500 caractères. `pages` est un tableau pour accueillir l’audit de plusieurs pages.

## Tests

`pnpm --filter @rampe/cli test` lance les tests unitaires et un test de bout en bout : la vraie CLI audite `test/fixtures/defauts.html` (défauts connus aux critères 1.1, 3.2, 8.3 et 11.1) et `test/fixtures/propre.html`, servies par un serveur `node:http` local. Il faut Chromium (commande ci-dessus). Les pages de test sont exclues de Biome, puisqu’elles sont fautives exprès.
