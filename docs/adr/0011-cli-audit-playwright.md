---
title: "ADR-0011 — CLI d’audit : Playwright + axe-core, résultats rangés par critère RGAA, sans aucun score"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La phase 2 apporte l’audit automatique d’un site réel. axe-core doit tourner **dans un vrai navigateur** : les contrastes, la visibilité et les noms accessibles dépendent du rendu, CSS et JavaScript compris. Les premiers utilisateurs de la CLI sont des développeurs et des agences (voir `vision.md`). Les PME auront plus tard une interface sans installation (phases 3 et 5).

## Décision

1. Nouveau paquet **`packages/cli`** (`@rampe/cli`, binaire `rampe`), en Node 22, avec le parseur d’arguments natif `node:util` `parseArgs` : aucune dépendance pour ça.
2. **Moteur** : Playwright (Chromium) charge la page, puis axe-core 4.14.0 est injecté et exécuté avec sa **configuration par défaut**, c’est-à-dire sans les règles expérimentales. La version d’axe est la même que celle de `@rampe/core` et du site.
3. **Classement des résultats**, avec `classifyAxeRule` de `@rampe/core` (ADR-0008) et la règle d’honnêteté de l’ADR-0002 :

   <!-- Tableau en HTML pour lui associer un titre (<caption>, critère RGAA 5.4) ; contenu identique au tableau Markdown d’origine. -->
   <table>
   <caption>Classement des résultats axe-core</caption>
   <thead><tr><th>Résultat axe</th><th>Rattachement</th><th>Présenté comme</th></tr></thead>
   <tbody>
   <tr><td>violation</td><td>direct (<code>rgaa</code>), règle ni bonne pratique ni expérimentale</td><td><strong>Non-conformité détectée</strong> au(x) test(s) cité(s)</td></tr>
   <tr><td>violation</td><td>direct (<code>rgaa</code>), règle bonne pratique ou expérimentale</td><td><strong>Problème détecté, rattachement incertain</strong> (« à confirmer par un humain »)</td></tr>
   <tr><td>violation</td><td>indirect (<code>wcag</code>)</td><td><strong>Problème détecté, rattachement RGAA incertain</strong></td></tr>
   <tr><td>violation</td><td><code>hors-rgaa</code></td><td><strong>Bonne pratique</strong> (hors conformité)</td></tr>
   <tr><td>incomplete</td><td>tout niveau</td><td><strong>À vérifier par un humain</strong></td></tr>
   </tbody>
   </table>

   - Les règles `deprecated` sont exclues.
   - Une règle qu’axe classe bonne pratique ou expérimentale ne prouve pas une non-conformité, même quand elle cite un test RGAA (ex. `region` et le test 9.2.1, qui ne porte que sur le balisage `header`/`nav`/`main`/`footer`) : seul un résultat certain peut être présenté comme non-conformité (ADR-0002), et le niveau `rgaa` qualifie la précision du rattachement, pas la certitude du défaut (ADR-0008). Elle ne déclenche donc jamais le code de sortie non nul. `isDirectCheck` de `@rampe/core` porte cette règle ; le site l’applique aussi pour décompter les critères couverts.
   - Le drapeau `bestPractice` est affiché.
   - **Aucun taux de conformité n’est calculé** : un audit automatique ne peut pas le donner (ADR-0002).
   - Chaque rapport rappelle combien de critères restent à vérifier à la main.
4. **Sorties** :
   - un JSON stable et versionné (`schemaVersion`), qui servira à l’import dans l’audit guidé (phase 3) ;
   - un rapport HTML autonome, sans JavaScript, lui-même accessible ;
   - un code de sortie non nul si une non-conformité est détectée, pour l’usage en CI.
5. **Tests** : des pages HTML de test, servies en local, contiennent des défauts connus (et des pages sans défaut). Un test de bout en bout lance la vraie CLI dessus. Chromium est installé en CI ; c’est gratuit.
6. **Sécurité** : la CLI tourne sur la machine de son utilisateur, contre les URL qu’il choisit.
   - Seuls `http:` et `https:` sont acceptés (pas de `file:`, `javascript:`, `data:`).
   - Chromium garde son bac à sable par défaut : **jamais** de `--no-sandbox`.
   - Le contenu de la page auditée est inséré dans le rapport HTML **échappé** : sélecteurs et extraits HTML des nœuds en défaut (OWASP *Cross Site Scripting Prevention Cheat Sheet*, règle « Output Encoding » pour le contexte HTML). Une page malveillante ne doit pas pouvoir piéger son propre rapport.

## Conséquences

- Playwright et Chromium pèsent lourd, mais seulement dans la CLI. `@rampe/core` reste pur.
- La publication npm est bloquée tant qu’il n’existe pas de compte npm (⛔ Alexandre). D’ici là, la CLI s’utilise depuis le dépôt.
- La version de Playwright suit le même délai de 7 jours que Dependabot.
