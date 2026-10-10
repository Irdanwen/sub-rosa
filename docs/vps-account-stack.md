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

Le site du compte propose désormais aussi une passkey Sub Rosa sous `subrosa.furetier.com`, distincte de celle du realm. Une connexion OIDC récente est nécessaire pour l’ajouter au même UUID interne. Publier les deux fichiers `/.well-known` depuis le build du site avant d’essayer la connexion native ; vérifier les empreintes de signature Android et la capacité Associated Domains de l’app iOS. Le déploiement actuel doit remplacer la réponse HTML de `/.well-known/assetlinks.json` par le JSON exact.

L’administrateur bootstrap (`subrosa-bootstrap`) est temporaire et appartient au realm maître. `stack.py admin-rotate` le remplace par l’administrateur permanent `subrosa-admin` (voir « Administrateur Keycloak permanent » plus bas) : mot de passe généré de 32 caractères dans `private/keycloak-admin.password` (0600, jamais affiché, jamais copié dans le volume partagé), puis suppression du compte temporaire et de `private/keycloak-admin-password`, puis préparation des secrets relancée. Ajouter un OTP à `subrosa-admin` reste possible depuis la console, par tunnel. Ne pas exposer la console maître sur Internet.

SMTP n’étant pas fourni, `registrationAllowed=false` et `resetPasswordAllowed=false` sont conservés **même si des paramètres SMTP sont ajoutés**. Pour ouvrir : configurer SMTP TLS, tester réellement réception de vérification et récupération, tester SPF/DKIM/DMARC auprès du fournisseur, puis activer explicitement inscription et récupération dans le realm existant via console administrative privée. Ne pas définir `emailVerified=true` à la main pour contourner l’absence de mail. `--import-realm` ignore un realm déjà présent ; une régénération JSON ne prétend pas le mettre à jour.

## Contrat avec le proxy existant

Nginx reste géré séparément. Terminaison HTTPS publique, aucun port Docker accessible publiquement. Le chemin `/id` doit être conservé vers Keycloak ; autoriser seulement les endpoints consommateurs nécessaires (`/id/realms/subrosa/`, `/id/resources/` et, si requis, `/id/js/`). Bloquer `/id/admin/`, `/id/realms/master/` et les endpoints de management ; accès administratif par tunnel privé approprié.

Le proxy remplace les en-têtes `X-Forwarded-*`, filtre Host et limite requêtes par client réel. `PROXY_TRUSTED_ADDRESSES` doit correspondre à l’adresse effective du proxy/bridge, jamais `0.0.0.0/0`. Le [guide reverse proxy Keycloak](https://www.keycloak.org/server/reverseproxy) décrit cette frontière. Le port management 9000 reste non publié ; le healthcheck utilise uniquement le réseau interne du container. Ne pas journaliser query strings OIDC, cookies, Authorization ou corps des requêtes.

## Clé de partenaire Carpe Diem (ADR 0069)

Le service peut attester à Carpe Diem qu’un appareil récemment connecté d’un compte vérifié a le droit d’obtenir **sa propre** clé `cdm_`, et demander la révocation des clés d’un appareil révoqué ou d’un compte supprimé. Il ne voit jamais ces clés et ne dépense rien. Contrat exact : [`carpe-diem-partner-contract.md`](carpe-diem-partner-contract.md).

Tant que `operator.json` ne contient pas `"carpe_diem": {"audience": "https://carpe-diem.xyz/api/operator"}`, rien n’est généré, la route `/api/v1/carpe-diem/assertion` répond 404 et les révocations attendent dans la table `partner_revocations`.

1. Sur le poste de préparation (celui qui détient `private/`), renseigner l’audience puis lancer `render`. Au premier passage, `render` génère `private/carpe-diem-partner.pem` (P-256, PKCS#8, 0600) avec `openssl` et ne le remplace plus jamais ensuite. Générer la clé ici plutôt que sur le VPS, pour que l’exemplaire de référence reste avec les autres secrets et qu’une copie vers le VPS ne l’écrase pas.
2. `render` écrit aussi `carpe-diem-partner.public.json` à côté de `private/` : **uniquement la partie publique**, déjà au format d’une entrée de `PARTNERS_JSON` (`id`, `name`, `issuer`, `audience`, `keys[].kid`, `keys[].jwk` ; `name` est ce que Carpe Diem affiche dans les noms de clés et les mails). C’est le seul fichier à transmettre à l’opérateur Carpe Diem, qui l’épingle dans son environnement scellé. Le `kid` est dérivé de l’empreinte RFC 7638 de la clé publique.
3. Copier `private/` vers le VPS comme d’habitude, puis `stack.py start`. La section `[carpe_diem]` est rendue dans `runtime.toml` et `migration.toml`. Au démarrage, le service refuse de servir si la clé ne signe pas.
4. Vérifier : sans session, `POST /api/v1/carpe-diem/assertion` doit répondre 401 (et non plus 404).

Rotation : générer une nouvelle clé, transmettre la nouvelle entrée à Carpe Diem, attendre qu’il épingle les **deux** `kid`, remplacer ensuite la clé ici, puis demander à Carpe Diem de retirer l’ancien `kid`. Ne jamais supprimer l’ancienne clé avant que Carpe Diem accepte la nouvelle : les assertions en vol et les révocations en attente seraient refusées.

Nouvelle sortie réseau : l’API appelle `{audience}/partner/keys/revoke` depuis sa boucle de maintenance (60 s, reprise progressive de 1 minute à 6 heures, sans abandon). C’est sa première sortie autre que l’OIDC et le stockage objet. Le réseau `outbound` de Compose la permet déjà ; une future liste d’autorisation de sortie devra inclure l’hôte Carpe Diem.

## Pages publiques, profils et catalogue d’assistants (ADR 0097)

Publier rend un texte **public et en clair** : le service rend le markdown en HTML filtré et le sert sans aucun script, depuis une **origine à part** de celle du compte (jamais les cookies du compte ni le coffre du navigateur). Le catalogue d’assistants, lui, est une API JSON publique de l’origine du compte, lue par les pages `/assistants` du site. Tant que `operator.json` ne contient pas d’URL de publication, toutes les routes de publication répondent 404 et l’app dit que le service ne publie pas de pages.

1. Choisir un hôte dédié (par exemple `pages.subrosa.furetier.com`), différent de l’hôte du compte, et créer son enregistrement DNS vers le VPS.
2. Installer le vhost : `sed 's/pages.example.invalid/<hôte>/g' subrosa-cloud/deploy/nginx-pages.conf.example > /etc/nginx/sites-available/subrosa-pages`, lien dans `sites-enabled`, puis `certbot --nginx -d <hôte>` et `nginx -t && systemctl reload nginx`. Seuls `/p/`, `/u/` et `/_pub/` vont au service ; tout le reste répond 404, et les cookies ne passent pas.
3. Sur le poste de préparation, renseigner dans `operator.json` : `"publication": {"url": "https://<hôte>", "blocked_terms": []}`, puis `render`. La section `[publication]` est rendue dans `runtime.toml` et `migration.toml` ; `render` refuse une URL qui n’est pas une origine HTTPS ou qui reprend l’hôte du compte.
4. Construire et publier l’image du service (migration `0012_publications.sql`), copier `private/` vers le VPS, puis `stack.py migrate` et `stack.py start`.
5. Déployer le site du compte construit depuis cette version (pages `/assistants`) ; l’hôte du compte n’a besoin d’aucun changement de vhost, le repli SPA les sert déjà.
6. Vérifier : `curl -sI https://<hôte>/p/inexistant` répond 404 en `text/html` avec `Content-Security-Policy: default-src 'none'…` ; `curl -s https://<hôte-compte>/api/v1/catalog/assistants` répond `{"data":[]}` ; `curl -sI https://<hôte-compte>/p/x` ne sert **pas** de page publiée.

Modération : `subrosa-cloud/scripts/takedown.sh --directory <dossier privé> reports` liste les signalements ouverts, `… page <slug> "<motif>"` (ou `site`, `profile`, `assistant`) retire un contenu. Règles et détails : [`public-content-rules.md`](public-content-rules.md). Le texte publié vit en clair dans PostgreSQL et dans ses sauvegardes : une restauration peut faire revenir une page dépubliée depuis la sauvegarde.

## Origine des compléments Office (ADR 0102, addendum du 2026-10-10)

Les volets Word, Excel et PowerPoint exécutent `office.js`, le script de Microsoft qu’on ne peut pas épingler. Ils sont donc servis par leur **propre origine**, `office.subrosa.furetier.com`, et plus jamais par celle du compte : rien de ce qui s’y exécute n’atteint le cookie du compte (sans attribut `Domain`), son stockage, son coffre ni son jeton CSRF. L’origine du compte garde deux pages sans `office.js` : `/office/courier.html` (encadrée par la seule fenêtre de connexion de l’origine Office, elle porte les sept appels d’appareil avec le cookie) et `/office/signed-in.html` (où la connexion revient, qui renvoie la fenêtre vers l’origine Office). Les anciennes adresses `/office/*.html` redirigent vers `/office/moved.html`, sans script.

Ordre exact, détaillé avec ses vérifications dans [`office-addins.md`](office-addins.md#deployment) :

0. **Carpe Diem (porte externe)** : ajouter `https://office.subrosa.furetier.com` à `SUBROSA_SITE_ORIGINS` (`operator/src/services/browserKeys.ts`) et déployer l’opérateur, sinon CORS refuse tous les appels des volets.
1. **DNS** : enregistrement `A` (et `AAAA` le cas échéant) `office.subrosa.furetier.com` vers le VPS, non proxifié.
2. **Vhost port 80 + ACME** : `nginx-office-bootstrap.conf.example` (hôte substitué) dans `sites-available/subrosa-office`, lien dans `sites-enabled`, `nginx -t && systemctl reload nginx`.
3. **Certificat par webroot** : `certbot certonly --webroot -w /var/www/certbot -d office.subrosa.furetier.com`.
4. **Build avec les deux origines** : le site avec `VITE_OFFICE_ORIGIN=https://office.subrosa.furetier.com` seul (jamais `VITE_ACCOUNT_ORIGIN` sur le site du compte), les compléments avec `VITE_ACCOUNT_ORIGIN=https://subrosa.furetier.com` et `VITE_OFFICE_ORIGIN=https://office.subrosa.furetier.com` (`pnpm --filter @subrosa/office-addins build`, sortie `office-addins/dist`, Pyodide compris).
5. **Publication** de `office-addins/dist` dans `/srv/subrosa-office/www/releases/<id>`, puis bascule du lien `/srv/subrosa-office/www/current`.
6. **Vhost HTTPS** : `nginx-office.conf.example` avec les deux hôtes substitués, à la place du fichier d’amorçage ; aucun service proxifié, aucun cookie, `X-Frame-Options` absent sur `/office/`.
7. **Version du service** dont `RETURN_TO` contient `/office/signed-in.html` et plus `/office/session.html`.
8. **Version du site du compte**, aussitôt après, avec le vhost du compte réinstallé depuis `nginx-account.conf.example` (blocs courrier, retour de connexion et page « déménagé » ; le bloc `/office/` avec `office.js` disparaît ; substituer les deux hôtes).
9. **Validation des manifestes** : `node office-addins/scripts/manifests.mjs --check`, puis `npx office-addin-manifest validate` sur chacun (service en ligne de Microsoft).
10. **Re-chargement latéral** des manifestes 1.0.1.0 dans Word, Excel et PowerPoint (web, Windows, Mac), après retrait de l’ancien complément ; révoquer les anciens appareils « Complément Office ».

Effet visible : un complément chargé avant la bascule affiche « Sub Rosa for Office has moved » ; le nouveau demande une connexion et une approbation depuis l’app, une fois par volet, y compris sur le bureau (plus de connexion sur place ni de clé de récupération dans un volet). Le site et `/app` ne changent pas.

## Stockage et sauvegardes : portes encore fermées

Le fichier [`storage-policies.example.json`](../subrosa-cloud/deploy/vps/storage-policies.example.json) fournit deux politiques de rôle à adapter chez le fournisseur. Ciphertexts : get/put/delete, bucket privé. Registre : list/get/create conditionnel, **aucun delete**, pas de changement de lifecycle/versioning/rétention par le runtime. Les [conditions S3 de création](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html) doivent être testées chez le fournisseur compatible. Ce n’est pas une configuration universelle interchangeable entre prestataires.

Exiger Object Lock ou protection équivalente, contrôle d’administration indépendant, interdiction d’effacer bucket/versions, sauvegarde externe et conservation du trousseau de signature. Le registre et ses clés restent hors de l’ensemble restauré PostgreSQL/ciphertexts. Une permission `PutObject` seule n’équivaut pas à de l’immutabilité. Tester refus d’écrasement et de suppression, création/relecture identique, refus d’un autre corps, restauration après suppression de compte et rejet d’un registre altéré.

`backup.sh` produit uniquement un dump logique chiffré avec une clé publique `age`, sans fichier plaintext intermédiaire :

```sh
subrosa-cloud/deploy/vps/backup.sh /chemin/prive/subrosa-accounts \
  /chemin/recipients-age-publics.txt /chemin/prive/sauvegardes-chiffrees
```

La clé privée de déchiffrement ne doit pas être sur le VPS. Cette aide **ne configure ni transfert hors site, ni planification, ni PITR**. Les mots de passe de rôles ne sont pas inclus : leur restauration/rotation utilise le gestionnaire de secrets indépendant. Configurer une sauvegarde PostgreSQL cohérente, son transfert protégé hors hôte, sa rétention et un exercice de restauration privé avant de déclarer les champs `backup_*` validés. Après restauration, avant trafic, exécuter `stack.py restore-sanitize` ; le service invalide les anciennes sessions puis réapplique le registre indépendant. Ne jamais restaurer par-dessus les seules clés ou le seul registre de suppressions.

## Administrateur Keycloak permanent (2026-10-10)

Sur le VPS, depuis le répertoire `deploy` à jour (il contient `admin_rotate.py` à côté de `stack.py`) :

```sh
cd /opt/subrosa-accounts/deploy
python3 stack.py admin-rotate --dry-run --directory /opt/subrosa-accounts/prod   # le plan, rien n'est lu ni envoyé
python3 stack.py admin-rotate --directory /opt/subrosa-accounts/prod
```

Le script parle à Keycloak par le port de boucle locale (`http://127.0.0.1:18080` + `IDENTITY_PATH`), jamais par l’origine publique, qui bloque le realm maître. Dans l’ordre : connexion `admin-cli` de `subrosa-bootstrap` avec `private/keycloak-admin-password` ; mot de passe de `subrosa-admin` généré et écrit en 0600 **avant** d’être envoyé (une reprise réutilise le même) ; création de `subrosa-admin` si absent, mot de passe définitif, rôle `admin` du realm maître ; connexion de `subrosa-admin` et liste des utilisateurs avec son propre jeton (la preuve qu’il a les droits) ; suppression de `subrosa-bootstrap` avec ce jeton ; suppression de `private/keycloak-admin-password` ; `docker compose run --rm prepare-secrets`, qui retire la copie du volume. Chaque étape est idempotente : relancer après une interruption termine le travail. En cas d’échec avant la preuve, `subrosa-bootstrap` est conservé. Les sorties nomment des utilisateurs, des fichiers et des statuts HTTP, jamais une valeur. Le `--dry-run` rejoue les mêmes étapes contre un Keycloak en mémoire construit d’après les fichiers présents (il suppose que chaque fichier présent ouvre encore une session).

Contrôle après coup (lecture seule) :

```sh
docker exec subrosa-accounts-postgres-1 psql -U postgres -d keycloak -Atc \
  "SELECT u.username FROM user_entity u JOIN realm r ON r.id=u.realm_id WHERE r.name='master'"
# attendu : subrosa-admin seul
ls /opt/subrosa-accounts/prod/private/keycloak-admin*   # attendu : keycloak-admin.password seul
```

### Sortir de l’hôte les deux restes de `private/`

`private/ledger-signing-key.compromis-1789767921` (clé de registre remplacée le 18 septembre, que `runtime.toml` ne nomme plus : seule `v1` y figure) et `private/runtime.toml.bak-1789767681` (configuration d’avant la rotation, avec des secrets) n’ont rien à faire sur le VPS. Les chiffrer pour les destinataires `age` des sauvegardes, les déposer dans le bucket de sauvegarde verrouillé avec le client `s3put_lib.py` de la sauvegarde nocturne (`/opt/subrosa-accounts/deploy/`), relire et comparer, puis effacer :

```sh
cd /opt/subrosa-accounts/prod/private
archive=/opt/subrosa-accounts/backups/restes-private-$(date -u +%Y%m%dT%H%M%SZ).tar.age
tar -cf - ledger-signing-key.compromis-1789767921 runtime.toml.bak-1789767681 \
  | age -R /opt/subrosa-accounts/backup-recipients.txt > "$archive"
chmod 0600 "$archive"
python3 - "$archive" <<'EOF'
import base64, datetime, hashlib, pathlib, sys
sys.path.insert(0, "/opt/subrosa-accounts/deploy")
from s3put_lib import request
src = pathlib.Path(sys.argv[1]); body = src.read_bytes()
env = dict(l.split("=", 1) for l in pathlib.Path("/opt/subrosa-accounts/backups-s3.env").read_text().splitlines() if "=" in l and not l.startswith("#"))
B = dict(endpoint=env["ENDPOINT"], region=env["REGION"], access_key=env["ACCESS_KEY"], secret_key=env["SECRET_KEY"], bucket=env["BUCKET"])
until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ")
key = "restes-private/" + src.name
s, _ = request("PUT", key=key, body=body, headers={"Content-MD5": base64.b64encode(hashlib.md5(body).digest()).decode(), "x-amz-object-lock-mode": "COMPLIANCE", "x-amz-object-lock-retain-until-date": until}, **B)
if s != 200: sys.exit("upload failed: %s" % s)
s, back = request("GET", key=key, **B)
if s != 200 or hashlib.sha256(back).digest() != hashlib.sha256(body).digest(): sys.exit("read-back differs: %s" % s)
print("offsite:", key, len(body), "bytes, verified, locked until", until)
EOF
```

Seulement si la dernière ligne affiche `verified` : `shred -u ledger-signing-key.compromis-1789767921 runtime.toml.bak-1789767681 "$archive"`. Le déchiffrement exige la clé privée `age`, qui n’est pas sur le VPS. Les autres `*.bak-*` de `prod/` (hors `private/`) relèvent du même traitement s’ils contiennent des secrets.

## Santé de l’API et révocations Carpe Diem (2026-10-10)

Le conteneur `api` a un `healthcheck` Compose : `GET /readyz` toutes les 30 s par `/dev/tcp` de bash (l’image n’a pas de client HTTP), trois échecs avant `unhealthy`. `/readyz` répond 200 dès que PostgreSQL répond et ajoute `partner_revocations: {pending, stuck}` : les révocations Carpe Diem pas encore livrées, et celles qui échouent depuis environ un jour (douze tentatives). Un arriéré ne rend jamais le service indisponible. Chaque échec écrit son statut dans `partner_revocations.last_error` (`http 404`, `unreachable`, `signing`), et une révocation coincée produit une ligne `ERROR` au plus une fois par jour. Un `http 404` signifie que l’opérateur Carpe Diem n’a pas de partenaire configuré (`PARTNERS_JSON`) : voir la section 4 de [carpe-diem-partner-contract.md](carpe-diem-partner-contract.md).

```sh
curl -s http://127.0.0.1:18088/readyz
docker inspect --format '{{.State.Health.Status}}' subrosa-accounts-api-1
docker logs --since 48h subrosa-accounts-api-1 2>&1 | grep '"level":"ERROR"' | grep revocations
```

## Preuves locales et limites

```sh
python3 -m unittest discover -s subrosa-cloud/deploy/vps -p 'test_*.py' -v
```

`test_admin_rotate.py` couvre la rotation de l’administrateur contre un realm maître en mémoire : remplacement, idempotence, reprise après interruption, refus de supprimer sans preuve des droits, plan `--dry-run` sans secret, mot de passe permanent hors du volume partagé. `test_bootstrap.py` couvre : permissions, refus de remplacement de clés, absence de secrets stdout, prérequis manquants bloquants, configuration OIDC fermée, séparation credentials, validation SAN TLS. Le test PostgreSQL lance un cluster temporaire sans écoute réseau et vérifie réellement DML permis, DDL interdit et accès à la base Keycloak refusé. Il est explicitement marqué ignoré si les binaires locaux PostgreSQL manquent. Syntaxe shell et parsing YAML/JSON vérifiés aussi. Compose a été validé avec `docker compose config --quiet` avec les profils `application` et `operations` sur Docker Compose 2.37.1 du VPS : code de sortie 0, environnement factice sans secrets, aucun container démarré.

Limites : pas de Docker local disponible pour construire ou exécuter ces images ; pas d’essai Keycloak déployé, SMTP réel, S3 réel, sauvegarde externe ou charge réelle. Les UID des images, le readiness Keycloak, les parcours passkey/e-mail et la restauration externe restent des critères d’ouverture. La pile est une préparation reproductible, pas une preuve de mise en service.

## Changer de stockage objet pour les chiffrés (2026-10-03)

Le bucket des chiffrés n'a besoin ni d'Object Lock ni de rétention : seuls le
registre de suppressions et les sauvegardes en ont. Il peut donc vivre chez un
fournisseur à sortie gratuite (Cloudflare R2 depuis le 2026-10-03, écritures
conditionnelles natives, donc sans la relaxation `conditional_writes`). Pour
migrer :

1. Prouver la sémantique du nouveau bucket avec `s3put_lib.py` (écriture,
   relecture identique, `If-None-Match: *` refusé à 412 sur un objet existant,
   suppression) avant toute copie.
2. Copier avec `deploy/vps/copy-blobs.py --mode copy` : il lit la liste des
   blobs dans PostgreSQL, ne copie que ce que la destination n'a pas, et
   vérifie chaque objet contre l'empreinte SHA-256 enregistrée. Relançable.
3. Remplacer la section `storage` d'`operator.json`, `stack.py start`, puis
   **`docker restart subrosa-accounts-api-1`** : `start` ne redémarre pas un
   conteneur dont la définition n'a pas changé, et la configuration n'est
   relue qu'au démarrage.
4. Repasser `copy-blobs.py --mode copy` avec l'ancien `operator.json` en
   `--operator` pour les blobs arrivés pendant la fenêtre, puis `--mode verify`
   doit afficher `missing 0, size mismatch 0`.

Garder l'ancien bucket intact jusqu'à cette vérification. Un plafond
journalier de lectures chez l'ancien fournisseur (cas Backblaze, 2 500 lectures
gratuites par jour) suffit à faire échouer la copie à mi-chemin : elle reprend
là où elle s'est arrêtée.
