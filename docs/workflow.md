---
title: Workflow des agents
order: 3
---

Comment Claude construit Rampe sans intervention humaine, et où l’humain garde la main.

## Rôles

| Rôle | Qui | Fait | Ne fait pas |
|---|---|---|---|
| **Orchestrateur** | Session Claude principale | Choisit la prochaine tâche de la roadmap, écrit les ADR, découpe, délègue, merge | N’écrit pas le gros du code |
| **Implémenteur** | Sous-agent, worktree git isolé | TDD : test qui échoue → code → `pnpm check` vert → PR | Ne merge jamais |
| **Relecteur** | Sous-agent neuf, sans le contexte de l’implémenteur | Relecture adversariale du diff : bugs, écarts aux ADR, sécurité. **Doit avoir un shell** pour exécuter tests et scripts : ce qui n’est pas exécuté reste une hypothèse | Ne corrige pas lui-même |

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

| Gate | Exécuté par | Contenu |
|---|---|---|
| Local | Hook `Stop` (`.claude/gate.sh`) | `pnpm check` : Biome, typecheck, tests |
| Relecture | Sous-agent relecteur | Diff de la PR |
| Final | GitHub Actions (`ci.yml`), check requis sur `main` | `pnpm check` + build ; déploiement si `main` |

## Points d’arrêt humains

Claude s’arrête et demande uniquement pour : **une dépense**, **la création d’un compte tiers** (CGU), **un secret** à poser, **un contenu engageant juridiquement** Alexandre (mentions légales). Le veto d’Alexandre sur un ADR reste possible à tout moment.
