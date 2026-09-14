# Livraison comptes, synchronisation et site

Date : 14 septembre 2026. Branche : `codex/accounts-sync-site`.

## État du produit

L’implémentation est disponible dans le dépôt et validée localement. Elle n’est
pas intégrée à une version publiée de l’application et le service de comptes
n’est pas ouvert en production. Le site privé présente le produit et les
téléchargements actuels ; son écran Compte explique cette limite et ne demande
aucun secret. Les vrais parcours de compte sont testés contre le service local.

## Ce qui est implémenté

| Parcours | Réalisation |
| --- | --- |
| Inscription et connexion | Même identité OIDC pour le site et les apps, e-mail vérifié, liaison issuer/subject. La passkey dépend du fournisseur configuré. |
| Connexion d’une app | Navigateur, code vérifié explicitement, échange à usage unique lié au vérificateur, accès court et refresh rotatif dans le trousseau. |
| Coffre | Création locale, kit de récupération confirmé, AES-GCM authentifié, protocole partagé Rust/navigateur. |
| Autre appareil | Association QR/code à usage unique ; enveloppe chiffrée, expiration, autorisation explicite. |
| Clé Carpe Diem | Configuration chiffrée, restauration après validation gratuite authentifiée, URL et clé activées ensemble. |
| Bibliothèque | Notes, dossiers, transcriptions, mémoires, historiques et fichiers pris en charge par le manifeste natif ; aucune copie brute de la base. |
| Conversations | Historique visible Hermes/agent-lite portable, backfill borné, continuation volontaire dans le runtime de l’appareil receveur. |
| Réseau interrompu | Outbox et curseur transactionnels, opérations idempotentes, variantes conservées, résolution explicite distribuée. |
| Fichiers | Blocs chiffrés immuables, téléchargement reprenable, empreinte vérifiée, chemins reconstruits localement. |
| Statistiques | Tentatives et volumes par jour/modèle/appareil ; mesures de tokens/coût effectivement reçues ; solde fournisseur daté. Couverture partielle annoncée. |
| Révocation/suppression | Contrôle de session à chaque requête, refresh rejoué révoquant sa famille, effacement inscrit dans un ledger indépendant signé avant suppression. |
| Site | Français/anglais, pages publiques prérendues, téléchargements vérifiés, compte, appareils, sécurité, consommation, aide et confidentialité. |

## Vérifications réalisées

- Suite frontend complète : 256 fichiers, 4 122 tests réussis, 2 tests préexistants
  ignorés. Les correctifs ultérieurs disposent aussi de tests ciblés.
- Dernier lot ciblé après revue : 47 tests réussis, vérification des types,
  formatage/lint et catalogue de 2 947 phrases sans traduction manquante.
- Natif : 819 tests de bibliothèque réussis, test live exécuté séparément ;
  Clippy strict et compilations iOS appareil/simulateur vérifiés.
- Site : contrat crypto commun, bornes de réponse, refus d’un changement de compte
  entre onglets, absence de réouverture après verrouillage et tests de navigation.
- Navigateur réel, service Rust réel et PostgreSQL : connexion OIDC signée,
  création puis récupération du coffre, configuration chiffrée, association entre
  deux sessions indépendantes, données statistiques chiffrées de test et affichage
  mobile sans débordement. Aucun appel IA facturable ni clé réelle utilisés.
- Deux SQLite sur disque + vrai serveur : notes, résumé fini, conflits et
  résolution convergente, suppression contre modification hors ligne, WAV en
  plusieurs blocs avec réouverture de la base entre les blocs, PNG Studio identique
  octet par octet sans recréer de tâche de génération.
- Service : 13 suites PostgreSQL et un test de configuration, formatage, Clippy
  strict et validation du workflow. Le test de restauration réintroduit une ligne
  supprimée puis vérifie son effacement par le ledger indépendant.
- Interface native : composants desktop/mobile inspectés via le harnais IPC de
  test, compilation Rust et iOS ; ceci ne constitue pas un essai physique entre
  une app Mac signée et un iPhone.

Preuves locales, non publiées : `.tmp/website-qa/` (captures, vidéos, verdict) et
`/tmp/subrosa-account-*.png` (composants des apps). Les données des captures sont
des fixtures explicites. Le [README natif](../src-tauri/src/account/README.md)
donne les tests reproductibles et le périmètre exact des objets transférés.

## Conditions restantes avant ouverture publique

1. Fournir le domaine et l’hébergement autorisé, déployer le service, PostgreSQL
   et le stockage, configurer HTTPS et les origines exactes.
2. Configurer le fournisseur OIDC réel, ses passkeys, l’envoi des e-mails et la
   récupération d’identité ; tester les callbacks sur les appareils signés.
3. Renseigner l’opérateur, le contact, les régions et la rétention réels dans les
   informations publiques. Aucun nom ou engagement juridique n’a été inventé.
4. Valider le conteneur, S3, Object Lock, sauvegardes et restauration en cible,
   charge, supervision et rotation des secrets d’exploitation.
5. Faire relire le protocole de coffre indépendamment et effectuer les essais
   Mac/iPhone physiques, puis produire la nouvelle version signée des apps.

## Écarts explicites par rapport à la cible 10/10

La conception initiale visait 10/10 sous réserve de preuves, pas une note de
sécurité acquise. Cette livraison ne prétend pas avoir atteint toutes ces preuves.

- La racine du coffre est commune : pas de rotation d’epochs ni d’isolation
  cryptographique contre un appareil révoqué qui obtiendrait les nouveaux
  ciphertexts par une autre fuite. Voir ADR-0050.
- Changer d’identité sur une bibliothèque déjà liée est refusé. Les profils
  locaux multiples avec bascule fluide ne sont pas encore disponibles.
- Aucune délégation de commande ou exécution distante : les tâches actives gardent
  leur appareil d’origine. Les runtimes, secrets d’outils et permissions ne migrent
  pas avec la conversation.
- Le journal conserve ses révisions et tombstones jusqu’au quota ; il ne possède
  pas encore de compactage avec réconciliation des clients très anciens.
- La couverture des objets Studio et les limites de taille sont détaillées dans
  le README natif ; aucun transfert de résultat ne doit être présenté comme une
  reprise universelle de tous les projets ou workflows.

## Repères de maintenance

- [Service et exploitation](../subrosa-cloud/README.md)
- [Site et déploiement](../website/README.md)
- [Contrat réseau et crypto](accounts-sync-contract.md)
- [Décision d’architecture](adr/0049-accounts-synchronise-ciphertext-without-hosting-inference.md)
- [Limites du coffre](adr/0050-vault-admission-uses-an-out-of-band-secret.md)
