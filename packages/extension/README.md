# @rampe/extension

Extension navigateur (Chromium et Firefox, Manifest V3) qui analyse **la page ouverte dans l’onglet courant** avec axe-core 4.14.0 et range les résultats par critère RGAA, avec la même logique que la CLI (ADR-0019, ADR-0011). Elle analyse la page telle que vous la voyez, y compris derrière une connexion.

> ⛔ **Publication en attente.** L’extension n’est pas encore dans le Chrome Web Store ni sur addons.mozilla.org : il faut des comptes (Mozilla : gratuit ; Chrome : 5 $). D’ici là, elle s’installe à la main, comme ci-dessous.

## Installation manuelle

Construire l’extension depuis le dépôt (ou prendre l’archive `rampe-extension.zip` produite par la CI, artefact du workflow « CI ») :

```sh
pnpm install
pnpm --filter @rampe/extension build   # dist/ (non empaquetée) et rampe-extension.zip
```

### Chrome, Edge et autres navigateurs Chromium

1. Ouvrir `chrome://extensions` (Edge : `edge://extensions`).
2. Activer le **mode développeur**.
3. Cliquer sur **« Charger l’extension non empaquetée »** et choisir le dossier `packages/extension/dist` (ou le dossier où vous avez décompressé l’archive).

Chrome signale la clé `browser_specific_settings` comme inconnue : elle ne sert qu’à Firefox, l’avertissement est sans effet.

### Firefox (140 ou plus récent)

1. Ouvrir `about:debugging#/runtime/this-firefox`.
2. Cliquer sur **« Charger un module complémentaire temporaire… »** et choisir `packages/extension/dist/manifest.json` (ou l’archive `.zip`).

Le module reste chargé jusqu’à la fermeture de Firefox. Son identifiant, `extension@rampe.invalid`, est **factice** (domaine réservé `.invalid`) : Firefox l’exige en Manifest V3, et le vrai sera attribué à la publication.

## Utilisation

1. Ouvrir la page à analyser.
2. Cliquer sur l’icône de Rampe dans la barre d’outils, puis sur **« Analyser cette page »**.
3. Lire les résultats, groupés par critère RGAA dans les catégories de la CLI : non-conformité détectée, rattachement incertain, à vérifier par un humain, bonne pratique.
4. **« Télécharger le rapport (JSON) »** produit un rapport v2, de la même structure que celui de la CLI (`tool.name` : `@rampe/extension`). Il s’importe dans l’audit guidé du site, champ « Importer un rapport automatique (CLI ou extension, JSON) » (ADR-0014).

> **Avant de partager un rapport, relisez-le.** Il contient l’adresse de la page **avec ses paramètres** (la partie après `?`, gardée parce qu’elle peut être nécessaire pour retrouver la page) et des **extraits du code de la page**, jusqu’à 500 caractères par élément en défaut : ils peuvent contenir des données personnelles (nom affiché, adresse e-mail, numéro de dossier…). Le fragment (`#…`) et les identifiants éventuels de l’adresse sont retirés (OWASP *User Privacy Protection Cheat Sheet*). Le panneau rappelle cet avertissement à côté du bouton.

Aucun score n’est calculé : les 106 critères demandent une vérification humaine, et une partie n’a aucune vérification automatique directe (le panneau donne le nombre).

## Ce qu’elle fait, et ce qu’elle ne fait pas

- **Permissions : `activeTab` et `scripting`, rien d’autre.** Aucune permission d’hôte, aucun script de contenu permanent, aucun script de fond, aucun accès à l’historique, aux onglets ou aux cookies. L’extension n’agit que sur l’onglet courant, **au clic** sur son icône : sans ce clic, elle ne voit même pas l’adresse de l’onglet.
- **Aucune donnée envoyée.** Aucun appel réseau, aucune télémétrie, aucun stockage distant. La CSP des pages de l’extension (`default-src 'none'; script-src 'self'; object-src 'none'…`) interdit toute connexion depuis le panneau, et le rapport est un fichier construit dans le navigateur. Firefox affiche « aucune collecte de données » (`data_collection_permissions`).
- **axe-core est embarqué** (`axe.min.js`, copié tel que publié, avec sa licence MPL-2.0), jamais chargé à distance. Il s’exécute dans le monde isolé de l’extension : la page analysée ne peut ni le lire ni le modifier.
- **Pages refusées** avec un message clair : pages internes du navigateur (`chrome://`, `about:`…), pages d’extensions, fichiers locaux (`file://`), magasins d’extensions, et documents qui ne sont pas du HTML (`document.contentType` autre que `text/html` ou `application/xhtml+xml` : PDF, image, texte brut…).
- **Délai maximal** : une analyse s’arrête au bout de 60 secondes (page bloquée par un script), avec un message ; le bouton redevient utilisable. Une page qui change pendant l’analyse (navigation, fermeture) donne « La page a changé pendant l’analyse : relancez-la. », avec le message technique du navigateur replié sous « Détail technique ».
- **Version du navigateur** dans le rapport (`engine.browser`) : sous Chromium, la version complète (`navigator.userAgentData`, ex. « Chrome 156.0.8078.4 », comparable à celle de la CLI) ; à défaut, celle de l’agent utilisateur, que Chromium réduit (« Chrome 156.0.0.0 ») ; sous Firefox, celle de l’agent utilisateur (« Firefox 140.0 »).
- Les textes venus de la page (titre, sélecteurs, descriptions) sont affichés comme du texte, jamais interprétés comme du HTML.
- Limite : seul le cadre principal est analysé (comme la CLI), pas le contenu des `iframe` ; le résumé le signale quand axe en trouve (règle `frame-tested`).

## Développement

- `src/report.ts` : refus des pages, rapport v2, regroupement par critère, délai, messages d’erreur (logique pure, classement par `@rampe/core`). Le panneau n’importe que les points d’entrée légers de `@rampe/core` (`axe-results`, `criteres`, `sample-file`, `audit-report`) : ni glossaire ni méthodologies (`popup.js` : 189 Ko, 34 Ko en gzip) ;
- `src/popup.ts`, `src/popup.html`, `src/popup.css` : le panneau ;
- `public/manifest.json` : le manifeste ;
- `vite.config.ts` : build (Vite, déjà présent dans le dépôt via Astro), copie d’axe-core.

Pas de script de fond : le panneau injecte lui-même axe-core avec `chrome.scripting`, ce qui évite la différence entre `background.service_worker` (Chromium) et `background.scripts` (Firefox).

### Tests

- `test/manifest.test.ts`, `test/report.test.ts` : permissions exactes, CSP, refus d’adresses, rapport accepté par `parseAuditReport`.
- `test/extension.e2e.test.ts` : l’extension construite est chargée non empaquetée dans Chromium (Playwright, contexte persistant, nouveau mode headless). Playwright ne sait pas cliquer sur l’icône d’une extension ; le test :
  1. accorde `activeTab` à l’onglet testé comme un clic sur l’icône, par la commande CDP `Extensions.triggerAction` (drapeau `--enable-unsafe-extension-debugging`) ;
  2. ouvre `popup.html` dans un onglet et y remplace la seule fonction `chrome.tabs.query` (« quel est l’onglet courant ? ») par l’onglet testé. Le reste est réel : sans l’étape 1, le navigateur refuse l’injection, ce que le test vérifie aussi.

  Il vérifie ensuite les résultats (critères 1.1, 3.2, 8.3, 11.1), l’absence de toute requête réseau, le téléchargement du rapport et son import dans l’audit guidé (site construit pour le test), passe axe sur le panneau, en clair et en sombre, et couvre : focus après l’analyse, pas de défilement horizontal à 350, 420 et 800 px, PDF refusé, page bloquée (horloge simulée du panneau : `page.clock`), navigation pendant l’analyse. Captures facultatives : `RAMPE_CAPTURES=<dossier>`.

L’archive `rampe-extension.zip` est faite par la commande `zip` (présente sous macOS et Linux, pas sous Windows : y construire avec WSL, ou prendre l’artefact de la CI). Elle n’est pas reproductible octet pour octet (dates des fichiers) ; son contenu, lui, ne dépend que des sources.

`@rampe/site` est une dépendance de développement : pnpm lance ainsi les tests du site avant ceux-ci, et les deux builds d’Astro ne tournent pas en même temps.
