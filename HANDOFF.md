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

## 3. Signature macOS — ✅ signature / ⏳ notarisation
Certificat **Developer ID Application: Morgan Magalhaes (H6N5V777LL)** fourni (`.p12`, valide jusqu'à 2027-02).
Secrets GitHub **déjà posés** sur `sub-rosa` :
- `APPLE_CERTIFICATE` (`.p12` base64) · `APPLE_CERTIFICATE_PASSWORD` · `APPLE_SIGNING_IDENTITY` · `APPLE_TEAM_ID`.
- → La CI mac **signe** l'app + le sidecar + les helpers (Developer ID, hardened runtime). Vérifié aussi en local.

⏳ **Notarisation encore requise** pour lever complètement l'avertissement Gatekeeper au premier lancement.
Fournir en secrets : `APPLE_ID` + `APPLE_PASSWORD` (mot de passe d'app) *(le `APPLE_TEAM_ID` est déjà posé)*,
ou en alternative `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_P8_BASE64` (App Store Connect).
Sans ça : DMG **signé mais non notarisé** (installable ; Gatekeeper demande une confirmation au 1er lancement).

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

## 6. Token de publication des releases — ⏳ en attente
- Le repo source est **privé** mais les releases/updater doivent être **publics** (`sub-rosa-releases`).
- Fournir un **PAT** (fine-grained, scope `contents:write` sur `sub-rosa-releases`) en secret `RELEASES_REPO_TOKEN`
  pour que le workflow release y publie les artefacts + `latest.json`.

## 7. Identité de marque — ✅ décidée / ⏳ icônes définitives
- Nom = **Sub Rosa** ; identifiant bundle = `xyz.carpediem.subrosa` ; scheme deep-link = `subrosa://`.
- **Icônes** : placeholders générés par le fork. Fournir des sources définitives (`.icns`, `.ico`, `.png` 1024²)
  pour remplacer `src-tauri/icons/*` quand disponibles.

## 8. Licences tierces — ➖ à confirmer
- Vérifier `THIRD_PARTY_NOTICES.md` (runtime **Hermes** de l'agent) pour la redistribuabilité dans un binaire
  distribué. Signaler tout doute avant distribution large.

## 9. iOS / TestFlight — ✅ lane construite / ⏳ fiche App Store Connect

**Fait (2026-07-06)** : build App Store validé en local — `pnpm tauri ios build --export-method
app-store-connect` produit une IPA signée **Apple Distribution: Morgan Magalhaes (H6N5V777LL)**
avec le profil App Store (certificat créé automatiquement par la session Xcode du Mac ;
aucun `.p12` à gérer). Workflow CI : `.github/workflows/ios-release.yml` (dispatch manuel).

**Reste 1 action humaine — créer la fiche d'app** (l'upload échoue sinon sur
« Error Downloading App Information », le bundle id n'ayant pas d'app record) :
1. https://appstoreconnect.apple.com → Apps → « + » → **Nouvelle app**.
2. Plateforme **iOS** ; nom **Sub Rosa** (si pris : « Sub Rosa Notes » ou variante) ;
   identifiant **xyz.carpediem.subrosa** (déjà enregistré sur le portail par la signature
   automatique) ; SKU libre (ex. `subrosa-ios`).
3. Puis relancer l'upload local :
   ```bash
   xcodebuild -exportArchive \
     -archivePath "src-tauri/gen/apple/build/os-june_iOS.xcarchive" \
     -exportOptionsPlist /tmp/asc-upload/ExportOptions.plist \
     -exportPath /tmp/asc-upload/out -allowProvisioningUpdates
   ```
   (le plist = method app-store-connect + destination upload + teamID ; la session Xcode
   authentifie). Le build apparaît ensuite dans TestFlight après le traitement Apple.

**Pour la CI** (`ios-release.yml`) : poser les secrets `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, `APPLE_API_KEY_P8` (clé API App Store Connect, rôle App Manager,
`.p8` en base64) — la signature cloud crée le certificat sur le runner.

**À savoir** : icônes iOS = placeholders (mêmes sources que §7) ; l'App Store refusera une
icône 1024 avec canal alpha — fournir les icônes définitives avant la première soumission
publique (TestFlight interne est plus tolérant).
