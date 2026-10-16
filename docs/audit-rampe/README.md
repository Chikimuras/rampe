# Rampe audité par Rampe

Deux étapes distinctes (ADR-0021) :

1. **Gate automatique** (`pnpm audit:rampe`, `scripts/audit-rampe.mjs`) : la CLI audite en `--strict` toutes les pages construites (thèmes clair et sombre) et l’échantillon en 375 px. Voir l’ADR-0021 §1.
2. **Auto-évaluation complète** (`pnpm auto-evaluation`, `scripts/auto-evaluation.mjs`) : les 106 critères sur chaque page de l’échantillon, évalués par une IA (Claude). **Elle n’est pas certifiée et ne remplace pas un audit humain.**

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `echantillon.txt` | Échantillon de pages (ADR-0012), périmètre des deux étapes. |
| `evaluations/<n>.json` | Un fragment par thématique RGAA (`1.json` … `13.json`), écrit par l’évaluateur. |
| `session.json` | **Généré** par `pnpm auto-evaluation` : ne pas le modifier à la main. |

`session.json` est une session de l’audit guidé (format de l’ADR-0016) : on peut l’importer dans `/audit/` (champ « Importer un audit (JSON) ») pour relire chaque évaluation et sa justification. La CI lance `pnpm auto-evaluation --verifier`, qui échoue si `session.json` ne correspond pas exactement aux fragments.

Total attendu : **106 critères × nombre de pages de l’échantillon** (11 pages aujourd’hui, soit 1 166 évaluations). Le taux de conformité (ADR-0015) n’est calculé et affiché qu’une fois toutes les évaluations présentes.

## Format d’un fragment

```json
{
	"evaluator": "Claude (IA)",
	"date": "2026-10-17",
	"entries": [
		{
			"criterion": "1.1",
			"page": "https://chikimuras.github.io/rampe/",
			"status": "NA",
			"note": "Tests 1.1.1 à 1.1.8 : la page ne contient ni <img>, ni <svg>, ni <area>, ni <object>, ni <embed>, ni <canvas>, ni <input type=\"image\"> (DOM du build examiné). Aucune image : non applicable."
		}
	]
}
```

Validation stricte (`parseFragment`, `packages/core/src/auto-evaluation.ts`), tout ou rien :

- nom du fichier : `<thématique>.json`, 1 à 13 ; tout autre fichier du dossier est refusé ;
- clés autorisées seulement (`evaluator`, `date`, `entries` ; `criterion`, `page`, `status`, `note`), `__proto__`, `constructor` et `prototype` refusées partout ;
- `evaluator` : exactement `"Claude (IA)"` ; `date` : `AAAA-MM-JJ` qui existe au calendrier ;
- `criterion` : critère du référentiel, **de la thématique du fichier** ;
- `page` : une adresse de `echantillon.txt`, écrite exactement comme elle (forme normalisée, avec la barre finale) ;
- `status` : `C`, `NC` ou `NA` (jamais `NT` : une évaluation absente est « non testée ») ;
- `note` : non vide, au plus 10 000 caractères, sans caractère de contrôle ni de direction, et **citant au moins un test du critère** par son numéro (`1.1.1`) ;
- au plus une entrée par couple (critère, page).

## Construction de la session

- Pages : celles de l’échantillon, dans son ordre ; titre : le chemin de l’adresse.
- **Id de page déterministe** : UUID version 8 (RFC 9562 §5.8) tiré des 128 premiers bits du SHA-256 de l’adresse. Même adresse, même id : les fragments ne contiennent jamais d’id, et un ajout de page ne change pas ceux des autres.
- Évaluations : posées avec les opérations de `@rampe/core` (`setEvaluation`, source `humain` au sens du modèle : elles ne sont pas « à confirmer »), dans l’ordre du référentiel puis de l’échantillon, quel que soit l’ordre des entrées.
- Dates : `createdAt` = 2026-10-16 (début de l’auto-évaluation), `updatedAt` = date du fragment le plus récent. Deux constructions des mêmes fragments donnent le même fichier, octet pour octet.

## Règles d’évaluation (pour l’évaluateur)

- Suivre, pour chaque critère, **les tests et la méthodologie officiels** du référentiel (fiche `/referentiel/<critère>/`), et rien d’autre.
- Chaque entrée porte une **justification précise** : au moins une phrase, qui cite le ou les tests appliqués, les éléments examinés (balises, composants, contenus) et l’observation qui fonde le statut.
- **NA** seulement si le contenu visé par le critère **n’existe pas sur la page** (méthode RGAA, « Test des pages »). La justification dit ce qui a été cherché et pas trouvé.
- **NC** dès qu’**un seul** élément de la page échoue à un test ; la justification nomme l’élément en défaut.
- **C** sinon : tous les éléments concernés passent tous les tests applicables.
- Évaluer chaque page de l’échantillon pour elle-même, telle que la sert le build de production, en thème clair et en thème sombre quand le critère porte sur la présentation (couleurs, contrastes).
- Après modification d’un fragment : `pnpm auto-evaluation`, puis committer le fragment **et** `session.json`.
