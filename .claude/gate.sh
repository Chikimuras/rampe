#!/usr/bin/env bash
# Gate de vérification local (hook Stop) — rejoue `pnpm check` comme la CI
# (.github/workflows/ci.yml). Working tree propre → rien à vérifier.
# Échec → exit 2 : Claude est relancé pour corriger avant de rendre la main.
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
[ -z "$(git status --porcelain=v1)" ] && exit 0

if ! out=$(pnpm check 2>&1); then
  printf 'Gate local ÉCHOUÉ — ne pas conclure sans corriger.\n%s\n' "$(printf '%s\n' "$out" | tail -40)" >&2
  exit 2
fi
exit 0
