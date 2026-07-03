# FORK_NOTES — Sub Rosa (fork de June / os-june)

Ce fichier trace **chaque écart avec l'upstream** `open-software-network/os-june` (MIT) afin de garder
les synchronisations soutenables. Règle : **préférer l'ajout de fichiers** ; quand un fichier upstream doit
être modifié, garder le diff minimal, localisé, et le documenter ici.

- **Upstream** : `https://github.com/open-software-network/os-june.git` (remote `upstream`)
- **Fork base** : commit upstream `bce09361` (« Speed up macOS desktop release builds (#561) »)
- **Origin** : `git@github.com:Irdanwen/sub-rosa.git` (privé)
- **Releases/updater** : `Irdanwen/sub-rosa-releases` (public)

---

## Architecture du fork (résumé)

June parle à un backend `june-api` (crate `june`) qui détient les clés fournisseur et parle aux modèles.
Le fork **n'écrit rien** de cette logique : il **embarque `june-api` comme sidecar** et le pilote via les
Réglages. Carpe Diem = simple remplacement de `base_URL` (endpoint OpenAI-compatible, mêmes IDs de modèles
que Venice).

**Seam runtime (le cœur)** — June lit déjà l'URL et le bearer du backend à l'exécution via variables d'env :
- `src-tauri/src/june_api.rs::june_api_url()` lit `JUNE_API_URL` (runtime, non caché).
- `src-tauri/src/os_accounts.rs::access_token()` → en mode local, renvoie `OS_JUNE_LOCAL_DEV_BEARER_TOKEN`
  (gaté par `OS_JUNE_LOCAL_DEV`, user id `OS_JUNE_LOCAL_DEV_USER_ID`). Non caché.
- `load_local_env()` (dotenvy) charge un `.env` **une seule fois** et **n'écrase pas** l'env déjà défini.
  → Un `std::env::set_var(...)` fait dans le hook `.setup()` de Tauri est respecté par tous les appels suivants.

Le module fork `src-tauri/src/carpe_diem/` :
1. lit les réglages (base_URL en JSON non-secret, clé `cdm_` dans le **trousseau OS** via crate `keyring`) ;
2. choisit un **port TCP libre** + génère un **bearer aléatoire** ;
3. `set_var` en-process (`JUNE_API_URL`, `OS_JUNE_LOCAL_DEV=1`, `OS_JUNE_LOCAL_DEV_BEARER_TOKEN`, `OS_JUNE_LOCAL_DEV_USER_ID`) ;
4. **spawn `june-api`** avec l'env enfant (`JUNE__SERVER__PORT`, `JUNE__LOCAL_DEV__*`, `JUNE__UPSTREAMS__VENICE__BASE_URL/API_KEY`) ;
5. **health check** `/livez` avant de déclarer prêt ; redémarre au changement de clé/URL ; tue proprement au quit.

### Démarrage de `june-api` (mécanisme upstream, lu en P0)
- Dev upstream : `tauri.conf.json` → `beforeDevCommand` → `scripts/tauri-before-dev.mjs` spawn
  `cargo run -p june -- serve` (port `JUNE_API_PORT`/8080) **et** Vite (port `VITE_PORT`/1421). Réutilise le port si déjà ouvert.
- Le fork bascule ce dev pour que **l'app Rust** spawn le sidecar (dev = comme prod), `beforeDevCommand` ne lançant plus que Vite.
- Config `june-api` : Figment = `AppConfig::default()` → `config.toml` (dans le CWD) → env `JUNE__…` (séparateur `__`).
  Server bind `JUNE__SERVER__HOST:JUNE__SERVER__PORT` (défaut `127.0.0.1:8080` via config.toml `0.0.0.0:8080`).
- Endpoints **publics** (sans auth) : `/livez`, `/readyz`, `/healthz`, `/verify`, `/v1/models`. Les autres exigent `Authorization: Bearer <token>`.
- Auth local dev : `JUNE__LOCAL_DEV__ENABLED=true` → le bearer doit **matcher exactement** `JUNE__LOCAL_DEV__BEARER_TOKEN` ; `user_id` doit commencer par `usr_`.
- Le catalogue live `/models` de l'upstream est fetché au boot et mergé avec `config.toml` ; échec = **dégradation gracieuse** (warning, pas de crash), on garde les modèles de `config.toml`.

---

## Validation P0 (2026-07-01) — Carpe Diem

Clé `cdm_` de test fournie par l'utilisateur (jamais commitée ; utilisée en env local uniquement).

- ✅ **Transcription directe** Carpe Diem `POST /audio/transcriptions` (multipart, `nvidia/parakeet-tdt-0.6b-v3`)
  sur un WAV réel (macOS `say`) → **HTTP 200**, transcript renvoyé. *Le risque #1 du brief (multipart) est levé.*
- ✅ **Génération directe** Carpe Diem `POST /chat/completions` (`zai-org-glm-5-2`) → **HTTP 200**, résumé correct, usage compté (crédits OK).
- ✅ **`june-api` en mode local contre Carpe Diem** : boot OK, `/livez` `/readyz` `/healthz` = 200, écoute sur le port dynamique.
- ✅ **Tous les IDs de modèles par défaut de June existent chez Carpe Diem** (catalogue de 283 modèles) :
  `nvidia/parakeet-tdt-0.6b-v3`, `zai-org-glm-5-2`, `nvidia-nemotron-3-nano-30b-a3b`, `kimi-k2-6`, `zai-org-glm-5-1`, `zai-org-glm-5`.
- ⚠️ **Limitation connue** : le fetch du catalogue live au boot **échoue au parse** (le parseur Venice de
  `june-api/crates/providers/src/venice.rs` attend le schéma natif Venice ; Carpe Diem renvoie un schéma
  OpenAI `{object:"list",data:[{id,carpe_diem_type,…}]}`). Dégradation gracieuse → **6 modèles curatés** de
  `config.toml` (dont les défauts) restent disponibles. Correctif ciblé prévu (voir tâche dédiée) pour
  synchroniser le catalogue complet dans le sélecteur de modèles.

---

## Fichiers upstream modifiés

| Fichier(s) | Raison | Re-merge |
|---|---|---|
| `src-tauri/tauri.conf.json` | `productName`/`identifier`/titres fenêtres, scheme deep-link `osjune`→`subrosa`, `beforeDevCommand`→`pnpm run dev` (l'app spawn le sidecar). `externalBin`+updater ajoutés en P5/P7. | Garder les valeurs fork ; reprendre les champs upstream nouveaux |
| `src-tauri/tauri.macos.conf.json` / `.windows.conf.json` | `bundleName`/`publisher` rebrandés | Trivial |
| `src-tauri/build.rs` | Helper Swift : `CFBundleIdentifier`/`DisplayName`/`Name` + usage descriptions rebrandés (`co.opensoftware.june.*`→`xyz.carpediem.subrosa.*`) | Garder les IDs fork |
| `src-tauri/native/mac-dictation-helper/main.swift` | `ignoredBundleIdentifiers` aligné sur le nouveau bundle id du helper | 1 ligne |
| `src-tauri/Info.plist`, `index.html` | Chaînes visibles « June »→« Sub Rosa » | Trivial |
| `src-tauri/src/os_accounts.rs` | `KEYCHAIN_SERVICE`/`DEV_KEYCHAIN_SERVICE` rebrandés (le scheme OAuth `osjune://` interne est laissé — mort en mode local ; voir note) | 2 constantes |
| `src-tauri/src/lib.rs` | `pub mod carpe_diem;` + `settings::setup`/`sidecar::setup` dans `.setup()` + commandes IPC dans `invoke_handler` + `sidecar::shutdown` dans `RunEvent::Exit` | Réappliquer les 4 hooks |
| `src-tauri/icons/*` | Icônes placeholder Sub Rosa (régénérées via `tauri icon`) | Remplacer par les sources définitives |
| `src/app/App.tsx` | Gate Carpe Diem (état + effet + `carpeDiemRequired` dans `appBlocked` + rendu du gate avant l'onboarding) | Réappliquer le bloc gate |
| `src/components/settings/AppSettings.tsx` | Onglet « Carpe Diem » (union `SettingsTab` + `SETTINGS_TABS` + rendu de `<CarpeDiemSettings/>`) ; Models › More options : `VeniceApiKeyRow` (BYOK Venice) remplacée par `CarpeDiemKeyRow` (lien vers l'onglet Carpe Diem + purge d'une clé Venice legacy, qui écraserait la clé `cdm_` par requête) | 3 points + 1 rangée |
| `src/components/sidebar/Sidebar.tsx` | Entrée « Carpe Diem » ajoutée au groupe Personal de `SETTINGS_SIDEBAR_GROUPS` (sinon l'onglet est inatteignable) | 1 item |
| `src/lib/tauri.ts` | Wrappers IPC `carpeDiem*` + types (ajout en fin de section provider) ; valeur `JUNE_COMMUNITY_URL`→`https://carpe-diem.xyz` | Additif |
| ~50 fichiers `src/**` (composants + `lib/`) | Rebrand des **chaînes visibles** « June »→« Sub Rosa » (identifiants techniques laissés : `june://`, `JUNE_*`, clés `os-june:*`, noms de symboles) | Conflits attendus ; garder « Sub Rosa » dans le texte visible |
| ~14 fichiers `src/test/**` | Assertions alignées sur la copie rebrandée ; 3 tests App ajoutent le mock `carpeDiemSidecarStatus` | Aligner sur le texte fork |

> **Note deep-link scheme** : la registration OS (tauri.conf) est `subrosa`. Le callback OAuth OS Accounts
> (`osjune://…` dans `os_accounts.rs`) est **inutilisé** en mode local (OS Accounts = hors périmètre) et laissé
> tel quel pour minimiser le diff + éviter la casse des tests. À aligner si OS Accounts est un jour réactivé.

## Fichiers ajoutés par le fork (préférés)

| Fichier | Rôle |
|---|---|
| `FORK_NOTES.md`, `HANDOFF.md` | Traçabilité fork + handoffs humains |
| `src-tauri/src/carpe_diem/{mod,branding,settings,sidecar}.rs` | Branding Rust + store réglages/keyring + IPC + **gestionnaire de sidecar june-api** |
| `src/lib/branding.ts` | Constantes de marque + défauts Carpe Diem (frontend) |
| `src/components/settings/CarpeDiemSettings.tsx` | Section Réglages (base URL + clé + test + statut sidecar) |
| `src/components/carpe-diem/CarpeDiemGate.tsx` | Écran de connexion premier lancement |
| `src/test/carpe-diem-settings.test.tsx` | Tests UI Carpe Diem |

### Distribution (P5–P8)

**Modifiés en plus :**
| Fichier | Raison |
|---|---|
| `src-tauri/src/updates.rs` | `STABLE_ENDPOINT`/`RC_ENDPOINT` → `Irdanwen/sub-rosa-releases` (Rust possède l'endpoint runtime de l'updater) |
| `scripts/tauri-build.mjs` | Pré-build du sidecar (`build-sidecar.mjs`) avant le bundling ; `SKIP_SIDECAR_BUILD=1` pour la CI |
| `scripts/build-signed-dmg.sh` | Pré-build du sidecar avant le build signé (ce script bypasse tauri-build.mjs) |
| `README.md` | Réécrit pour Sub Rosa (install utilisateur + clé Carpe Diem + dev) + attribution |
| `src-tauri/tauri.conf.json` | (déjà listé) + `externalBin: binaries/june-api`, resource `config.toml`, updater pubkey (nouvelle clé) + endpoint |

**Ajouts :**
| Fichier | Rôle |
|---|---|
| `scripts/build-sidecar.mjs` | Compile `june-api` release par triplet → `src-tauri/binaries/june-api-<triple>` |
| `scripts/build-updater-manifest.py` | Assemble `latest.json` (préfixe les artefacts par plateforme) |
| `.github/workflows/upstream-sync.yml` | PR de sync upstream hebdomadaire |
| `.github/workflows/release.yml` | Build signé multi-OS + publication updater sur `sub-rosa-releases` |

### Décisions produit / findings
- **Sidecar bundling** : `externalBin` embarque `june-api` dans `Contents/MacOS/june-api` ; Tauri le **signe avec l'app**
  (même Developer ID + hardened runtime) automatiquement. Spawn via `std::process` (pas le plugin shell) → **aucune
  capability à ajouter**. `config.toml` bundlé en resource (cwd = resource dir en prod). Vérifié : `Sub Rosa.app` + DMG
  contiennent le sidecar, le binaire embarqué boote contre Carpe Diem, artefacts updater `.app.tar.gz` + `.sig` générés.
- **Seatbelt** : le write-jail de June n'est appliqué **qu'au sous-processus Hermes** (`hermes_bridge.rs`, `sandbox-exec`),
  pas globalement → le sidecar `june-api` tourne sans restriction (le risque #2 du brief est levé).
- **Entitlements** : `com.apple.security.device.audio-input` suffit ; le sidecar (client réseau + listener loopback)
  n'a besoin d'aucun entitlement supplémentaire (June n'est pas App-Sandboxed).
- **Keychain (test)** : un item créé par la CLI `security` n'est pas lisible par un binaire ad-hoc/non signé (ACL) — d'où
  l'escape hatch `SUBROSA_DEV_API_KEY`. En prod, l'app **crée** l'item via l'UI → le relit sans souci (même identité signée).
- **Catalogue de modèles (tâche 12, différée)** : Carpe Diem renvoie `/models` en shape OpenAI que le parseur Venice de
  `june-api/crates/providers/src/venice.rs` rejette (parse error). Dégradation gracieuse → **6 modèles curatés** de
  `config.toml` (parakeet, glm-5-2/5-1/5, kimi-k2-6, nemotron-nano) — exactement les défauts. Le mode local désactive le
  billing, donc la classification de prix est sans objet. Un fallback tolérant surfacerait les 283 modèles mais alourdit
  le merge upstream ; non nécessaire pour l'usage notes de réunion. « Tester la connexion » interroge Carpe Diem en direct.

## Escape hatch dev
- `SUBROSA_DEV_API_KEY` (env, **debug uniquement**) : injecte la clé sans passer par le trousseau, pour
  `pnpm tauri:dev` (le trousseau refuse un item créé par un autre binaire). Jamais compilé en release.

---

## Procédure de synchronisation upstream (voir aussi `.github/workflows/upstream-sync.yml`)

1. `git fetch upstream`
2. Brancher `sync/upstream-<date>` depuis `main`, `git merge upstream/main`.
3. Conflits attendus sur les fichiers listés « modifiés » ci-dessus (surtout `tauri.conf.json`, `lib.rs`,
   `os_accounts.rs`, scripts de build). Résoudre en gardant la logique fork (module `carpe_diem/`, branding).
4. CI verte (`pnpm check`, `typecheck`, `test`, `test:rust`, `test:june-api`) → PR → merge.
