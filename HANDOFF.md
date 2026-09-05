# HANDOFF — Ce que le fork Sub Rosa attend de l'humain

Éléments qui **ne peuvent pas** être produits automatiquement (comptes, certificats, secrets). Chacun est
référencé par le **nom de secret GitHub** attendu par la CI. **Aucun secret n'est jamais commité.**

État : `⏳ en attente` · `✅ fourni` · `➖ optionnel`

---

## 1. Clé Carpe Diem de test — ✅ fournie
- Clé `cdm_…` avec crédits, pour la validation E2E locale (P0/P3/DoD-1).
- Fournie en session le 2026-07-01. **Non commitée** ; utilisée uniquement en variable d'environnement locale.
- Pour la CI E2E (optionnel), la stocker en secret `CARPE_DIEM_TEST_API_KEY`.

## 2. Dépôts GitHub — ✅ créés
- `Irdanwen/sub-rosa` (privé) — source. `Irdanwen/sub-rosa-releases` (public) — artefacts de release + updater.
- Confirmer la permission d'écrire des **secrets Actions** sur `sub-rosa` et de **push des releases** sur `sub-rosa-releases`
  (le workflow release aura besoin d'un token — voir §6).

## 3. Signature macOS — ✅ signature / ✅ notarisation
Certificat **Developer ID Application: Morgan Magalhaes (H6N5V777LL)** fourni (`.p12`, valide jusqu'à 2027-02).
Secrets GitHub **déjà posés** sur `sub-rosa` :
- `APPLE_CERTIFICATE` (`.p12` base64) · `APPLE_CERTIFICATE_PASSWORD` · `APPLE_SIGNING_IDENTITY` · `APPLE_TEAM_ID`.
- → La CI mac **signe** l'app + le sidecar + les helpers (Developer ID, hardened runtime). Vérifié aussi en local.

✅ **Notarisation opérationnelle** (secrets App Store Connect posés ; `release.yml` notarise et agrafe chaque DMG,
vérifié sur v1.58.0 le 2026-09-02). Le runtime Hermes et les helpers Swift sont signés en profondeur pour
que la notarisation passe ; voir les étapes de signature du workflow. Un timeout Apple `-1001` se relance
avec `gh run rerun --failed`, on ne re-tagge jamais.

## 4. Signature Windows — ➖ volontairement non signé
Choix produit : **pas de signature Windows** pour l'instant. `scripts/windows-sign.ps1` **skip proprement** (exit 0)
quand `WINDOWS_CERTIFICATE_PATH`/`_PASSWORD` sont absents → la CI produit un **NSIS non signé** (SmartScreen avertit).
Pour signer plus tard : poser `WINDOWS_CERTIFICATE` (`.pfx` base64) + `WINDOWS_CERTIFICATE_PASSWORD` en secrets.

## 5. Clé updater Tauri — ✅ générée + secrets posés
- Paire générée (sans passphrase) : privée `.tauri-keys/sub-rosa-updater.key` (gitignored), publique déjà dans
  `tauri.conf.json` (`plugins.updater.pubkey`).
- Secrets GitHub **posés** : `TAURI_SIGNING_PRIVATE_KEY` (contenu de la clé) + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (vide).
- ⚠️ La clé privée est **non récupérable** : sauvegarde `.tauri-keys/sub-rosa-updater.key` hors du repo. Sa perte
  oblige à migrer tous les clients vers une nouvelle clé.

## 6. Token de publication des releases — ✅ posé
- Le repo source est **public** depuis l'été 2026 (CI gratuite) ; les releases/updater restent sur
  `sub-rosa-releases`, le point d'entrée de l'updateur.
- Le secret `RELEASES_REPO_TOKEN` (fine-grained, `contents:write` sur `sub-rosa-releases`) est posé :
  chaque tag `vX.Y.Z` y publie les artefacts + `latest.json` (huit releases la semaine du 2026-09-01).

## 7. Identité de marque — ✅ décidée / ✅ icônes définitives
- Nom = **Sub Rosa** ; identifiant bundle = `xyz.carpediem.subrosa` ; scheme deep-link = `subrosa://`.
- **Icônes** : la rose définitive est intégrée dans `src-tauri/icons/` et l'appiconset iOS
  de `src-tauri/gen/apple/` (source et régénération dans `FORK_NOTES.md`). Vérification du
  2026-09-05 : les 18 PNG de l'appiconset sont sans canal alpha, dont l'icône 1024².

## 8. Licences tierces — ➖ à confirmer
- Vérifier `THIRD_PARTY_NOTICES.md` (runtime **Hermes** de l'agent) pour la redistribuabilité dans un binaire
  distribué. Signaler tout doute avant distribution large.
- **Polices** : l'autorisation de redistribution des cinq WOFF2 de `public/` (ABC Diatype,
  Martina Plantijn, Berkeley Mono) reste à confirmer. Aucun justificatif n'a été trouvé
  dans le dépôt ; cela ne signifie pas que l'autorisation est absente.

## 9. iOS / TestFlight — ✅ opérationnel (premier build uploadé le 2026-07-06)

**Fait (2026-07-06)** : build App Store validé en local — `pnpm tauri ios build --export-method
app-store-connect` produit une IPA signée **Apple Distribution: Morgan Magalhaes (H6N5V777LL)**
avec le profil App Store et le certificat géré par la session Xcode locale.
La CI utilise ses propres assets de signature importés, décrits ci-dessous
(`.github/workflows/ios-release.yml`, dispatch manuel).

**Fiche d'app créée + premier build uploadé (2026-07-06).** Le premier build peut demander
la conformité chiffrement dans TestFlight (« Missing Compliance » → chiffrement standard
HTTPS = exempt) ; les suivants sont couverts par `ITSAppUsesNonExemptEncryption=false`
dans l'Info.plist. Pour uploader un nouveau build local :
   ```bash
   xcodebuild -exportArchive \
     -archivePath "src-tauri/gen/apple/build/os-june_iOS.xcarchive" \
     -exportOptionsPlist /tmp/asc-upload/ExportOptions.plist \
     -exportPath /tmp/asc-upload/out -allowProvisioningUpdates
   ```
   (le plist = method app-store-connect + destination upload + teamID ; la session Xcode
   authentifie). Le build apparaît ensuite dans TestFlight après le traitement Apple.

**Pour la CI** (`ios-release.yml`) : l'export utilise les assets importés, avec
le certificat Apple Distribution importé (`IOS_DIST_CERT_P12`, base64, et
`IOS_DIST_CERT_PASSWORD`), `APPLE_TEAM_ID` et les deux profils App Store importés
(`IOS_PROVISION_PROFILE` et `IOS_SHARE_PROVISION_PROFILE`, base64). Pour des profils
créés manuellement, la lane mappe leurs UUID. Les profils marqués `IsXcodeManaged`
imposent `signingStyle=automatic` : Xcode refuse leur usage en mode manuel, même
avec le bon UUID et certificat. La lane sélectionne donc le mode selon ce champ.
Elle ne crée pas ces
assets par signature cloud. Les secrets `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` et
`APPLE_API_KEY_P8` (`.p8` en base64) authentifient l'accès App Store Connect et l'upload.

Les icônes iOS définitives sont déjà intégrées et sans canal alpha (voir §7).

## Extension de partage iOS (ADR-0048) : ce qu'App Store Connect doit connaître

L'extension `os-june_Share` (`xyz.carpediem.subrosa.share`) est un second
bundle, signé à part, qui partage un App Group avec l'app. La lane
`ios-release.yml` l'exporte dès que ces quatre choses existent ; tant qu'elles
manquent, elle s'arrête à l'export avec un message clair plutôt que de
livrer une entrée du partage qui ne marche pas.

1. **App Group** : dans Certificates, Identifiers & Profiles › Identifiers ›
   App Groups, créer `group.xyz.carpediem.subrosa`.
2. **App ID de l'app** (`xyz.carpediem.subrosa`) : activer la capacité
   *App Groups* et cocher ce groupe. Le profil de distribution existant
   devient invalide : le régénérer et remplacer le secret
   `IOS_PROVISION_PROFILE` (base64 du `.mobileprovision`, nom « Sub Rosa
   App Store »).
3. **App ID de l'extension** : créer `xyz.carpediem.subrosa.share` avec la
   capacité *App Groups* sur le même groupe.
4. **Profil de l'extension** : un profil App Store pour cet App ID, nommé
   « Sub Rosa Share App Store », avec le même certificat de distribution ;
   son base64 va dans le secret `IOS_SHARE_PROVISION_PROFILE`.

Les noms proposés ci-dessus sont indicatifs : l'export manuel mappe leurs UUID ;
l'export automatique sélectionne les profils gérés par Xcode. En local, `pnpm tauri ios build --export-method
debugging` signe les deux cibles avec l'équipe `H6N5V777LL` en automatique une
fois le groupe créé.

**Vérification du 2026-09-05** : les entitlements de l'app et de l'extension déclarent
maintenant `group.xyz.carpediem.subrosa`, y compris dans les propriétés de `project.yml`
qui les régénèrent. Les deux profils de distribution doivent autoriser ce même App Group ;
leur conformité a été vérifiée dans l'IPA App Store 1.62.0 : les deux profils
autorisent ce groupe, excluent les appareils de développement et incluent le
certificat de distribution utilisé par la CI. Les deux secrets de profil ont été
remplacés par ces profils renouvelés. La clé App Store Connect n'a pas changé.

### Envoi local vérifié le 2026-09-05

La session Apple déjà enregistrée dans Xcode a pu créer les profils de l'app et
de l'extension avec App Groups, signer l'IPA et envoyer **1.62.0 (1.62.0)**.
Résultat à 18:28:58 CEST : `Upload succeeded`, puis `EXPORT SUCCEEDED` ; le
paquet est passé au traitement Apple. Aucune clé `.p8` locale n'était nécessaire.

Après `pnpm tauri ios build --export-method app-store-connect`, créer un plist
d'export avec `method=app-store-connect`, `destination=upload`,
`teamID=H6N5V777LL`, `signingStyle=automatic`,
`manageAppVersionAndBuildNumber=false` et `uploadSymbols=true`, puis appeler
`xcodebuild -exportArchive` comme au §9 avec `-allowProvisioningUpdates`.
Toujours vérifier la version des deux bundles et leurs profils dans l'IPA avant
l'envoi. Ne pas relancer un upload de la même version/build après un succès.

La lane CI accepte `upload=false` pour vérifier l'archive et l'export signé sans
envoyer un doublon. Le défaut reste `true`. Ne pas inclure `Externals` dans les
sources de `project.yml` : `libapp.a` est une dépendance de liaison, jamais une
ressource à copier. Deux archives debug/release copiées sous le même nom font
échouer le build Xcode (`Multiple commands produce .../libapp.a`).
