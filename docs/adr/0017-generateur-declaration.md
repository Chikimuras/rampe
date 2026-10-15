---
title: "ADR-0017 — Déclaration d’accessibilité : le format officiel à la lettre, l’état déduit de l’audit, rien d’inventé"
status: Accepted
date: 2026-10-15
deciders: "Claude (délégation, ADR-0001)"
---

## Contexte

La déclaration d’accessibilité est un document **juridiquement engageant pour l’organisme qui la publie** : c’est l’utilisateur de Rampe, pas Rampe. La DINUM en impose le format (dépôt `DISIC/accessibilite.numerique.gouv.fr`, `src/obligations/declaration-accessibilite.md`, section « La déclaration d’accessibilité adopte obligatoirement ce format »), et en fixe les règles :
- **état de conformité** :
  - « totalement » si tous les critères sont respectés ;
  - « partiellement » si au moins 50 % le sont ;
  - « non conforme » si moins de 50 % le sont, **ou s’il n’existe aucun résultat d’audit en cours de validité** ;
- signalement des contenus non accessibles, en distinguant les non-conformités, les dérogations pour charge disproportionnée (motivées) et les contenus exemptés ;
- dispositif de contact ;
- voies de recours auprès du Défenseur des droits ;
- validité : mise à jour lors d’une refonte, **3 ans** après la publication, ou **18 mois** après une nouvelle version du référentiel.

## Décision

1. **Gabarit officiel reproduit à la lettre** (Licence Ouverte 2.0, source citée). Seuls les champs entre crochets sont remplis. Les phrases imposées ne sont jamais reformulées.
2. **Ce que Rampe remplit lui-même, depuis l’audit guidé** :
   - l’**état de conformité** par la règle officielle, appliquée au taux global calculé par l’ADR-0015 ;
   - le pourcentage de critères respectés ;
   - le taux moyen, facultatif dans le modèle ;
   - la liste des pages vérifiées ;
   - la liste des critères non conformes, avec leur titre officiel et les pages concernées, en point de départ du paragraphe « Non conformité » ;
   - la date d’établissement, **figée dans la session au premier téléchargement ou à la première copie** (modifiable par l’utilisateur) : une déclaration ne change pas de date à chaque export. La date de mise à jour reste saisie à la main.

   Choix imposés parce que Rampe audite un **site web**, parmi les options entre crochets du gabarit :
   - « site internet » (contact) et « du site web » (technologies) ;
   - le référentiel « le référentiel général d’amélioration de l’accessibilité (RGAA), version x.y.z », version tirée du référentiel de l’audit ;
   - le taux moyen, facultatif dans le modèle, est rempli dès qu’il est calculé (ADR-0015) ;
   - le motif d’un état « non conforme » sans mesure (audit incomplet, aucun critère applicable) prend la place du passage « Détailler ici les résultats des tests ».

   L’interface rappelle cette liste.

   **Si l’audit est incomplet** (ADR-0015 §2), aucune déclaration « totalement » ou « partiellement » n’est générée. L’état ne peut être que « non conforme », avec le motif « aucun résultat d’audit complet ». C’est exactement la règle officielle.
3. **Ce que Rampe ne remplit jamais à la place de l’utilisateur** : nom de l’organisme, nom du service, réalisation de l’audit (en interne ou par un prestataire), dérogations et leurs motifs, contenus exemptés, technologies, environnement de test, outils, contacts, lien vers le schéma pluriannuel.
   - Ces champs sont saisis dans un formulaire. Tant qu’ils sont vides, l’aperçu les affiche entre crochets, visiblement à compléter.
   - Rampe ne déduit **pas** si l’organisme est soumis à l’obligation (champ d’application) : il renvoie vers la page officielle.
4. **Sortie** :
   - un aperçu HTML accessible ;
   - deux exports à copier ou télécharger : **HTML sémantique** prêt à publier, et **Markdown** ;
   - aucun envoi réseau ;
   - les données saisies sont rangées dans la session d’audit, donc sauvegardées et exportées avec elle (ADR-0016).
5. **Rappels affichés** : la validité (3 ans, 18 mois, refonte) et le fait que la déclaration engage l’organisme qui la publie, Rampe ne faisant que la mettre en forme.
6. **Sécurité** : toutes les saisies sont **échappées** dans l’HTML produit (OWASP *XSS Prevention Cheat Sheet*, « Output Encoding »). Les URL de contact sont limitées à http(s) et `mailto:`.

## Conséquences

- Une PME passe de son audit à une déclaration conforme au format officiel sans rien inventer, et sait exactement ce qu’elle doit encore compléter.
- Le schéma pluriannuel (tâche suivante) sera rattaché ici par lien.
- Si le gabarit officiel change, la synchro hebdomadaire du dépôt DINUM (ADR-0009) ne couvre que les JSON du référentiel. Ce gabarit est copié et figé, avec la date de copie ; le surveiller fera l’objet d’une tâche ultérieure.
