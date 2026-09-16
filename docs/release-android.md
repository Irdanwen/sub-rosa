# Distribuer Sub Rosa sur Android

La cible Android réutilise le shell mobile et le backend embarqué en processus.
Identifiant de l'app : `xyz.carpediem.subrosa`. La CI produit deux fichiers
signés pour les téléphones **arm64-v8a** : un APK à installer et un AAB à
transmettre à Google Play Console.

Le workflow [android-release.yml](../.github/workflows/android-release.yml) se
lance manuellement. Il conserve les fichiers dans les artefacts Actions pendant
30 jours. Son option `publish`, désactivée par défaut, crée une préversion
publique dans `Irdanwen/sub-rosa-releases`, avec un tag propre à Android. Les
releases et le manifeste de mise à jour desktop ne sont pas modifiés.

## Préparer la signature une fois

Créer une clé pérenne, la sauvegarder avec ses mots de passe dans le coffre de
l'équipe, puis déposer ces quatre secrets Actions dans `Irdanwen/sub-rosa` :

| Secret | Contenu |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Fichier JKS encodé en base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Mot de passe du fichier JKS |
| `ANDROID_KEY_ALIAS` | Alias de la clé, par exemple `subrosa` |
| `ANDROID_KEY_PASSWORD` | Mot de passe de cette clé |

Exemple interactif avec le `keytool` du JDK, hors du dépôt :

```sh
keytool -genkeypair -v -keystore "$HOME/subrosa-android.jks" \
  -storetype JKS -alias subrosa -keyalg RSA -keysize 4096 -validity 10000
```

Sur macOS, transmettre le base64 directement à GitHub sans l'afficher :

```sh
base64 -i "$HOME/subrosa-android.jks" | \
  gh secret set ANDROID_KEYSTORE_BASE64 --repo Irdanwen/sub-rosa
gh secret set ANDROID_KEYSTORE_PASSWORD --repo Irdanwen/sub-rosa
gh secret set ANDROID_KEY_ALIAS --repo Irdanwen/sub-rosa
gh secret set ANDROID_KEY_PASSWORD --repo Irdanwen/sub-rosa
```

Les trois dernières commandes demandent leur valeur au terminal. Ne jamais
commiter le JKS, un fichier de propriétés de signature ou les mots de passe.
Gradle reçoit `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` et `ANDROID_KEY_PASSWORD` par l'environnement du build.
Le workflow décode la clé dans `RUNNER_TEMP`, puis l'efface même en cas d'échec.
Le secret `RELEASES_REPO_TOKEN` existant est utilisé seulement si `publish=true`.

**Conserver la même clé pour les mises à jour APK.** Android vérifie la
continuité de signature. Si Google Play App Signing utilise une autre clé de
signature que celle des APK directs, ces deux canaux ne peuvent pas se mettre
à jour mutuellement. Choisir la clé Play avant la première distribution sur
ce canal. Voir la [documentation Android sur la signature](https://developer.android.com/studio/publish/app-signing).

## Construire et récupérer une version

Dans Actions, sélectionner **Android release**, **Run workflow**, puis la
branche ou le tag source. Laisser `publish` décoché pour valider les fichiers.
Équivalent en ligne de commande, une fois le workflow présent sur `main` :

```sh
gh workflow run android-release.yml --repo Irdanwen/sub-rosa \
  -f ref=main -f publish=false
gh run list --repo Irdanwen/sub-rosa --workflow android-release.yml --limit 5
gh run download RUN_ID --repo Irdanwen/sub-rosa --dir ./android-release
```

Le dossier contient l'APK, l'AAB, `SHA256SUMS.txt`, `build-info.txt` et
`source-commit.txt`. La CI exige une signature APK valide, vérifie la signature
JAR de l'AAB et l'alignement ZIP de l'APK pour les pages de 16 Kio avant de les
conserver. L'alignement ZIP ne remplace pas un essai sur un appareil 16 Kio.

Le build utilise Node 22, pnpm verrouillé, Java 17, Rust 1.95.0, SDK Android 36,
build-tools 36.0.0 et NDK 28.2.13676358. Le projet Android est commité sous
`src-tauri/gen/android/` : la CI ne relance pas `tauri android init`, qui pourrait
écraser les permissions et la configuration de signature.

### Numéro de build

La version affichée reste celle de `package.json` et de la configuration Tauri.
Le `versionCode` Android est le nombre de secondes UTC depuis le 1er janvier
2020, calculé au démarrage du build avec un plafond de 2 100 000 000.
Un ancien workflow relancé reçoit ainsi un nouveau numéro. Une concurrence
globale sérialise la lane Android. Un fichier Tauri temporaire fournit ce
numéro avec `--config`, sans modifier la version dans le dépôt.

Pour distribuer un build local après une version CI, lui donner un code
supérieur au dernier code distribué, avec le même calcul et la même clé.
Le code dérivé par défaut de la version sémantique serait inférieur et Android
refuserait la mise à jour. Android et Google Play exigent des codes croissants ;
voir [Version your app](https://developer.android.com/studio/publish/versioning).

## Installer l'APK

Télécharger le fichier `.apk` sur le téléphone, l'ouvrir et autoriser si demandé
l'installation depuis ce navigateur ou ce gestionnaire de fichiers. Pour un
téléphone connecté en USB avec le débogage activé :

```sh
adb install -r subrosa-VERSION-BUILD-arm64.apk
```

Le paramètre `-r` conserve les données lors d'une mise à jour signée avec la
même clé. Ne pas désinstaller l'app pour contourner une erreur de signature :
cela supprimerait les données locales. Vérifier d'abord le canal et la clé.

Pour donner un lien public aux testeurs, relancer le workflow avec
`publish=true` après validation. La préversion publique contient l'APK et son
empreinte ; les testeurs n'ont pas besoin d'accéder aux artefacts Actions.

Le site public propose la préversion Android la plus récente : `pnpm website:releases`
régénère `website/src/releases.json` à partir des releases publiques (la carte
Android disparaît s'il n'existe aucune préversion), puis reconstruire et déployer
le site.

## Distribuer par Google Play en test interne

Le canal **Test interne** de Google Play Console permet de distribuer l'app à
un groupe de testeurs avec des mises à jour gérées par le Play Store. Il faut
un compte développeur Google Play et une fiche d'app dont l'identifiant est
`xyz.carpediem.subrosa`. Le workflow prépare l'AAB signé ; il n'envoie pas encore
de build à Google Play et ne crée pas de compte développeur.

1. Créer ou ouvrir la fiche Sub Rosa dans Play Console et configurer App Signing.
2. Ouvrir **Test et publication**, puis **Test interne**, et créer une version.
3. Déposer l'AAB issu d'un workflow réussi, renseigner les notes de version et
   terminer les déclarations demandées par la console.
4. Ajouter les comptes de test et partager le lien d'inscription au test.
5. Vérifier l'installation et une mise à jour depuis Google Play sur un appareil.

Les nouveaux dépôts doivent actuellement cibler Android 16/API 36. Les
bibliothèques natives doivent aussi fonctionner sur les appareils à pages de
16 Kio. Contrôler ces exigences et les déclarations de confidentialité avant
la première soumission. Sources : [exigence de SDK cible](https://developer.android.com/google/play/requirements/target-sdk),
[pages de 16 Kio](https://developer.android.com/guide/practices/page-sizes) et
[distribution Tauri sur Google Play](https://v2.tauri.app/distribute/google-play/).

## Vérification avant de remettre un build

Sur un téléphone Android : premier lancement, saisie et persistance de la clé
Carpe Diem après fermeture complète, permission microphone puis enregistrement
et lecture d'une note, chat, génération Studio, export, refus puis réactivation
des permissions, passage en arrière-plan et reprise, mise à jour APK en gardant
les notes. Refaire la reprise après que le système a arrêté le processus.
Conserver le modèle du téléphone, sa version Android, le code du build et les
résultats dans un rapport `docs/qa/`.

Une compilation ou une signature valide ne prouve pas ces parcours. La première
exécution CI signée, les essais sur téléphone et l'activation éventuelle du
canal Play restent des étapes de livraison distinctes.
