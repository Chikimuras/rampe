---
title: "ADR-0023 — La CLI refuse d’attribuer un audit à une autre page : détection de toute navigation pendant l’analyse"
status: Accepted
date: 2026-10-20
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

L’ADR-0020 §5 ne détectait une navigation pendant l’analyse que par la **destruction du monde isolé**, c’est-à-dire au moment où le nouveau document est validé (commit). Sous charge, ce commit peut arriver après la fin d’axe : l’analyse porte alors sur l’ancien document, mais `page.url()` lit déjà la nouvelle adresse.

C’est le défaut que la PR #30 a reproduit de façon déterministe. **Le rapport attribuait les défauts d’une page à une autre URL.** Une relecture adversariale a mesuré 27 attributions erronées sur `main`, et 0 avec le correctif.

## Décision

1. **Toute requête de navigation du cadre principal** émise pendant l’analyse (`isNavigationRequest()`, cadre principal uniquement) interrompt l’audit de la page. Le code de sortie est 2, avec le message « La page a navigué pendant l’analyse : audit impossible. ». Les iframes, `fetch`, XHR, préchargements et Service Workers ne sont pas concernés.
2. **L’adresse du document analysé** est lue par `location.href` dans **la même évaluation isolée** qu’axe et le titre. Elle devient `finalUrl`. Elle est comparée à `page.url()` après l’analyse, **une fois retirés de part et d’autre les identifiants** (utilisateur, mot de passe) **et le fragment** (`#…`). Tout écart signifie que la page a changé d’adresse, et l’audit est interrompu.
3. **Comportement strict assumé**, et documenté dans le README de la CLI : un `history.pushState` ou `replaceState`, ou une navigation vers une pièce jointe déclenchée **pendant** l’analyse, interrompt l’audit. Rampe préfère « audit impossible, relancez » à un rapport qui risquerait d’être attribué à la mauvaise page. Les mêmes actions **avant** l’analyse (au chargement) restent acceptées : l’adresse finale est alors celle qui est effectivement analysée.
4. **Changement d’ancre** : modifier seulement le fragment ne change pas de document. Ce n’est pas une navigation au sens de cette décision.

## Conséquences

- Un rapport de la CLI porte toujours l’adresse du document réellement analysé.
- Certaines pages très dynamiques demanderont une relance. Le message l’explique.
- Cet ADR complète l’ADR-0020 §5, déjà fusionné et donc non réécrit, comme le veut l’ADR-0001.
