# Pile comptes sur VPS : préparation et conditions d’ouverture

État au 15 septembre 2026 : **sources préparées, aucun service de cette pile démarré sur le VPS**. Le site public peut fonctionner indépendamment. SMTP, stockage S3 privé, registre de suppressions indépendant et sauvegardes externes ne sont pas configurés. L’inscription reste fermée ; aucun utilisateur consommateur ni adresse artificiellement vérifiée n’est créé.

Les fichiers sont dans [`subrosa-cloud/deploy/vps/`](../subrosa-cloud/deploy/vps/). Cette pile s’ajoute à l’existant sous le projet Compose `subrosa-accounts`. Elle n’altère ni nginx, ni les bases existantes. Ne pas exécuter `down --volumes` sur une installation contenant des données.

## Composants et frontières

| Composant | Accès | Mémoire maximale par défaut |
| --- | --- | --- |
| Keycloak 26.7.3 | `127.0.0.1:18080`, uniquement derrière le proxy HTTPS | 2 048 MiB |
| PostgreSQL 17.11 | réseau Docker interne, aucun port hôte | 384 MiB |
| API Sub Rosa | `127.0.0.1:18088`, origine identique au site compte | 384 MiB |
| Préparation secrets / migrations | exécution explicite, pas de service permanent | 64 / 384 MiB |

Keycloak est figé sur l’index OCI `sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4`. La version et le manifeste Quay ont été vérifiés le 15 septembre 2026, sans télécharger ou exécuter l’image. La [page officielle des téléchargements](https://www.keycloak.org/downloads) indique 26.7.3 ; les [notes de version](https://www.keycloak.org/2026/08/keycloak-2673-released) décrivent ses correctifs. PostgreSQL 17.11 est une version maintenue selon la [politique officielle](https://www.postgresql.org/support/versioning/). Vérifier les correctifs et épingler également son digest lors du gel de l’artefact de déploiement.

Le [guide Keycloak](https://www.keycloak.org/server/containers) recommande 2 GiB pour une petite installation de production. Avec environ 2 GiB libres sur le VPS, **le budget par défaut ne tient pas** : `stack.py` demande la somme des plafonds configurés et 256 MiB de marge, soit 3 GiB pour la pile complète. Libérer de la mémoire ou augmenter la capacité avant lancement. Des plafonds inférieurs sont possibles dans `stack.env`, avec un plancher technique, mais exigent une mesure de charge et de récupération après OOM ; ce n’est pas une promesse de capacité. Le contrôle initial demande aussi 12 GiB libres dans `/var/lib/docker`, sans réserver cet espace ni remplacer une alerte de croissance. Les 41 GiB libres observés ne constituent pas une capacité de sauvegarde externe.

Les images doivent être construites sur un environnement de build et transférées ou publiées comme artefacts vérifiés. Ne pas compiler Rust/Keycloak sur ce VPS contraint. Le démarrage fourni utilise `--no-build` pour Keycloak ; l’API exige une référence de registre immuable `@sha256:` dans `CLOUD_IMAGE` avant ouverture. Docker Engine avec volumes `subpath` et Compose récent sont requis ; valider `docker compose config --quiet` avec la version installée avant usage.

## Préparer sans déployer

Depuis la racine du dépôt, sur le poste de préparation :

```sh
python3 subrosa-cloud/deploy/vps/bootstrap.py init \
  --directory /chemin/prive/subrosa-accounts \
  --account-origin https://subrosa.furetier.com \
  --identity-base https://subrosa.furetier.com/id
```

Le répertoire parent est en mode 0700, chaque fichier en 0600. Le programme génère indépendamment les mots de passe PostgreSQL, comptes de migration/exécution, secret OIDC, administrateur temporaire Keycloak, clé de signature du registre et autorité TLS PostgreSQL. Il n’affiche aucune de ces valeurs, ne contacte aucun serveur et refuse de réinitialiser un répertoire existant. `.gitignore` protège aussi le répertoire généré ; le conserver hors dépôt, sauvegardé dans le gestionnaire de secrets de l’opérateur. Ne jamais publier `docker inspect`, un export du realm, les fichiers TOML ou les dumps.

Renseigner, avec un éditeur privé :

- `stack.env` : image API testée avec digest, adresse réelle du proxy vue depuis le réseau Docker, plafonds mémoire. Ce fichier ne contient pas les mots de passe.
- `operator.json` : deux stockages S3 externes HTTPS, buckets et credentials distincts, SMTP réel ; laisser les validations à `false` tant que les essais ne sont pas faits.
- Les preuves de stockage/rétention/restauration, enregistrées séparément. Les champs de validation du fichier sont des attestations de l’opérateur, pas des tests automatiques des fournisseurs.

```sh
python3 subrosa-cloud/deploy/vps/bootstrap.py render --directory /chemin/prive/subrosa-accounts
python3 subrosa-cloud/deploy/vps/stack.py validate --directory /chemin/prive/subrosa-accounts
```

`render` conserve toutes les clés générées et prépare les configurations. **Il ne modifie pas une base ou un realm déjà existant.** Une rotation requiert aussi la modification correspondante dans PostgreSQL/Keycloak, puis une redistribution contrôlée des fichiers.

Les secrets Compose issus de fichiers bind n’appliquent pas fiablement `uid/gid`. La tâche isolée `prepare-secrets` copie donc les fichiers dans un volume avec mode 0600 et propriétaires effectifs : PostgreSQL 999, Keycloak 1000, API 10001, migration 10002. Les répertoires de configuration API et migration sont séparés et en 0700. L’API ne peut pas lire le mot de passe de migration. Seuls les certificats publics sont en 0644. L’administrateur Docker reste une frontière de confiance.

## PostgreSQL

Deux bases distinctes : `subrosa`, détenue par `subrosa_migrator`, et `keycloak`, détenue par son rôle dédié. Le rôle `subrosa_runtime` a uniquement connexion, usage du schéma, DML et usage des séquences ; ni DDL, ni création de rôle/base, ni accès au schéma Keycloak. Les objets applicatifs nouveaux héritent de ces droits ; le registre `_sqlx_migrations` est explicitement retiré au rôle runtime après chaque migration.

Tous les clients TCP vérifient TLS avec `sslmode=verify-full`, CA privée et SAN `postgres`. `pg_hba.conf` refuse le trafic TCP non TLS et les associations rôle/base inconnues. Le socket Unix de maintenance PostgreSQL n’est pas exposé aux autres containers. Le certificat serveur expire après un an ; programmer son renouvellement avant échéance et conserver la CA privée hors volume runtime. Changer d’hôte DB exige un certificat correspondant, jamais `sslmode=disable`.

Les fichiers d’initialisation ne sont joués que sur un volume PostgreSQL neuf. Une initialisation interrompue doit être diagnostiquée avant de réessayer ; ne pas effacer un volume pour faire disparaître l’erreur. Les migrations restent explicites :

```sh
python3 subrosa-cloud/deploy/vps/stack.py identity --directory /chemin/prive/subrosa-accounts
python3 subrosa-cloud/deploy/vps/stack.py migrate --directory /chemin/prive/subrosa-accounts
python3 subrosa-cloud/deploy/vps/stack.py start --directory /chemin/prive/subrosa-accounts
```

Ces commandes sont destinées au lancement ultérieur autorisé. `identity` peut démarrer PostgreSQL/Keycloak avec inscription fermée ; `migrate`, `maintenance` et `restore-sanitize` exigent le stockage réel configuré ; seul `start` exige en plus les preuves de politiques et de restauration. Cela permet de mener le premier exercice de récupération avant ouverture. Le service lui-même conserve toutes ses validations de production et ne lie son listener qu’après lecture du registre indépendant et découverte OIDC valides. Rien ne bascule vers un stockage local ou une identité factice.

## OIDC, e-mail et passkeys

Avec les adresses d’exemple ci-dessus, l’issuer exact est `https://subrosa.furetier.com/id/realms/subrosa`. Le client confidentiel `subrosa-cloud` accepte uniquement `https://subrosa.furetier.com/auth/callback`, code d’autorisation et PKCE S256, authentification du client par secret ; implicit flow, password grant et service account sont désactivés. L’adaptateur API impose la signature, issuer, audience, nonce, `email_verified` et `auth_time` récent, et demande `max_age=0`. Ces exigences ne sont pas supprimées pour faciliter la connexion. Le client inclut explicitement le scope prédéfini `basic` : depuis Keycloak 25, ses mappers fournissent `sub` et `auth_time`, selon les [notes officielles](https://www.keycloak.org/2024/06/keycloak-2500-released). Le mapper lit l’instant de la session, jamais une valeur fabriquée depuis un attribut utilisateur. La présence et la fraîcheur du claim doivent encore être vérifiées sur le jeton signé du vrai parcours avant ouverture. L’authentification est exclusivement en anglais, y compris dans un navigateur configuré en français.

Le realm active vérification e-mail, protection contre essais répétés et passkeys résidentes avec vérification de l’utilisateur. Le RP ID est le hostname d’identité fourni au bootstrap : le changer ultérieurement invalide l’usage attendu des credentials existants. Les propriétés correspondent au [modèle officiel de realm 26.7.3](https://raw.githubusercontent.com/keycloak/keycloak/26.7.3/core/src/main/java/org/keycloak/representations/idm/RealmRepresentation.java). L’enrôlement, le navigateur réel et le secours doivent être validés selon le [guide d’administration](https://www.keycloak.org/docs/latest/server_admin/). Aucun essai d’enrôlement réel n’est revendiqué ici.

L’administrateur bootstrap est temporaire et appartient au realm maître. L’opérateur doit créer son compte administratif permanent avec passkey ou OTP, supprimer le compte temporaire, retirer `private/keycloak-admin-password`, puis relancer la préparation des secrets. Ne pas exposer la console maître sur Internet.

SMTP n’étant pas fourni, `registrationAllowed=false` et `resetPasswordAllowed=false` sont conservés **même si des paramètres SMTP sont ajoutés**. Pour ouvrir : configurer SMTP TLS, tester réellement réception de vérification et récupération, tester SPF/DKIM/DMARC auprès du fournisseur, puis activer explicitement inscription et récupération dans le realm existant via console administrative privée. Ne pas définir `emailVerified=true` à la main pour contourner l’absence de mail. `--import-realm` ignore un realm déjà présent ; une régénération JSON ne prétend pas le mettre à jour.

## Contrat avec le proxy existant

Nginx reste géré séparément. Terminaison HTTPS publique, aucun port Docker accessible publiquement. Le chemin `/id` doit être conservé vers Keycloak ; autoriser seulement les endpoints consommateurs nécessaires (`/id/realms/subrosa/`, `/id/resources/` et, si requis, `/id/js/`). Bloquer `/id/admin/`, `/id/realms/master/` et les endpoints de management ; accès administratif par tunnel privé approprié.

Le proxy remplace les en-têtes `X-Forwarded-*`, filtre Host et limite requêtes par client réel. `PROXY_TRUSTED_ADDRESSES` doit correspondre à l’adresse effective du proxy/bridge, jamais `0.0.0.0/0`. Le [guide reverse proxy Keycloak](https://www.keycloak.org/server/reverseproxy) décrit cette frontière. Le port management 9000 reste non publié ; le healthcheck utilise uniquement le réseau interne du container. Ne pas journaliser query strings OIDC, cookies, Authorization ou corps des requêtes.

## Stockage et sauvegardes : portes encore fermées

Le fichier [`storage-policies.example.json`](../subrosa-cloud/deploy/vps/storage-policies.example.json) fournit deux politiques de rôle à adapter chez le fournisseur. Ciphertexts : get/put/delete, bucket privé. Registre : list/get/create conditionnel, **aucun delete**, pas de changement de lifecycle/versioning/rétention par le runtime. Les [conditions S3 de création](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html) doivent être testées chez le fournisseur compatible. Ce n’est pas une configuration universelle interchangeable entre prestataires.

Exiger Object Lock ou protection équivalente, contrôle d’administration indépendant, interdiction d’effacer bucket/versions, sauvegarde externe et conservation du trousseau de signature. Le registre et ses clés restent hors de l’ensemble restauré PostgreSQL/ciphertexts. Une permission `PutObject` seule n’équivaut pas à de l’immutabilité. Tester refus d’écrasement et de suppression, création/relecture identique, refus d’un autre corps, restauration après suppression de compte et rejet d’un registre altéré.

`backup.sh` produit uniquement un dump logique chiffré avec une clé publique `age`, sans fichier plaintext intermédiaire :

```sh
subrosa-cloud/deploy/vps/backup.sh /chemin/prive/subrosa-accounts \
  /chemin/recipients-age-publics.txt /chemin/prive/sauvegardes-chiffrees
```

La clé privée de déchiffrement ne doit pas être sur le VPS. Cette aide **ne configure ni transfert hors site, ni planification, ni PITR**. Les mots de passe de rôles ne sont pas inclus : leur restauration/rotation utilise le gestionnaire de secrets indépendant. Configurer une sauvegarde PostgreSQL cohérente, son transfert protégé hors hôte, sa rétention et un exercice de restauration privé avant de déclarer les champs `backup_*` validés. Après restauration, avant trafic, exécuter `stack.py restore-sanitize` ; le service invalide les anciennes sessions puis réapplique le registre indépendant. Ne jamais restaurer par-dessus les seules clés ou le seul registre de suppressions.

## Preuves locales et limites

```sh
python3 -m unittest discover -s subrosa-cloud/deploy/vps -p 'test_*.py' -v
```

Huit tests réussis : permissions, refus de remplacement de clés, absence de secrets stdout, prérequis manquants bloquants, configuration OIDC fermée, séparation credentials, validation SAN TLS. Le test PostgreSQL lance un cluster temporaire sans écoute réseau et vérifie réellement DML permis, DDL interdit et accès à la base Keycloak refusé. Il est explicitement marqué ignoré si les binaires locaux PostgreSQL manquent. Syntaxe shell et parsing YAML/JSON vérifiés aussi. Compose a été validé avec `docker compose config --quiet` avec les profils `application` et `operations` sur Docker Compose 2.37.1 du VPS : code de sortie 0, environnement factice sans secrets, aucun container démarré.

Limites : pas de Docker local disponible pour construire ou exécuter ces images ; pas d’essai Keycloak déployé, SMTP réel, S3 réel, sauvegarde externe ou charge réelle. Les UID des images, le readiness Keycloak, les parcours passkey/e-mail et la restauration externe restent des critères d’ouverture. La pile est une préparation reproductible, pas une preuve de mise en service.
