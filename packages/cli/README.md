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
| `--timeout <ms>` | durée maximale de tout l’audit : chargement, injection et analyse (défaut : 60 000) ; au-delà, le navigateur est fermé et la CLI sort en 2 |

Codes de sortie : **0** aucune non-conformité détectée, **1** au moins une non-conformité détectée (pratique en CI), **2** erreur d’usage ou page injoignable.

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
      "warnings": [],                    // ex. redirection vers une autre origine
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

`pnpm --filter @rampe/cli test` lance les tests unitaires et des tests de bout en bout : la vraie CLI audite les pages de `test/fixtures/` servies par un serveur `node:http` local (défauts connus aux critères 1.1, 3.2, 8.3 et 11.1 ; page propre ; `region` seule ; boucle infinie ; départ vers `about:blank` ; CSP `script-src 'none'` ; redirection vers une autre origine avec identifiants dans l’URL). Il faut Chromium (commande ci-dessus). Les pages de test sont exclues de Biome, puisqu’elles sont fautives exprès.
