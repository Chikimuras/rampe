---
title: Workflow des agents
order: 3
---

Comment Claude construit Rampe sans intervention humaine, et où l’humain garde la main.

## Rôles

<table>
<caption>Rôles</caption>
<thead><tr><th>Rôle</th><th>Qui</th><th>Fait</th><th>Ne fait pas</th></tr></thead>
<tbody>
<tr><td><strong>Orchestrateur</strong></td><td>Session Claude principale</td><td>Choisit la prochaine tâche de la roadmap, écrit les ADR, découpe, délègue, merge</td><td>N’écrit pas le gros du code</td></tr>
<tr><td><strong>Implémenteur</strong></td><td>Sous-agent, worktree git isolé</td><td>TDD : test qui échoue → code → <code>pnpm check</code> vert → PR</td><td>Ne merge jamais</td></tr>
<tr><td><strong>Relecteur</strong></td><td>Sous-agent neuf, sans le contexte de l’implémenteur</td><td>Relecture adversariale du diff : bugs, écarts aux ADR, sécurité. <strong>Doit avoir un shell</strong> pour exécuter tests et scripts : ce qui n’est pas exécuté reste une hypothèse</td><td>Ne corrige pas lui-même</td></tr>
</tbody>
</table>

Un relecteur qui n’a pas écrit le code n’a pas ses angles morts : c’est l’intérêt de le lancer sans contexte.

## Cycle d’une tâche

1. **Choix** — première case non cochée de la roadmap.
2. **Décision** — si la tâche engage l’architecture : ADR d’abord (statut `Accepted`, signé Claude, ADR-0001).
3. **Branche** — `feat/…`, `fix/…`, `docs/…` dans un worktree.
4. **Implémentation** — tests d’abord ; le gate local (hook Stop) bloque tant que `pnpm check` échoue.
5. **PR** — description : quoi, pourquoi, preuve (sortie des vérifs).
6. **Relecture** — relecteur adversarial ; chaque remarque est corrigée ou réfutée par écrit dans la PR.
7. **CI verte** → merge *squash* → déploiement automatique.
8. **Trace** — case cochée dans la roadmap, entrée dans le journal.

## Gates

<table>
<caption>Gates</caption>
<thead><tr><th>Gate</th><th>Exécuté par</th><th>Contenu</th></tr></thead>
<tbody>
<tr><td>Local</td><td>Hook <code>Stop</code> (<code>.claude/gate.sh</code>)</td><td><code>pnpm check</code> : Biome, typecheck, tests</td></tr>
<tr><td>Relecture</td><td>Sous-agent relecteur</td><td>Diff de la PR</td></tr>
<tr><td>Final</td><td>GitHub Actions (<code>ci.yml</code>), check requis sur <code>main</code></td><td><code>pnpm check</code> + build ; déploiement si <code>main</code></td></tr>
</tbody>
</table>

## Points d’arrêt humains

Claude s’arrête et demande uniquement pour : **une dépense**, **la création d’un compte tiers** (CGU), **un secret** à poser, **un contenu engageant juridiquement** Alexandre (mentions légales). Le veto d’Alexandre sur un ADR reste possible à tout moment.
