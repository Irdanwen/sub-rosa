# Sub Rosa 1.63.0

Date : 14 septembre 2026.

## Source

- [PR de release #102](https://github.com/Irdanwen/sub-rosa/pull/102), fusionnée.
- Tag `v1.63.0` : `90f1a10045a82f6432e20a8958da6c203890d088`.
- Arbre identique au merge `7a8d55165da6d7593ecf6297ff7cb9fe28c30fc5`.
- Tous les contrôles de la PR sont passés : frontend, couverture, Rust,
  Windows, iOS appareil/simulateur, serveur PostgreSQL et conteneur, site,
  dépendances et détection de secrets.
- Les fixtures OIDC créent leur clé RSA en mémoire ; aucune clé privée
  de test n'est conservée dans la source livrée.

## TestFlight

[Envoi iOS](https://github.com/Irdanwen/sub-rosa/actions/runs/34842160590)
terminé avec succès. L'app et son extension de partage portent la version
et le numéro de build `1.63.0`. Export signé réussi, puis
`UPLOAD SUCCEEDED with no errors` le 14 septembre à 12:28:20 UTC.

La [lecture de l'état Apple](https://github.com/Irdanwen/sub-rosa/actions/runs/34844129966)
à 12:34 UTC confirme `processingState=VALID`, mais
`internalBuildState=MISSING_EXPORT_COMPLIANCE` et
`externalBuildState=MISSING_EXPORT_COMPLIANCE`. Le build est reçu et valide ;
il n'est pas encore disponible aux testeurs.

Une [seconde lecture Apple](https://github.com/Irdanwen/sub-rosa/actions/runs/34847985711)
à 13:14 UTC confirme le même état et aucune déclaration existante pour
l'application (`total=0`, aucune page suivante). Le
[descriptif de chiffrement](testflight-encryption-1.63.0.md) est préparé pour
compléter la déclaration réelle. Ces lectures n'ont modifié aucune donnée Apple.

L'archive iOS a démarré sur `6395538c9c114d6b9a4f6cca0c51c7794b7f20cc`.
Les changements suivants concernent les fixtures du serveur et le déplacement
du module de tests des réglages Carpe Diem, sans changement du comportement
de l'application. Aucun second upload du même numéro n'a été lancé.

L'ancienne exemption automatique iOS a été retirée parce que le coffre ajoute
AES-256-GCM dans Rust au-delà de TLS. La déclaration réelle doit être complétée
dans App Store Connect avant distribution ; voir [HANDOFF](../HANDOFF.md).
Aucun code d'approbation ou document d'exemption n'a été inventé.

## Desktop

Le [premier build](https://github.com/Irdanwen/sub-rosa/actions/runs/34843579606)
a réussi, mais l'inspection de son DMG Intel a détecté un défaut du pipeline
existant : le sidecar était x86_64 et le Python embarqué arm64. Cette archive
n'a pas été publiée. La [PR #103](https://github.com/Irdanwen/sub-rosa/pull/103)
remplace la compilation croisée par un runner Intel natif et vérifie tous les
Mach-O du runtime avant signature. Le label du runner est documenté par
[GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

La [reconstruction](https://github.com/Irdanwen/sub-rosa/actions/runs/34846232055)
utilise le workflow corrigé `1c5bdbd12c64679621759f0da04e7507499d59a5`, qui
checkout le même tag applicatif `v1.63.0`. Aucun tag n'a été déplacé.
Le workflow est terminé avec succès. La
[release publique 1.63.0](https://github.com/Irdanwen/sub-rosa-releases/releases/tag/v1.63.0)
a été publiée le 14 septembre à 14:05:50 UTC, après ces vérifications :

- Deux DMG montés en lecture seule et démontés après contrôle : 65 binaires
  natifs compatibles ARM et 67 compatibles Intel, version et bundle ID corrects.
- Signature profonde stricte, équipe `H6N5V777LL`, acceptation Gatekeeper et
  ticket de notarisation agrafé validés pour les deux apps Mac.
- Seuils macOS vérifiés dans les binaires Intel : 14.0 pour l'app et le runtime,
  avec le seuil 14.2 déjà prévu pour le helper d'audio système.
- Empreinte SHA-256 et taille des neuf assets comparées aux fichiers GitHub.
- Trois signatures de mise à jour vérifiées avec la clé publique de l'app,
  puis correspondance des plateformes, URL et signatures dans `latest.json`.
- Accès public aux trois installateurs vérifié ; le manifeste public `latest`
  correspond exactement à celui contrôlé et contient les notes de release.

Notarisations acceptées : ARM `318ca4ea-d704-4c51-a8e6-494faa16bcdc`,
Intel `4fd95b63-a9b3-44ad-9e91-c3df654f6409`. L'installateur Windows reste
volontairement non signé par certificat, avec une signature updater vérifiée.
Ces contrôles de distribution ne remplacent pas un essai physique Mac/iPhone.

## Site

L'aperçu privé [Sub Rosa](https://sub-rosa.ardanwen.chatgpt.site) est déployé en
version 5, en anglais avec la charte Carpe Diem. Ses trois téléchargements,
tailles et empreintes proviennent de la release publique 1.63.0. Build statique,
types et prérendu réussis. Source du site :
`7927dce43117669c77239ce06cb1759e7d7c1748` ; déploiement
`appgdep_6aa7ffa82f448191a34e8a5645091fdc`, confirmé à 14:07:48 UTC.
L'accès reste limité au propriétaire ; cette publication n'héberge pas le
service de comptes.

## Disponibilité des comptes

La release ajoute la prise en charge facultative d'un service de comptes HTTPS.
L'inscription publique n'est pas ouverte. Le mode local et la clé Carpe Diem
existante restent utilisables. Les limites détaillées figurent dans le
[dossier de livraison](accounts-delivery-2026-09-14.md).
