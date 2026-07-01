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

## 3. Signature macOS — ⏳ en attente
Pour un DMG notarisé (DoD-2). À fournir en **secrets GitHub** du repo `sub-rosa` :
- `APPLE_CERTIFICATE` — certificat *Developer ID Application* exporté en `.p12`, encodé base64.
- `APPLE_CERTIFICATE_PASSWORD` — mot de passe du `.p12`.
- `APPLE_SIGNING_IDENTITY` — ex. `Developer ID Application: Ton Nom (TEAMID)`.
- `APPLE_ID` + `APPLE_PASSWORD` (mot de passe d'app) + `APPLE_TEAM_ID` — pour la notarisation.
  *(ou, en alternative, `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH` via App Store Connect.)*

Sans ces secrets : builds **non signées** produites localement (fonctionnelles, mais Gatekeeper avertit).

## 4. Signature Windows — ⏳ en attente
Pour un NSIS signé (DoD-2). En **secrets GitHub** :
- `WINDOWS_CERTIFICATE` — certificat code-signing `.pfx` encodé base64.
- `WINDOWS_CERTIFICATE_PASSWORD` — mot de passe du `.pfx`.
  *(ou service type Azure Trusted Signing / SignPath — dans ce cas, adapter `scripts/windows-sign.ps1`.)*

## 5. Clé updater Tauri — ⏳ en attente (paire générée par le fork)
- Le fork **génère** la paire (`pnpm tauri signer generate`). La **clé publique** va dans `tauri.conf.json`.
- L'humain stocke la **clé privée + son mot de passe** en secrets GitHub :
  - `TAURI_SIGNING_PRIVATE_KEY` — contenu de la clé privée générée.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — mot de passe choisi à la génération (peut être vide).
- ⚠️ La clé privée est **non récupérable** : sa perte oblige à migrer tous les clients. Ne jamais la committer.

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
