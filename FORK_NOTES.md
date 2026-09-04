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
- ✅ **Catalogue complet au boot** (résolu 2026-07-04, ex-limitation connue) : le parseur de
  `june-api/crates/providers/src/venice.rs` retombe sur le schéma OpenAI de Carpe Diem
  (`{object:"list",data:[{id,carpe_diem_type,…}]}`) quand le schéma Venice ne parse pas, et joint le pricing
  opérateur → ~94 modèles (89 text + 5 asr) dans le sélecteur. Détail dans « Découvertes » plus bas.

---

## Fichiers upstream modifiés

| Fichier(s) | Raison | Re-merge |
|---|---|---|
| `src-tauri/tauri.conf.json` | `productName`/`identifier`/titres fenêtres, scheme deep-link `osjune`→`subrosa`, `beforeDevCommand`→`pnpm run dev` (l'app spawn le sidecar). `externalBin`+updater ajoutés en P5/P7. | Garder les valeurs fork ; reprendre les champs upstream nouveaux |
| `src-tauri/tauri.macos.conf.json` / `.windows.conf.json` | `bundleName`/`publisher` rebrandés | Trivial |
| `src-tauri/build.rs` | Helper Swift : `CFBundleIdentifier`/`DisplayName`/`Name` + usage descriptions rebrandés (`co.opensoftware.june.*`→`xyz.carpediem.subrosa.*`) | Garder les IDs fork |
| `src-tauri/native/mac-dictation-helper/main.swift` | `ignoredBundleIdentifiers` aligné sur le nouveau bundle id du helper | 1 ligne |
| `src-tauri/Info.plist`, `index.html` | Chaînes visibles « June »→« Sub Rosa » | Trivial |
| `src-tauri/src/os_accounts.rs` | **Vidé** (1556 → ~170 lignes) : PKCE, store keychain de tokens, refresh, snapshot, `setup_deep_link` et les 7 commandes supprimés. Ne reste qu'un shim de session locale — `access_token`/`refresh_access_token` (bearer du sidecar), `cached_signed_in` (« le backend répond »), `load_local_env`, `open_in_browser`. Chemin et noms publics **gardés exprès** pour que les 7 fichiers appelants ne bougent pas (ADR 0017) | Conflit de contenu, pas d'add/delete. Tout apport upstream sur OAuth/keychain/billing est à **jeter**, pas à porter |
| `src-tauri/src/lib.rs` | `pub mod carpe_diem;` + `settings::setup`/`sidecar::setup` dans `.setup()` + commandes IPC dans `invoke_handler` + `sidecar::shutdown` dans `RunEvent::Exit` | Réappliquer les 4 hooks |
| `src-tauri/icons/*`, `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/*` | Icônes définitives Sub Rosa (rose sur fond prune, source `AppIcon.icns` 1024px sur le ProtonDrive `Projets Crypto/Sub-Rosa/`). ⚠️ `tauri icon` écrit les icônes iOS **directement dans l'appiconset de `gen/apple`** (jamais dans `icons/ios/`, qui n'est qu'une copie de courtoisie) ; ensuite retirer le canal alpha de tous les PNG iOS (App Store le refuse), p.ex. via un round-trip CoreGraphics `noneSkipLast`. ⚠️ Ne pas oublier les **icônes de dock thémées** `icons/themed/icon-<accent>.png` (embarquées dans le binaire par `theme_icon.rs` et appliquées au lancement via `set_dock_icon` — si elles restent sur l'ancien visuel, le dock affiche l'ancienne icône quelques instants après le launch, cf. v1.5.0-v1.6.2) : les régénérer avec `icons/themed/_src/generate.py` (rose recolorée par accent depuis `icon.icns` ; l'accent par défaut « rose » reste identique à l'icône du bundle) | Regénérer via `tauri icon`, resynchroniser `icons/ios/` depuis l'appiconset, aplatir l'alpha des PNG iOS, puis relancer `icons/themed/_src/generate.py` |
| `src/components/brand/roseMark.ts` (nouveau), `src/components/brand/JuneWordmark.tsx`, `src/components/account/AccountGate.tsx`, `src/styles/{hud,agent-hud,meeting-hud}.css`, `src/styles/app.css`, `src/assets/june-mark.svg`, `src-tauri/icons/tray-icon-template.png` | **Glyphe rose partout dans l'UI** : le zigzag June est remplacé par la rose Sub Rosa (path unique `ROSE_MARK_PATH`, viewBox `0 0 24 24` plein cadre, tracé potrace depuis `icon.icns`). Consommateurs : wordmark sidebar (`JuneWordmark`), `JuneMark`/`JuneGradientMark` (gates, onboarding, popover d'update, referral, hero chat mobile — noms de composants gardés), `--mark` en data-URI dans les 3 CSS de HUD (tailles de masque passées carrées), `.welcome-mark-symbol` 30×35→32×32, icône de menu bar (template alpha 44×44, testée par `menu_bar::tests`). Supprimés car morts : `public/os-june-{light,dark}.svg`, `src-tauri/icons/june-app-icon.svg` | Réappliquer le swap de glyphe ; garder le path des CSS HUD et de `roseMark.ts` en sync |
| `src/app/App.tsx` | Gate Carpe Diem (état + effet + `carpeDiemRequired` dans `appBlocked` + rendu du gate avant l'onboarding). Les gates compte (`signInRequired`, `fundingRequired`, `devAccountsUnconfigured`, `handleAccountChanged`, `handleSignOut`) sont **supprimés** ; le probe sidecar est borné (8 s) et rend `StartupFailure` en cas d'échec — c'est le garde anti-fenêtre-blanche upstream #853, déplacé du lookup compte vers le sidecar | Réappliquer le bloc gate ; **ne pas** réintroduire les gates compte |
| `src/components/settings/AppSettings.tsx` | Onglet « Carpe Diem » (union `SettingsTab` + `SETTINGS_TABS` + rendu de `<CarpeDiemSettings/>`) ; Models › More options : `VeniceApiKeyRow` (BYOK Venice) remplacée par `CarpeDiemKeyRow` (lien vers l'onglet Carpe Diem + purge d'une clé Venice legacy, qui écraserait la clé `cdm_` par requête) | 3 points + 1 rangée |
| `src/components/sidebar/Sidebar.tsx` | Entrée « Carpe Diem » ajoutée au groupe Personal de `SETTINGS_SIDEBAR_GROUPS` (sinon l'onglet est inatteignable) ; footer `SidebarIdentity` : une fois le solde chargé (`useCarpeDiemCredits`), le libellé « You » est remplacé par « N credits · ×0.42 » (solde disponible + facteur de prix du jour) avec icône carte | 1 item + bloc footer |
| `src/lib/tauri.ts` | Wrappers IPC `carpeDiem*` + types (ajout en fin de section provider) ; valeur `JUNE_COMMUNITY_URL`→`https://t.me/CarpeDiemCommu` (miroir d'affichage de la constante dans `commands.rs`, qui ouvre réellement le lien). Bloc `osAccounts*` + types `Account*`/`ReferralSummary` **supprimés** | Additif ; jeter tout apport upstream sur `osAccounts*` |
| `src-tauri/src/hermes_bridge.rs` + `src-tauri/src/hermes/june_web_mcp.py` | **Bugfix (candidat upstream, 2026-07-04)** : le MCP `june_web` relit les coordonnées du proxy (port éphémère + token) depuis `hermes-mcp/june_web_proxy.json` **à chaque appel d'outil**, au lieu d'argv/env figés au spawn. Sans ça, la gateway Hermes (launchd, survit à l'app) garde le port d'un ancien lancement après relance de l'app → toutes les routines cron échouent en `web_search`/`web_fetch` avec `[Errno 61] Connection refused`. Le script garde un mode legacy (argv = URL http, token en env) pour les process spawnés depuis une vieille config. | Proposer upstream ; sinon réappliquer fichier-coordonnées + entrée YAML `june_web` |
| `src-tauri/src/hermes_bridge.rs`, `scripts/bundle-hermes-runtime-windows.ps1`, `.github/workflows/{release,desktop}.yml` (Windows runtime, 2026-07-04) | **Fix runtime Hermes Windows** : (1) bug PowerShell dans le bundling CI — la restauration d'une env var absente écrivait `""` au lieu de la supprimer (coercion `$null`→`""` de PowerShell), tous les appels `uv` suivants échouaient (`UV_PYTHON_INSTALL_BIN … expected a boolish value`), et `continue-on-error` avalait l'échec → le NSIS v1.0.3 est sorti **sans** runtime embarqué ; (2) bundling Windows désormais bloquant dans `release.yml` + vérification explicite des fichiers du bundle ; (3) `WINDOWS_MANAGED_HERMES_INSTALL_SCRIPT` réécrit : bootstrap d'un `uv.exe` standalone épinglé (URL+SHA256 constantes dans `hermes_bridge.rs`, à garder en sync avec le .ps1) qui installe son propre CPython 3.11 — plus aucun besoin d'un Python système chez l'utilisateur ; (4) copy d'erreur visible neutralisée (« built-in agent runtime », plus de « June »/« Hermes ») ; (5) `desktop.yml` (job windows-rust) parse la syntaxe de tous les `.ps1` **et** du script embarqué | Réappliquer les 5 blocs ; garder l'URL/SHA uv en sync entre `hermes_bridge.rs` et le .ps1 |
| `scripts/patch-hermes-cron-shadow.sh` (nouveau), `scripts/bundle-hermes-runtime.sh`, `scripts/bundle-hermes-runtime-windows.ps1`, `src-tauri/src/hermes_bridge.rs` (MANAGED + WINDOWS_MANAGED install scripts) (**Fix 500 Routines**, 2026-07-06) | **Fix collision `sys.path` du plugin `cron`** : `plugins/platforms/{raft,discord}/adapter.py` font `sys.path.insert(0, parents[2])` — pour un adaptateur à `plugins/platforms/<name>/adapter.py`, `parents[2]` = `hermes-agent/plugins`. Inséré en tête de `sys.path`, ça fait résoudre le nom top-level `cron` vers le plugin `plugins/cron/` (provider de scheduler, sans sous-module `jobs`) au lieu du core `cron/`. Tout endpoint cron du dashboard fait alors `from cron import jobs` → `ImportError: cannot import name 'jobs' from 'cron'` → **HTTP 500** → bannière « Hermes API returned 500 » sur la page Routines. Intermittent : ne mord qu'une fois qu'un adaptateur de plateforme se charge et que son insert gagne le slot `sys.path[0]` après celui de `web_server` (PROJECT_ROOT). Reproduit et corrigé end-to-end (500→200) le 2026-07-06. **Fix** : pointer les deux inserts vers `parents[3]` (racine hermes-agent), comme le font déjà les `gateway/platforms/*.py` (un niveau moins profonds, donc leur `parents[2]` est déjà la racine — **ne pas y toucher**). Patch scopé aux 2 fichiers, idempotent, appliqué dans les 4 chemins qui déposent la source hermes-agent (2 bundles + 2 installeurs managés). | Réappliquer le patch dans les 4 chemins ; si upstream corrige (ou renomme le plugin `cron`), le patch devient no-op / à retirer |
| `src-tauri/tauri.conf.json` (fenêtre `main`, durcissement WebView2, 2026-07-08) | **`additionalBrowserArgs` : désactivation préventive de Local Network Access dans le webview.** Historique honnête : ajouté comme fix supposé du bug « Could not connect to Hermes gateway » sur un PC d'entreprise (stratégie Edge `LocalNetworkAccessAllowedForUrls` repérée dans `edge://policy`) — **ce n'était pas la cause** : le diagnostic sur machine (dump registre) a montré que WebView2 n'applique pas les stratégies du navigateur Edge (arbres `Policies\Microsoft\Edge\WebView2` vides) et le flag actif n'a pas résolu le bug. La vraie cause était le garde Origin du serveur Hermes (voir la ligne « Fix WS origin_mismatch » ci-dessous). L'arg est **conservé** en défense : Chromium déploie Local Network Access par défaut (M138+), et le jour où WebView2 l'active, le `ws://127.0.0.1` du chat serait bloqué. Conserve les défauts Tauri (`msWebOOUI,msPdfOOUI,msSmartScreenProtection`) qu'un `additionalBrowserArgs` explicite écraserait sinon. No-op hors Windows. | Garder l'arg ; si Tauri change ses défauts, re-fusionner la liste `msWebOOUI,…` |
| `scripts/patch-hermes-ws-origin.sh` (nouveau), `scripts/bundle-hermes-runtime.sh`, `scripts/bundle-hermes-runtime-windows.ps1`, `src-tauri/src/hermes_bridge.rs` (MANAGED + WINDOWS_MANAGED install scripts) (**Fix WS `origin_mismatch` Windows**, 2026-07-09) | **Le chat Windows ne s'est jamais connecté : garde Origin du dashboard Hermes.** `hermes_cli/web_server.py` protège `/api/ws` (et `/api/pty`) contre le DNS-rebinding : si le handshake WS porte un header `Origin` en `http(s)`, son hôte doit appartenir à `_LOOPBACK_HOST_VALUES = {localhost, 127.0.0.1, ::1}` (`_ws_host_origin_reason`), sinon `ws.close(4403)` **avant** accept → échec de handshake → bannière « Could not connect to Hermes gateway ». Or le webview Tauri v2 Windows sert l'app depuis **`http://tauri.localhost`** → `origin_mismatch` systématique. macOS passe car WKWebView est sur `tauri://localhost`, schéma non-web que le garde exempte explicitement ; tout le HTTP passe par le proxy Rust, donc **seul** le WS cassait (modèle/crédits OK, chat KO). Diagnostiqué sur machine utilisateur (backend HTTP 200 au moment de l'erreur + flag LNA actif = causes réseau éliminées), confirmé en lisant la source épinglée. **Fix** : ajouter `"tauri.localhost"` à `_LOOPBACK_HOST_VALUES` (ligne 331, unique avec son indentation ; un jumeau **non indenté** existe dans `_local_dashboard_request` et ne doit pas être touché). `*.localhost` = loopback par RFC 6761 (imposé par Chromium), donc zéro surface de rebinding ajoutée — le cas `evil.test` reste rejeté (vérifié contre la logique du garde épinglé). Patch idempotent appliqué dans les 4 chemins qui déposent la source hermes-agent (2 bundles + 2 installeurs managés), comme le fix cron-shadow. ⚠️ même limite que cron-shadow : un runtime **managé** déjà installé au même commit épinglé n'est pas re-patché (l'installeur ne re-tourne pas) ; les runtimes **bundlés** (NSIS/DMG) le sont à chaque build. | Réappliquer dans les 4 chemins ; si upstream ajoute `tauri.localhost` (candidat upstream) le patch devient no-op ; si upstream reformate la ligne 331, ré-ancrer les 3 motifs (`bad`/`good` du .sh, sed du script unix, `.Replace` des 2 .ps1) |
| `src-tauri/windows/installer-hooks.nsh` (nouveau) + `src-tauri/tauri.windows.conf.json` (**Fix update Windows bloquée par le gateway**, 2026-07-10) | **Les mises à jour Windows exigeaient de tuer les processus à la main.** Le gateway Hermes (daemon des Routines) est conçu pour **survivre à l'app** (lancé depuis le dossier Démarrage) ; son `python.exe` tourne **depuis le dossier d'installation** et verrouille les fichiers que le NSIS doit remplacer. Le template NSIS de Tauri ne ferme que l'exécutable principal → update bloquée (dialogues retry/abort) ou runtime à moitié remplacé, kills manuels obligatoires. **Fix** : hooks `NSIS_HOOK_PREINSTALL`/`PREUNINSTALL` (`installerHooks` dans `tauri.windows.conf.json`) qui stoppent tout processus dont l'exécutable est sous `$INSTDIR` (scope par chemin : ne peut jamais toucher un python/app tiers). Le gateway repart tout seul (`start_hermes_gateway_if_needed` au lancement + entrée Démarrage au login). Attention au quoting NSIS : chaîne backtick, `$$_` pour le `$_` PowerShell. | Garder le hook ; si Tauri ferme un jour les processus enfants nativement, il devient redondant (pas nuisible) |
| `src-tauri/tauri.conf.json` + `src-tauri/src/hermes_bridge.rs` (skills bundlés, 2026-07-05 ; +remotion 2026-07-10) | **Pack de skills par défaut** : les 15 dossiers `.agents/skills/carpe-diem-*` du repo + `.agents/skills/remotion-best-practices` (skill officiel `remotion-dev/skills`, suivi dans `skills-lock.json`) sont bundlés en resources (`resources/skills/`) et `external_skill_dirs(app)` (ex-`external_skill_dirs()`) ajoute `resource_dir/skills` **après** les `~/.agents/skills` utilisateur (une copie utilisateur shadow le skill livré ; helpers `bundled_skill_dir`/`merge_external_skill_dirs`, précédence testée). Read-only dans l'éditeur de skills comme tout external dir. `tauri.ios.conf.json` garde `resources: null` → rien ne part sur iOS (pas de Hermes mobile). | Réappliquer les 17 entrées resources + le trio de fns ; re-lister les dossiers si le pack skills change |
| `src-tauri/src/hermes_bridge.rs` + `src-tauri/src/hermes/june_media_mcp.py` (nouveau) (MCP média agent, 2026-07-05) | **Outils média de l'agent** : MCP `june_media` (`generate_image`, `generate_video`, `generate_music`, `check_media`, `list_media_models`) sur le patron `june_web` (script + fichier de coordonnées partagé, relu à chaque appel). Le provider proxy loopback gagne 3 routes : `POST /v1/media/request` (délègue au proxy allowlisté du Studio `carpe_diem::media::carpe_diem_media_request` — la clé reste dans le process Rust), `POST /v1/media/save` (télécharge/décode dans la galerie `studio-media/` via les commandes artifact, retourne le path) et `GET /v1/media/catalog` (relaye le catalogue fusionné du Studio — traits/tier/prix/contraintes par modèle — pour que l'agent choisisse le modèle adapté à chaque demande ; défaut = trait Venice `default`, jamais l'ordre alphabétique). `AppHandle` threadé dans le proxy (`ensure_provider_proxy(app, bridge)`). Note `JUNE_SOUL_MEDIA_MD` ajoutée aux deux souls (sans le mot « sandbox », gardé par `unsandboxed_soul_makes_no_sandbox_claims`). Motivation : le jail Seatbelt bloque le keychain, donc le CLI du skill carpe-diem-media ne peut pas résoudre de clé en session sandboxée. | Réappliquer script + consts + 2 routes + threading AppHandle + entrée YAML + soul note |
| `june-api/crates/providers/src/venice.rs` | **Fallback catalogue Carpe Diem** : `priced_models` tente le shape Venice puis le shape OpenAI-flat (`carpe_diem_type`) + join `GET {racine}/pricing` (structs `CarpeDiem*`, `carpe_diem_priced_model_items`). Sans lui, retour aux 6 modèles curatés de `config.toml`. | Conflits probables sur `priced_models`/`fetch_models` ; réappliquer le bloc fallback (les fns/structs `carpe_diem_*` sont additives) |
| `june-api/crates/config/src/lib.rs` (`UpstreamConfig::operator_root`/`catalog_base_url`), `june-api/crates/providers/src/{venice,venice_image,venice_augment}.rs` (constructeurs catalogue/image/augment), `src-tauri/src/carpe_diem/{branding,settings,media}.rs`, `src/lib/branding.ts` (**split rail `/router` vs `/v1`**, 2026-07-22) | **Adoption du rail best-price `/router` de Carpe Diem.** CD a ajouté `…/api/operator/router` (agrégateur qui price chat/embeddings/audio sur Carpe + marchés externes, sert le moins cher, retombe sur Carpe — **peut sortir les prompts du TEE**) **en plus** de `…/api/operator/v1`. Le `/router` ne miroir QUE les chemins OpenAI-standard (chat, embeddings, audio) ; **images (reshapées OpenAI), vidéo, `/augment/*`, `/models`, `/pricing`, `/credits`, `/prepaid/*` n'existent que sous `/v1`**. Décision produit : **défaut passe à `/router`** (nouveaux installs ; les installs ayant déjà stocké `/v1` le gardent — pas d'upgrade auto). Mécanique : la base stockée = **rail d'inférence** ; les endpoints hors-router **dérivent** le `/v1` via `operator_root()`/`catalog_base_url()` (strip `/router`→`/v1`). june-api : chat (`VeniceChat`) + transcribers restent sur `base_url` (donc `/router`) ; `VeniceModelCatalog`/`VeniceImageGenerator`/`VeniceAugment` passent à `config.catalog_base_url()`. Pas de nouveau champ de config (donc **zéro churn des littéraux `UpstreamConfig` de test** ; une base sans suffixe `server.uri()` reste inchangée). src-tauri : `settings::{operator_root,catalog_base_url,default_catalog_base_url}` ; `media.rs` (proxy + catalogue + `resolve_media_url`) et `settings.rs` (test/credits/billing) épinglés au catalogue. Embeddings mémoire restent sur le rail d'inférence (`recall.rs`, inchangé) — modèle épinglé par id, risque de vecteurs incohérents ~nul (fallback Carpe). **UI (2026-07-22)** : plus de champ libre de base URL ; `CarpeDiemSettings.tsx` (composant fork, desktop + mobile compact) expose un `SegmentedControl` **V1 / Router** avec message d'avantage/avertissement dynamique (Router = « peut sortir du réseau confidentiel »). Le DTO `CarpeDiemSettingsDto` porte `router_base_url`/`v1_base_url` (dérivés de `operator_root()`) ; le choix appelle `carpe_diem_set_base_url` avec l'URL correspondante (pas de nouvelle commande). | Réappliquer les 2 méthodes sur `UpstreamConfig` (additives) + les 3 constructeurs `catalog_base_url()` ; si upstream change `base_url`, garder le principe « base stockée = inférence, catalogue dérivé ». Si CD mirror un jour `/models`/images/etc. sous `/router`, ce split devient simplifiable |
| `june-api/crates/providers/src/{retry,venice,venice_image,venice_augment,openai}.rs`, `src-tauri/src/agent_lite/mod.rs`, `src-tauri/src/june_api.rs` (**402 amont → insufficient_credits**, 2026-07-14) | **Un 402 de Carpe Diem ne doit plus se déguiser en 502 `upstream_provider_failed`.** Upstream June collapse tout statut non-2xx amont en `DomainError::UpstreamProvider` — logique là-bas (la clé Venice est celle de June, un 402 = leur problème d'infra), fausse ici (la clé `cdm_` est celle de l'utilisateur : un 402 = son solde/rail prepaid). Helper `retry::error_for_status` (402 → `DomainError::InsufficientCredits`, sinon `UpstreamProvider`) appliqué aux 6 sites de collapse facturés (transcription Venice+OpenAI, chat note-gen, proxy agent chat, image, augment) → le sidecar répond `402 insufficient_credits` (4301), déjà rendu en bannière/notice crédits par le frontend (`isInsufficientCreditsMessage`). Mobile : agent-lite spécial-case le 402 (`agent_lite_credits`, « balance is too low » pour matcher le matcher). Desktop : libellé client `june_api.rs` re-wording fork (« Your Carpe Diem balance is too low. Top up your credits to continue. »). Contexte : incident CD du 2026-07-14 (rail prepaid refusant tout malgré solde OK) affiché comme une panne provider opaque. | Réappliquer le helper + le mapping aux 6 sites (attention : upstream considère un 402 comme SIEN — ne pas reprendre leur logique), le branch 402 d'agent-lite et le libellé de `june_api.rs` |
| `june-api/crates/{domain/src/lib.rs, services/src/error.rs, api/src/error.rs, api/src/envelope.rs, api/src/handlers/issues.rs, providers/src/retry.rs}`, `src-tauri/src/agent_lite/mod.rs`, `src/lib/{errors.ts, agent-chat-runtime.ts}`, `src/components/{agent/AgentWorkspace.tsx, note-editor/NoteFailureBanner.tsx}` (**429 amont → upstream_rate_limited**, 2026-07-17, [ADR-0012](docs/adr/0012-upstream-rate-limit-distinct-from-provider-failure.md)) | **Jumeau du 402 ci-dessus, pour le 429.** Un rate-limit amont (`429 UPSTREAM_RATE_LIMIT` / « rate limit reached ») ne doit plus se déguiser en `502 upstream_provider_failed` (le modèle est occupé, pas en panne). `retry::error_for_status` mappe `TOO_MANY_REQUESTS` → nouveau `DomainError::UpstreamRateLimited` (threadé domain→services→api : `ServiceError::UpstreamRateLimited`, `ApiError::UpstreamRateLimited` → `429` + `Retry-After: 5` + `error_code 4291` + message `upstream_rate_limited`, en miroir de `AuthorizationDenied`). Genuine 5xx/502 inchangé (test de forme préservé). Frontend : notice `upstream-busy` (`agent-chat-runtime.ts`, matcher large `isUpstreamRateLimitedMessage` sur les chemins live + sentinel strict `isUpstreamRateLimitedErrorSentinel` sur le persisted, garde JUN-169), composant `UpstreamBusyNoticePart` (`AgentWorkspace.tsx`), message notes (`NoteFailureBanner.tsx`), message mobile (`agent_lite` branch 429 + `is_rate_limit_detail`). Portée : **429 + 503** (`MODEL_INFRA_SATURATED` = le cas dominant d'un modèle chaud ; addendum ADR-0012 du 2026-07-17) ; 500/502/504 restent provider-failed. Matcher frontend + `is_rate_limit_detail` mobile captent aussi le vocabulaire de saturation brut (`saturated`, `no_provider`, `provider_capacity`). **Addendum reload (2026-07-17)** : un tour interrompu **sans erreur persistée** (502 abandonné après retries, crash, app fermée mid-turn) reste invisible au rechargement (Hermes n'écrit aucune ligne pour l'appel mort ; la live `error` frame est en mémoire seule). Détecté par la *forme* du dernier message persisté — `hermesMessagesEndInterrupted` (dernier message `tool`, ou assistant avec `tool_calls` non résolus) dans `agent-chat-runtime.ts` — et surfacé par `withInterruptedTurnNotice` → notice `interrupted` + `InterruptedNoticePart` (`AgentWorkspace.tsx`, réutilise `onRetry`). Gardé `!working && !waiting`, cède à toute notice live plus spécifique. Ne reclasse PAS le 502 (structurel, pas basé sur le texte d'erreur). | Réappliquer le variant aux 4 boundaries + `error_for_status` (429 ET 503), la notice + les 2 matchers frontend, le branch 429/503 d'agent-lite ; garder le split large/strict. Reload : réappliquer `hermesMessagesEndInterrupted` + `withInterruptedTurnNotice` + le kind `interrupted` + `InterruptedNoticePart` + le câblage dans le calcul de `hermesTurns` (garde `!working && !waiting && interrupted`) |
| `june-api/crates/providers/src/{retry,venice}.rs`, `src-tauri/src/agent_lite/mod.rs`, `src/lib/{errors.ts, agent-chat-runtime.ts}`, `src/components/agent/AgentWorkspace.tsx` (**retry backoff agent-chat + notice provider-failed**, 2026-07-20, [ADR-0012 addendum](docs/adr/0012-upstream-rate-limit-distinct-from-provider-failure.md)) | **Le chemin agent-chat était le seul chemin amont sans retry** (cleaner et transcribers ont `UPSTREAM_ATTEMPTS`) alors que la doc Carpe Diem classe 429/502/503 « transient, retry with exponential backoff ». `complete_raw` → boucle `AGENT_CHAT_ATTEMPTS = 3` / backoff exponentiel `AGENT_CHAT_BACKOFF` 1s→2s (constantes dans `retry.rs`), replay sur statuts retryables (408/429/5xx) + erreurs transport retryables ; un échec de lecture du body après un 200 n'est PAS rejoué (génération déjà facturée amont). Les deux shells en profitent (même seam sidecar). En plus : un échec qui survit aux retries se plie en notice `provider-failed` (matchers `isUpstreamProviderFailureMessage`/`…ErrorSentinel`, carte `ProviderFailedNoticePart` « The model provider could not answer this message… », branch mobile `agent_lite_provider_failed` via `is_provider_failure_detail`) au lieu du dump brut `upstream_provider_failed` — sans reclasser le 5xx (le wording ne dit jamais « busy », forme wire inchangée). | Réappliquer la boucle retry dans `complete_raw` (+ `complete_raw_once`, seuil clippy 4 args : le modèle se relit du body) et les constantes ; côté UI réappliquer le kind `provider-failed` aux 4 points de pliage (turnNotice, message.complete failed, persisted Hermes, messageToTurn) + la carte + le branch agent-lite |
| `june-api/crates/providers/src/venice.rs` (**normalisation du rail `/router` → contrat Venice/SSE**, 2026-07-22, [ADR-0015](docs/adr/0015-normalize-carpe-diem-router-responses.md)) | **Le rail `/router` cassait l'inférence de deux façons, même racine** (june-api suppose la sémantique `/v1` de Venice). (1) `/router` renvoie `message.content: null` pour les modèles *reasoning* (`kimi-k3`) → `usage_from_chat_body` bindait tout le `ChatCompletionResponse` typé (content `String` requis) juste pour lire l'usage → un 200 valide se pliait en `502 upstream_provider_failed`. (2) `/router` **ignore `stream: true`** et répond un `application/json` bufferisé → le client (Hermes/agent-lite) qui a demandé du SSE voit « empty stream with no finish_reason ». Fix dans `complete_raw_once` : **un 200 amont ne devient jamais une erreur client** — usage lu sur un `Value` lenient (`token_usage_from_value`, découplé de la forme du message ; illisible → warn + zéro, jamais 502) ; `ChatCompletionMessage.content` → `Option<String>` (corrige aussi la note-gen `complete_once`/`first_choice_text`) ; si `stream:true` **et** amont non-SSE → `synthesize_sse_stream` rebâtit les frames SSE façon `/v1` (chunk content/reasoning préservant `reasoning_content`, chunk finish, frame usage, `[DONE]`), garde content-type-driven donc `/v1` SSE et clients non-stream **passent inchangés** (+ forward-compat si `/router` streame un jour). Bufferisé (pas token-par-token) = pas de régression latence (june-api bufferise déjà). Les deux shells en profitent (`june-embed` iOS partage ce code). Validé en réel contre `/router` : `kimi-k3` non-stream 8/8 200 (était ~50% 502), `stream:true` 8/8 SSE valide. **Complément 2026-07-23 (addendum ADR-0015)** : la synthèse SSE omettait `message.tool_calls` → un turn tool-call sur `/router` arrivait comme delta vide (« No reply: empty content » côté Hermes, systématique avec `openai-gpt-56-terra` dont le reasoning est chiffré). `assistant_delta_from_message` (extrait de `synthesize_sse_stream`) forwarde désormais `tool_calls` en backfillant l'`index` par position. Validé en réel : stream+tools via le sidecar → chunk tool-call + `finish_reason:"tool_calls"` + usage + `[DONE]`. | Réappliquer les 3 changements dans `venice.rs` (struct `content` Optional + `usage_from_chat_body` Value-based + `synthesize_sse_stream`/`EVENT_STREAM_CONTENT_TYPE` + la branche de normalisation dans `complete_raw_once`) ; additif, conflits probables avec les autres blocs venice.rs (catalogue, error mapping, retry) mais zones distinctes |
| `june-api/crates/providers/src/venice.rs` + `crates/config/src/lib.rs` + `crates/providers/src/retry.rs` (**retenue de `stream_options` sur le rail `/router`**, 2026-07-29, [addendum ADR-0015](docs/adr/0015-normalize-carpe-diem-router-responses.md)) | **3e cause d'échec `/router`, en amont des deux précédentes : le tour n'était même pas accepté.** `complete_raw` injecte `stream_options: {include_usage: true}` dès que le client demande `stream: true` (pour la frame usage du métrage) ; `/router` **rejette ce champ en 400** dès que l'arbitrage part sur un marché externe (il retire `stream: true` du corps qu'il relaie mais garde `stream_options` → le validateur du marché refuse un corps qui était valide au départ). 400 = non rejouable (`is_retryable_status`) → `502 upstream_provider_failed`. Mesuré : `llama-3.3-70b` 0/10 sur `/router` vs 10/10 sur `/v1`, `zai-org-glm-5-2` 2/10, `claude-opus-5` 10/10 — tout échec porte `X-Carpe-Route-Market: none`, tout succès `carpe` ; d'où une intermittence qui suit le prix des marchés. Fix : `UpstreamConfig::is_router_rail()` (voisin de `catalog_base_url()`) amorce un flag `stream_options_supported` par `VeniceChat` à `false` sur une base `/router` (le rail ne streame jamais : 0/8 modèles, donc aucune frame usage à demander — l'usage se lit sur le corps bufferisé comme avant). **Retenir = retirer, pas seulement ne pas injecter** : Hermes met `stream_options` de lui-même sur chaque tour streamé (`chat_completion_helpers.py`) et le sidecar relaie le corps client, donc le champ est supprimé du corps sortant quel qu'en soit l'auteur ; **et** filet générique : sur **tout** 400, si le corps sortant porte encore `stream_options`, le champ est retiré et le tour rejoué une fois (ni tentative ni backoff consommés, borné par un flag local) — le flag process n'est éteint **que si ce rejeu réussit**. On ne parse **pas** le texte du rejet (1er design, écarté) : ces 400 échoient la requête, donc un match sur le nom du champ se déclencherait aussi sur un 400 sans rapport (modèle invalide, contexte dépassé) et coûterait sa frame usage à tous les tours suivants — silencieusement, et avec facturation réelle chez upstream June. `UpstreamAttemptError` gagne `stream_options_rejected` + un constructeur `new()` (les 6 littéraux des autres providers passent par lui). Validé en réel avec le corps exact de Hermes (`stream_options` envoyé par le client) : **36/36** via le sidecar réel, 2 rails × 3 modèles, frame usage présente, `/v1` inchangé. Défauts amont rapportés dans `docs/reports/2026-07-29-carpe-diem-router-rail.md`. | Additif : réappliquer `is_router_rail()` (config), le champ + `new()` (retry.rs), le flag + la branche de repli dans `complete_raw` et `rejects_stream_options()` (venice.rs). Si upstream touche à l'injection de `stream_options`, garder la garde du flag |
| `src-tauri/src/hermes_bridge.rs` (**`busy_input_mode: queue` dans le config.yaml rendu**, 2026-07-23) | **Hermes 0.19 a changé la politique busy du gateway** : un `prompt.submit` pendant un turn actif n'est plus rejeté 4009 « session busy » — sous le défaut `busy_input_mode: interrupt` il met le prompt en file ET tue le turn en cours, affiché « Operation interrupted: waiting for model response (Xs elapsed) » (vu sur Windows : message dupliqué → turn détruit, reproduit en live via 2 `prompt.submit` sur le gateway mac : ack `{status:"queued"}` + interruption). Le composer June est conçu autour du contrat 4009 non destructif (steer via `session.steer`, resend en follow-up). **Fix** : `render_hermes_config` épingle `display.busy_input_mode: queue` — un envoi en course attend la fin du turn au lieu de le détruire (test `render_hermes_config_pins_queue_busy_input_mode`). | Garder la ligne `busy_input_mode: queue` dans le bloc `display:` du template ; si upstream adapte son frontend à la sémantique 0.19, aligner |
| `src-tauri/src/hermes_bridge.rs`, `src/lib/agent-composer-slash-commands.ts`, `src/lib/hermes-control-plane/{methods.ts, compatibility/matrix.ts}`, `src/components/agent/AgentWorkspace.tsx` (**Autonomie des tâches longues : budgets de tour + soul note + `/goal`**, 2026-07-23) | **L'agent s'arrêtait sur les gros travaux et l'utilisateur devait re-prompter « continue » en boucle** (vu sur Windows : batch de 234 appels API relancé à la main toutes les few minutes). Trois causes/fix : (1) **Budgets** : le template config.yaml passe `agent.max_turns` 90→200 et le kill d'inactivité `gateway_timeout` 1800→7200 s (warning 900→3600 s) — invariant : `gateway_auto_continue_freshness` (3600→10800 s) doit rester **supérieur** au timeout, sinon un turn interrompu près de la limite est classé « stale » et ne se résume plus au message suivant (test `render_hermes_config_extends_long_run_budgets`). (2) **Soul** : note `JUNE_SOUL_LONG_TASKS_MD` (les deux variantes) — travail long ⇒ process en arrière-plan `background=true` + `notify_on_complete=true`/`watch_patterns`, puis fin de tour : le poller de notifications du tui_gateway **réveille l'agent tout seul** à la fin du process (`_notification_poller_loop` enchaîne `_run_prompt_submit` si la session est idle) ; sans cette note le modèle découpe en tours interactifs qui attendent l'utilisateur (test `june_soul_teaches_background_continuation_for_long_work`). (3) **`/goal` au composer** (boucle Ralph native Hermes : juge post-turn + continuation jusqu'à « done », budget `goals.max_turns` 20) : commande builtin (`parseSlashGoalArgument` : vide/status/pause/resume/clear + alias stop/done ; sinon texte du goal), dispatchée via le seam typé `dispatchGoalCommand` — **impérativement en params `name`/`arg`** : le `command.dispatch` du serveur épinglé ignore la forme `command` pour les pending-input commands (vérifié sur gateway vif ; la forme `command` de `switchActiveSessionModel` répond 4018). Trois chemins d'envoi : verbes de contrôle → dispatch seul + notice ; set pendant un turn **actif** → dispatch seul (le juge post-turn ramasse le goal à la fin du turn courant, rien n'est interrompu) ; set à froid → `submitHermesSession` avec le nouveau seam `beforePrompt` (armer le goal avant le prompt kickoff, échec = abort par le chemin de cleanup commun). Notice composer `goalNotice` scopée session (patron model-switch), première ligne du retour gateway. Tests : `hermes-goal-command`, `agent-composer-slash-commands`. | Réappliquer : le bloc `agent:` du template (garder l'invariant freshness > timeout), la soul note dans les **deux** formats, la commande `goal` (def+parse+notice) dans la lib slash, `dispatchGoalCommand` (name/arg !) dans methods.ts + rationale matrix, `runGoalSlashCommand`/`dispatchGoalToSession`/`beforePrompt`/`goalNotice` dans AgentWorkspace |
| `src/components/agent/AgentWorkspace.tsx` (**sélecteur de modèle résilient + surfaçage tour en échec**, 2026-07-17) | Deux fixes liés à l'instabilité amont. (1) `loadGenerationModel` : `Promise.allSettled` au lieu de `Promise.all` — un échec transitoire de `/v1/models` (sidecar au boot, amont qui flappe) ne doit plus vider `defaultGenerationModelId`/`generationModels` (sinon le chip de modèle disparaît sur le hero → l'utilisateur piégé sur un modèle mort sans pouvoir changer). Préserve le dernier catalogue connu + le réglage persité (local). (2) `refreshHermesSession` : préserve les frames `error` à travers le clear des live events (Hermes ne persiste jamais l'erreur d'un échec mid-tool-loop → le tour se réglait en silence) ; statut « failed »/« Sub Rosa hit a problem » au lieu de « finished » quand une frame error subsiste. | Réappliquer les deux blocs (additifs) dans le composant fork |
| `src/lib/agent-chat-runtime.ts`, `src/components/agent/AgentWorkspace.tsx` (**l'activité d'une session vient du runtime**, 2026-07-25, [ADR-0016](docs/adr/0016-session-activity-comes-from-the-runtime.md)) | **Le frontend déclarait un tour terminé au bout de ~2,5 s de boucle d'outils.** `sessionHasAssistantAfterLatestUser` (« un message assistant existe après le dernier message user ») était utilisé comme test de fin de tour, or une boucle d'agent persiste une ligne assistant à **chaque** étape (Hermes 0.19 scelle le commentaire mid-turn en `message.interim`, et chaque étape tool écrit une ligne assistant + une ligne `tool`). Conséquences signalées comme 4 bugs distincts : bouton Stop qui redevient Envoyer en plein run (donc follow-up soumis en nouveau tour au lieu d'être steeré), « Sub Rosa finished » annoncé en cours de route, notice `interrupted` d'ADR-0012 affichée sur un tour qui continuait, et poll éteint → chat qui paraît mort. **Fix** : seul un événement gateway terminal ou `session.active_list` (déjà interrogé par le poll 2,5 s, 2 misses) termine un run — `reconcileWorkingSessionsAgainstRuntime` + le nouveau `settleSessionRun` (qui porte aussi le statut « failed » quand une frame `error` subsiste, cf. la ligne « surfaçage tour en échec » ci-dessus). Le transcript est rétrogradé en **fallback unidirectionnel**, utilisé seulement quand la gateway du mode ne répond pas, via `hermesMessagesShowCompletedTurn` (réponse assistant **et** aucun tool call pendant) ; il garde ses autres rôles (promotion du rapport d'incident, purge du buffer live) sur le test faible renommé `hermesMessagesHaveAssistantReply`. Filet : un `hermesBridgeStatus()` qui répond `running: false` règle les sessions restaurées par la continuité (le poll ne tourne pas sans bridge). Tests : 4 dans `agent-workspace.test.tsx` (loop vivante / loop morte + notice / fallback gateway injoignable × 2 formes), bloc « turn settlement » dans `agent-chat-runtime.test.ts`. | Réappliquer : les 2 helpers exportés dans `agent-chat-runtime.ts`, `settleSessionRun` + la branche fallback de `reconcileWorkingSessionsAgainstRuntime`, le retrait du settle dans l'effet de sélection **et** dans `refreshHermesSession` (garder la préservation des frames `error`), `hermesSessionMessagesRef`, le filet `!status.running`. Si upstream a bougé ces blocs, garder l'invariant : le transcript ne termine jamais un run tant que le runtime est joignable |
| `src/lib/hermes-control-plane/event-classifier.ts`, `src/components/agent/AgentWorkspace.tsx` (**l'abonnement live survit au tour**, 2026-07-25, [ADR-0016 addendum](docs/adr/0016-session-activity-comes-from-the-runtime.md)) | **Miroir du bloc précédent : l'app arrêtait aussi d'écouter trop tôt.** `attachHermesSessionEventListener` se détachait (`unlisten()`) sur la première frame terminale, et `background.complete`/`background.completed` étaient classés terminaux. Or depuis la note soul v1.27.0, le travail long **doit** passer par un process background : c'est le poller de notifications du gateway qui enchaîne un nouveau tour à la fin du process — donc la frame qui *annonçait* le réveil était celle qui tuait l'abonnement et réglait la session. Le tour enchaîné (idem `/goal`, idem routine cron) ne streamait alors chez personne, et comme le run était réglé le poll 2,5 s ne tournait plus non plus → conversation figée jusqu'à ce que l'utilisateur tape quelque chose (« le chat s'arrête, je dois le relancer »). **Fix** : (1) `background.*` retiré de `isTerminalHermesEvent` et classé `lifecycle` (pas `unsupported`, sinon notice « événement inconnu » sur une frame que June traite) ; (2) l'abonnement est scopé **session** et non tour — remplacé par le submit suivant (chaque attach retire le précédent : jamais de doublon), démonté à l'unmount / à la suppression de session ; (3) `recoverFromGatewayClose` couvre toutes les sessions dont on a un runtime id (pas seulement working/waiting) et **ré-attache** l'abonnement avec le runtime id que le resume vient de créer (le handler survivant filtre sur l'id capturé à l'attach). Tests : 3 dans `agent-workspace.test.tsx` (background non terminal / tour enchaîné streamé / reconnexion d'une session idle — les 2 premiers vérifiés rouges sans le fix) + 1 dans `hermes-control-plane-classifier.test.ts`. Le mock gateway des tests capture désormais `onClose`. | Réappliquer : la liste `isTerminalHermesEvent` sans `background.*`, le retrait de `unlisten()` dans la branche terminale (garder tout le reste du corps), `type.startsWith("background.")` dans `isLifecycleType`, et les 3 changements de `recoverFromGatewayClose`. Invariant à préserver : rien ne doit détacher l'abonnement à la fin d'un tour |
| `src/components/agent/AgentWorkspace.tsx`, `src/lib/{agent-events.ts, agent-notifications.ts}` (**résolution du runtime id avec éviction**, 2026-07-25, [ADR-0016 addendum](docs/adr/0016-session-activity-comes-from-the-runtime.md)) | **« session not found » définitif à la reprise d'une session.** Les RPC d'une session sont clés par le runtime session id (pas le stored id) ; 4 sites inlinaient `cached ?? session.resume` et **aucun n'évinçait le memo** quand il devenait mort (Hermes redémarré, process reapé, machine en veille). Le gateway répondait `Session not found`, l'id pourri restait en cache → tous les envois suivants de la conversation échouaient à l'identique jusqu'au redémarrage de l'app, avec le texte wire brut en bandeau **et** une notification desktop « Sub Rosa hit a problem » pour un message jamais parti. **Fix** : `resolveRuntimeSession(storedSessionId, gateway, {forceRefresh, acquireGateway})` unique (memo → resume → éviction), retourne aussi **la gateway qui a répondu** ; utilisé par `submitHermesSession`, `fetchSessionUsage`, `dispatchGoalToSession`, `recoverFromGatewayClose`. Le chemin d'envoi rejoue le tour **une fois** sur un runtime frais quand `prompt.submit` répond session-gone (via `runTurnOn` : ré-attache le listener, rejoue `beforePrompt` et ré-attache les images — cet état vivait dans le process mort). Échec terminal → `SESSION_RUNTIME_GONE_MESSAGE` (jamais le texte wire) + `silent: true` sur le statut (nouveau champ de `AgentSessionStatusDetail`, honoré par `notifyAgentSessionStatus`) : la notification desktop ne répète pas ce que le composer vient d'afficher. Repli inter-mode **unidirectionnel** : une session enregistrée Unrestricted est retentée sur le runtime sandboxé (l'inverse escaladerait silencieusement le write access — l'absence dans la map = sandboxé, cf. `agent-session-modes.ts`). Tests : 3 dans `agent-workspace.test.tsx` (replay réussi — vérifié rouge sans le fix —, échec au submit, échec au resume). | Réappliquer `resolveRuntimeSession` + `remember/forgetRuntimeSessionId` + `runTurnOn` et le repli session-gone du submit ; garder l'unidirectionnalité du repli de mode et le champ `silent` |
| `src/lib/hermes-background-processes.ts` (**nouveau**), `src/lib/hermes-control-plane/{events.ts, event-classifier.ts}`, `src/components/agent/AgentWorkspace.tsx`, `src/styles/app.css` (**visibilité des tâches de fond**, 2026-07-25, [ADR-0016 addendum](docs/adr/0016-session-activity-comes-from-the-runtime.md)) | **Depuis la note soul v1.27.0, un tour réglé ≠ une session inactive** : l'agent parque le travail long dans un process background et termine son tour, la gateway le réveille à la fin. L'app rendait les deux états à l'identique — tour terminé, composer inactif, rien nulle part pour dire qu'un job de deux heures tournait — donc l'utilisateur re-promptait pour savoir si quelque chose se passait (exactement ce que la note soul cherche à supprimer). **Fix** : nouveau store singleton `hermesBackgroundProcessStore` (patron des stores hermes-* existants : `record`/`forSession`/`clearFinished`/`clearSession`/`subscribe`/`getVersion`, cap 20 par session), alimenté depuis l'abonnement live ; `BackgroundWorkNotice` en dernier maillon de la chaîne de notices du composer — la seule qui reste affichée composer au repos, avec la commande et le temps écoulé (tick 15 s) ; à la fin du dernier process, « Background task finished. Sub Rosa is picking it back up. » jusqu'au `message.start` du tour enchaîné. La notice `interrupted` d'ADR-0012 lui cède (un tour qui a parqué un job attend, il n'est pas coupé — proposer un retry dupliquerait le travail). Deux points structurants : (1) `JuneHermesEvent.lifecycle` gagne `rawType` — `status` masque le type wire dès que la frame porte un champ status, donc un consommateur ne pouvait plus savoir de quel lifecycle il s'agissait ; (2) le store est clé par le **stored** session id passé par l'appelant, jamais par le `sessionId` de la frame (= runtime id), sinon tout est classé sous une clé que personne ne lit. Détection volontairement tolérante (plusieurs noms de champs pour handle/commande/flag background) : une forme inconnue = pas de bandeau, jamais un bandeau faux. Vérifié visuellement (4 états + viewport étroit) : le CSS a dû être corrigé, `max-width: min(…, 100%)` sur `.agent-composer-notice` + `flex: 0 1 auto` sur la commande, sinon une commande longue débordait au lieu de s'ellipser. Côté sidebar : `AgentSessionsChangedDetail.backgroundSessionIds` (optionnel, additif) → point creux sur la ligne de session (`data-status="background"`, entre working et unread), pour qu'une tâche parquée sur une AUTRE conversation reste visible. Tests : `hermes-background-processes.test.ts` (10) + 3 dans `agent-workspace.test.tsx` (bandeau, passage de relais, diffusion sidebar). | Réappliquer le store + la notice + le champ `rawType` du classifieur + `backgroundSessionIds` ; garder l'invariant « clé = stored session id » et la tolérance de détection |
| `src/lib/hermes-process-notice.ts` (**nouveau**), `src/lib/{agent-chat-runtime.ts, hermes-adapter.ts, agent-chat-gallery.ts}`, `src/components/agent/AgentWorkspace.tsx`, `src/styles/app.css` (**les notifications de process ne sont pas des messages de l'utilisateur**, 2026-08-01) | **L'app avait l'air d'envoyer des messages que l'utilisateur n'avait pas écrits.** Suite directe de la note soul v1.27.0 : quand un process de fond matche un `watch_patterns` ou se termine, la gateway réveille l'agent en **soumettant la notification comme un prompt** (`drain_notifications` → `_run_prompt_submit` dans `tui_gateway/server.py`) — donc Hermes persiste un message `role: "user"` disant `[IMPORTANT: Background process proc_… matched watch pattern "…"]`, indiscernable d'un message tapé. Le chat l'affichait dans la bulle utilisateur (seul le préambule cron avait un traitement), et la sidebar pouvait nommer/prévisualiser la session avec (Hermes construit le preview depuis le **dernier** message). **Fix** : parseur dédié `hermes-process-notice.ts` (les 4 formes de `format_process_notification` : watch match, fin de process, watch disabled, délégation async — plus un repli `update` pour un wording inconnu, qui reste une ligne process et jamais une bulle) → part `process` (`AgentChatProcessPart`) rendue par `ProcessNoticeItem`, disclosure repliée calquée sur `.agent-context-summary` (label + heure, notification verbatim en `<pre>` monospace au dépliage), `data-kind="failed"` légèrement appuyé sans devenir une carte d'erreur. Deux invariants : (1) le turn **garde `role: "user"`** — c'est ce que Hermes a stocké, et les heuristiques « l'agent doit une réponse » (spinner `hermesTurns.at(-1)?.role === "user"`, `shouldResumeSessionActivity`) en dépendent ; seul le rendu change ; (2) aucune action de tour sur ces lignes (ni copy, ni edit, ni branch) et `retryLastHermesUserTurn` saute les notices via `isProcessNoticeTurn`, sinon le retry resoumettait de la scaffolding machine ou devenait inerte. Le parseur tolère la forme aplatie/tronquée à 160 caractères des previews de session (`withProcessNoticeDisplay` dans `hermes-adapter.ts` : la ligne de session dit ce qui s'est passé, un titre déjà posé est conservé). Vérifié visuellement (clair/sombre, replié/déplié, viewport étroit) : le label peut porter un pattern choisi par l'agent, donc ellipse + `flex: 0 0 auto` sur l'heure. Tests : `hermes-process-notice.test.ts` (9), `agent-process-notice-turn.test.tsx` (3, rendu via `AgentChatTurnRow` désormais exporté), + 2 dans `agent-chat-runtime.test.ts` et 2 dans `hermes-adapter.test.ts`. Section « Background process notice » ajoutée à la galerie dev-tools. | Réappliquer le module + la part `process` (union, `partText`, branche du builder) + `ProcessNoticeItem` + le nettoyage sidebar ; garder les 2 invariants (role `user` préservé, aucune action de tour) et le repli `update`. Si un upgrade Hermes reformule `format_process_notification`, mettre à jour les fixtures du test — le repli évite la régression visuelle en attendant |
| `src-tauri/src/{hermes_bridge.rs, providers/mod.rs}` (**les images jointes atteignent enfin le modèle**, 2026-08-01) | **« L'analyse visuelle échoue » sur chaque photo jointe, alors que le modèle lit très bien les images.** Hermes décide par tour si une image jointe part en contenu image (`native`) ou est pré-décrite par `vision_analyze` (`text`) ; en mode `auto` il tranche via **models.dev**, qui ne connaît ni notre provider (`custom`, loopback) ni les ids de modèles de l'opérateur → décision *fail closed* vers `text` → `vision_analyze` encode la photo **en base64 dans le prompt** → `400 prompt_too_long` (vu dans `hermes/logs/errors.log`, images de ~2,4 Mo). Vérifié à la main : la même image en `image_url` coûte ~1,4k tokens et le modèle répond correctement, via le rail direct **et** via le sidecar. **Fix** : `providers::generation_model_supports_vision()` (patron exact de `generation_model_context_tokens` : lookup `june_api::list_models`, cache une entrée, `None` si catalogue injoignable) alimente `render_hermes_config`, qui écrit `model.supports_vision` **et** `agent.image_input_mode: native` — les deux sont nécessaires et ne se remplacent pas : `image_input_mode` route l'image du tour, `supports_vision` est la condition supplémentaire du fast-path natif de l'outil `vision_analyze` (`_should_use_native_vision_fast_path`, un provider `custom` n'étant dans aucune allowlist). Trois états assumés : `Some(true)` → natif (Hermes rétrécit et rejoue tout seul si l'image est trop lourde, cf. `_try_shrink_image_parts_in_messages`) ; `Some(false)` → `supports_vision: false` et **pas** de mode natif (le repli décrit-puis-envoie est correct pour un modèle texte) ; `None` → aucune clé écrite (ADR-0007 : la capacité vient du catalogue, jamais d'une supposition). `capabilities_include_vision` est le miroir Rust de `modelSupportsImageInput` (`src/lib/model-privacy.ts`) — le frontend décide *si* l'image part, ceci décide *comment* Hermes la porte ; garder les deux en phase. `sync_hermes_config` devient `async` (l'appelant `start_hermes_bridge_inner` l'était déjà). Tests : 3 sur le rendu (vision / texte / inconnu) + 1 sur la détection de capacité. | Réappliquer le helper providers + les 2 clés de `render_hermes_config` + l'`await` du call site ; garder les 3 états (surtout `None` = ne rien écrire) et le miroir avec `model-privacy.ts` |
| `src-tauri/src/hermes_image_fit.rs` (**nouveau**), `src-tauri/src/hermes_bridge.rs` (commande `hermes_bridge_image_for_model`), `src-tauri/src/lib.rs`, `src/lib/tauri.ts`, `src/lib/hermes-image-attach.ts` (`imageAttachByteBudget`), `src/components/agent/AgentWorkspace.tsx` (**une image jointe est redimensionnée pour tenir dans la requête**, 2026-08-02) | **« La lecture des images ne fonctionne toujours pas », alors que le routage natif de la ligne au-dessus marchait.** Le log le disait : `conversation turn: … msg='[2 images] …'` — les images partaient bien en contenu image — puis `400 prompt_too_long` en boucle, et une compression de contexte qui réduisait 36→15→10→8 messages **sans jamais faire baisser la taille**. Cause : une capture de 2,4 Mo pèse **3,2 Mo une fois en base64**, ce qui franchit d'un coup les **trois** garde-fous de taille, tous dimensionnés pour du *texte* : le plafond de corps du proxy loopback (`JUNE_PROVIDER_PROXY_MAX_BODY_BYTES`, 3 Mio — c'est **notre** proxy qui émettait le `prompt_too_long`, pas le provider) et les caps par chaîne / cumulés de june-api (`MAX_AGENT_STRING_CHARS` / `MAX_AGENT_TOTAL_STRING_CHARS`, 1,5 M caractères). L'image occupait tout le budget, donc compresser l'historique ne pouvait rien récupérer — d'où la boucle. **Mesuré avant de coder** : la même image en 2,4 Mo et en 188 Ko coûtent **exactement 2 919 tokens de prompt** et sont toutes deux décrites correctement (HTTP 200 sur le rail `/router`) — les octets en trop n'achètent rien au modèle, qui redimensionne sur sa propre grille avant de regarder. **Fix** : `fit_image_for_model` (module pur, testé) réencode l'image **au moment de l'attachement** — passthrough octet pour octet si elle tient déjà dans le budget (le texte d'une capture survit mieux en PNG lossless qu'en JPEG), sinon échelle de qualité JPEG 85→45 puis d'arête 1568→768, alpha aplati sur **blanc** (le jeter noircirait le fond d'une capture transparente et avalerait son texte sombre). Nouvelle commande `hermes_bridge_image_for_model` (distincte de `hermes_bridge_file_preview`, qui reste fidèle aux octets pour la vignette) ; le budget est **partagé sur le tour** (`imageAttachByteBudget` : 750 Ko divisés par le nombre d'images, plancher 80 Ko) puisque les caps se comptent par requête. Vérifié sur les deux fichiers réels de l'incident : 2 440 060 → 188 481 o et 2 393 569 → 259 443 o, soit 597 k caractères de base64 au lieu de 6,4 M. Effet de bord retrouvé : avec une image à 250 Ko la compression de contexte de Hermes redevient utile, alors qu'elle tournait à vide. **Reste non couvert** : l'outil `vision_analyze` de Hermes lit le fichier lui-même et l'encode sans passer par ce chemin — une image lourde que l'agent découvre seul (sans `@` ni glisser-déposer) peut encore franchir le plafond du proxy. | Réappliquer le module + la commande + le binding + `imageAttachByteBudget` et son câblage dans `attachPendingImages` ; garder le passthrough (ne pas réencoder par défaut : c'est ce qui préserve le texte des captures) et l'aplatissement sur blanc. MSRV 1.80 : pas d'`is_none_or` |
| `src/lib/agent-mentions.ts` (`quotedPath`), `src/test/agent-mentions.test.ts` (**un chemin nu dans le prompt fait ré-attacher l'original**, 2026-08-02) | **Suite directe de la ligne au-dessus : les images étaient bien réduites (259 Ko et 188 Ko, vérifié sur disque dans `hermes/images/`) et le tour échouait quand même en `prompt_too_long`.** Le runtime épinglé scanne le TEXTE du prompt (`extract_image_refs`, `agent/image_routing.py`) à la recherche de chemins absolus se terminant par une extension d'image et existant sur disque, puis les attache **en taille native** (`build_native_content_parts` : « Images are attached at their native size »). Notre bloc de mentions écrivait `Saved at /Users/.../Film_1/1img1.png` en clair → Hermes ré-attachait **les originaux** par-dessus nos copies ajustées : **+4 833 629 octets bruts, soit 6 444 838 en base64**, d'où un corps ~7 Mo contre 3 Mio de plafond. **Piège de diagnostic** : le premier test de la théorie a donné 0 correspondance parce qu'il utilisait le chemin de `uploads/` (sous `Application Support`, dont les **espaces** cassent la regex `_LOCAL_IMAGE_PATH_RE`) ; le vrai dossier de travail (`~/Documents/SubRosa/Film_1`) n'en a pas. Ne pas conclure sur un chemin d'exemple contenant un espace. **Second piège** : `length(content)` en SQL renvoyait 0 pour le message porteur — SQLite s'arrête au premier NUL et le contenu commence par `\x00json:`. Mesurer en Python (`len`), sinon l'historique paraît vide. **Fix** : `quotedPath` entoure **tous** les chemins de mentions de backticks — le runtime saute explicitement les correspondances en inline-code, donc c'est l'échappement documenté, et l'agent lit toujours le chemin. Vérifié en donnant le prompt réel à `extract_image_refs` du runtime installé : 0 ré-attachement. Test de non-régression `runtimeWouldReattach` (miroir fidèle de la regex + des spans de code) avec un cas « guard the guard » qui prouve qu'il sait échouer. | Réappliquer `quotedPath` et son usage sur les 3 genres de mention ; **ne jamais écrire un chemin nu dans le texte d'un prompt** si le fichier peut être une image. Si un jour on ajoute un bloc de prompt nommant des fichiers, lui appliquer la même règle |
| `src/lib/agent-mentions.ts`, `src/components/agent/composer/{mentionChip.ts, MentionChipView.tsx, MentionSuggestionList.tsx, suggestionPopover.ts}` (**nouveaux**), `src/components/agent/composer/{ComposerEditor.tsx, categoryChip.ts}`, `src/components/agent/AgentWorkspace.tsx`, `src/lib/{tauri.ts, agent-chat-runtime.ts}`, `src/styles/app.css`, `src-tauri/src/{hermes_working_dir.rs, lib.rs, hermes/june_context_mcp.py}` (**mentions `@` de documents**, 2026-08-01) | **Citer un document du dossier de travail sans le ré-importer.** `/file` (et le drag-drop) **importe** : copie dans le workspace Hermes, chip d'attachement, bloc de chemins en fin de prompt. Une mention **désigne** : le fichier est déjà dans le dossier de la session, l'agent ouvre le vrai fichier en place (pas de doublon, les modifications atterrissent là où l'utilisateur les cherchera). Deux invariants : (1) **une mention ne porte jamais le contenu** — un chemin absolu (ou un id de note) et l'agent lit avec ses outils ; inliner le texte ferait exploser le contexte sur un gros fichier et figerait un instantané périmé ; (2) **le périmètre s'arrête où s'arrête le bac à sable** — la racine est le working folder de la session (ou le workspace par défaut), c'est-à-dire la seule zone que Seatbelt re-autorise en écriture ; proposer un fichier hors de là promettrait une modification que le noyau refuserait. Backend : `list_agent_folder_entries` (`hermes_working_dir.rs`) — la racine passe par le même `validate_working_dir` que partout (secret stores / dossiers système / app data refusés), parcours en largeur borné (profondeur 6, 20 000 entrées visitées), exclusions build/deps/VCS, **dotfiles et symlinks jamais listés** (donc aucune entrée ne peut sortir de la racine validée), score nom > chemin puis chemin le plus court, requête vide = les plus récemment modifiés. Frontend : le `render` du popover de suggestions est **extrait** de `categoryChip.ts` vers `suggestionPopover.ts` et partagé par les deux palettes (`/` inchangée ; le host garde la classe `agent-category-menu-host`, sur laquelle l'éditeur teste « une palette est ouverte » pour Enter) ; extension Mention `@` (node `agentMention`, chips fichiers/dossiers/notes), `serializePlainText` rend `@nom` (la phrase reste lisible), `mentions()` sur le handle du composer, bloc de références ajouté au submit par `promptWithMentions` et masqué à l'affichage par `stripMentionPromptBlock` (patron du bloc d'attachements). Notes : nouvel outil MCP **`get_note`** (`june_context_mcp.py`) — une note mentionnée voyage par id, et l'agent la lit en entier au lieu d'un extrait de recherche. Vérifié visuellement (clair/sombre) : l'ellipse des chips a dû passer sur un span interne (`text-overflow` ne s'applique pas à la boîte flex du chip). Tests : `agent-mentions.test.ts` (9), `composer-mention-menu.test.tsx` (3, dont « me@example » n'ouvre pas la palette), 5 tests Rust sur le listing. | Réappliquer : le module + les 4 fichiers composer + la commande Rust (dans la liste `generate_handler!` **desktop** seulement) + `get_note` ; garder les 2 invariants (jamais le contenu, jamais hors racine) et la classe de host partagée. Si upstream retouche `categoryChip.ts`, réappliquer l'extraction du popover plutôt que de dupliquer le positionnement |
| `.github/workflows/{build-june-api.yml, june-api-watchdog.yml}` (**infra Phala d'upstream mise en manuel**, 2026-07-25 ; **les trois fichiers, `promote-june-api.yml` compris, sont supprimés le 2026-09-02** : un serveur que le fork n'a pas n'a pas besoin de workflows inertes, et `docs/index.md` le dit) | **Ces deux workflows pilotent le june-api *hébergé* d'upstream, que le fork n'a pas** (non-objectif assumé : le desktop lance `june-api` en sidecar local sur loopback, iOS l'embarque via `june-embed`). Leurs déclencheurs automatiques sont retirés, `workflow_dispatch` conservé — le fichier reste intact pour les re-merges et lançable à la main si le fork héberge un jour june-api. (1) `build-june-api` : construisait une image Docker de june-api, la poussait sur GHCR et la déployait sur une CVM Phala, à chaque push touchant `june-api/**`. **Rouge depuis la création du fork** : l'image s'appelle `ghcr.io/<owner>/june-api` et l'owner est `Irdanwen` — GHCR refuse les majuscules. Personne ne tire cette image, aucune CVM n'existe. Si un jour on le réactive : passer l'owner en minuscules d'abord. (2) `june-api-watchdog` : `cron: */30` sondant `https://june-api.opensoftware.co/healthz`, c'est-à-dire **la prod de June, pas la nôtre** — 48 réveils par jour pour surveiller l'infra de quelqu'un d'autre, et surtout il **ouvre une issue sur CE dépôt** quand la sonde échoue (des rapports de panne qu'on ne peut pas traiter). Pour le réactiver : pointer `PROD_BASE_URL` sur notre instance et remettre le cron. `promote-june-api` était déjà `workflow_dispatch` seul, donc inerte : laissé tel quel. | Ne pas réintroduire les blocs `on: push` / `on: schedule` lors d'une synchro upstream : upstream les a légitimement, nous non |
| `src/app/App.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/main.tsx` (Studio, 2026-07-04) | Vue « Studio » : cas `"studio"` dans `SidebarView`/`tabMeta`/le switch de rendu, bouton nav + quick command sidebar, import `styles/studio.css` | Réappliquer les 3 hooks (additifs) |
| `src-tauri/tauri.conf.json` (Studio) | Scope assetProtocol `$APPDATA/studio-media/*` (affichage des fichiers de la galerie via `convertFileSrc`) | 1 entrée de scope |
| `package.json` (Studio) | Dépendance `@xyflow/react` (canvas de workflows) | Additif |
| `src-tauri/src/{lib,domain/types}.rs`, `src-tauri/src/db/{migrations,repositories}.rs`, `src-tauri/src/agent_lite/mod.rs`, `src-tauri/src/hermes_bridge.rs`, `src-tauri/src/hermes/june_context_mcp.py`, `src/components/agent/AgentWorkspace.tsx`, `src/components/mobile/screens/{AgentScreen,SettingsScreen}.tsx`, `src/components/settings/AppSettings.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/lib/tauri.ts`, `src/styles/mobile.css` (**Mémoire inter-conversations**, 2026-07-10) | Système de mémoire façon Venice Memoria (voir `docs/adr/0009-local-cross-conversation-memory.md`) : table `memories` (migration 010) + méthodes repository, module `src-tauri/src/memory/` (réglages `memory.json`, commandes CRUD + `memory_extract`, extraction tous les 3 tours assistant, injection `prompt_block`, recall hybride LIKE+cosinus/RRF avec embeddings BGE-M3 appelés en direct sur Carpe Diem). Injection : bloc « User memory » dans `sync_june_soul` (desktop, + section `JUNE_SOUL_CONTEXT_MD` étendue) et dans le system prompt d'agent-lite (mobile, chaque tour). Outils de rappel : `search_user_memories` dans `june_context_mcp.py` (gaté par argv `--memory=off`) et `search_memories` dans agent-lite. Déclencheur desktop : `noteAssistantTurnCompleted` (`src/lib/memory.ts`) branché sur l'événement terminal d'`AgentWorkspace`. UI : onglet Settings « Memory » (desktop) + section Memory mobile. | Réappliquer : migration+repo, `pub mod memory` + 8 commandes dans **les deux** `generate_handler!`, hook agent_lite, param `user_memory` de `sync_june_soul`, arg mémoire du MCP context, trigger AgentWorkspace, entrées UI |
| ~~`src-tauri/src/videomaker/**`, `src/lib/films/**`, `FilmStudio`/`FilmDirectorPanel`/`FilmProduceControl`/`VideomakerSettings`, deps `hex`/`k256`/`sha3`, 33 commandes desktop~~ (**retiré le 2026-08-24**) | La production de films via un studio distant a été supprimée (ADR-0029). Ce qui a été rendu au passage : trois dépendances cryptographiques, 33 entrées de la liste desktop de `generate_handler!`, et la CSP resserrée — `img-src`/`media-src` ne portent plus `https:`, qui n'existait que pour les URLs signées du studio. Rien à re-mergier. | Si un sync amont ramène quoi que ce soit de tout cela, `repository-hygiene.yml` échoue |
| ~~`src-tauri/src/hermes/june_films_mcp.py`~~ (**retiré le 2026-08-24**) | Le MCP `june_films` a été supprimé avec le studio distant (ADR-0029). Remplacé par `june_studio_mcp.py` (ligne dédiée plus bas). Rien à re-mergier : si un sync amont le ramène, `repository-hygiene.yml` échoue. |
| ~50 fichiers `src/**` (composants + `lib/`) | Rebrand des **chaînes visibles** « June »→« Sub Rosa » (identifiants techniques laissés : `june://`, `JUNE_*`, clés `os-june:*`, noms de symboles) | Conflits attendus ; garder « Sub Rosa » dans le texte visible |
| ~14 fichiers `src/test/**` | Assertions alignées sur la copie rebrandée ; 3 tests App ajoutent le mock `carpeDiemSidecarStatus` | Aligner sur le texte fork |
| `src-tauri/src/hermes_bridge.rs`, `src-tauri/src/lib.rs`, `src/components/agent/AgentWorkspace.tsx`, `src/lib/tauri.ts`, `src/styles/app.css`, `src/test/agent-workspace.test.tsx` (**Dossier de travail par session**, 2026-07-19, [ADR-0014](docs/adr/0014-per-session-working-folder.md)) | L'utilisateur choisit **par nouvelle session** le dossier où l'agent travaille (chip « App workspace » à côté du picker Sandboxed dans le hero). Backend : `StartHermesBridgeRequest.cwd` (mort) remplacé par `working_dir: Option<WorkingDirRequest>` tri-état (aucune préférence / workspace par défaut / dossier requis) ; **restart-on-mismatch** du processus du mode quand le dossier vivant diffère ; `prepare_sandbox`/`build_sandbox_profile` prennent le dossier **validé** en grant d'écriture dédié + **deny file-write\* final sur les stores de credentials** (SBPL last-match-wins, testé au niveau kernel) ; `environment_hint_for_spawn` (→ `Option<String>`) annonce le dossier ; `HermesBridgeConnection.working_dir` (canonique, `None` = défaut) ; racines snapshot/download du panneau Fichiers étendues aux dossiers actifs ; TUI debug reçoit `working_dir` (profil + `cd`). Frontend : routage à l'envoi comme le mode (localStorage `june.agent.sessionWorkingDirs`), fallback + notice si le dossier a disparu (le backend refuse **avant** de stopper le processus → réutilisation du runtime défaut sans 2e start), chip session-bar « reveal », menu récents (revalidés à chaque usage), confirm des dossiers larges (Documents/Desktop/Downloads). | Réappliquer : le tri-état + restart dans `start_hermes_bridge_inner`, les params `working_dir` (sandbox/hint/TUI/connection), le deny d'écriture secrets, l'enregistrement des 2 commandes `hermes_working_dir::*` (liste desktop uniquement), le câblage AgentWorkspace (submit + ensureHermesGateway + chip/menu/dialog/notice/bar) ; les fichiers ajoutés (ci-dessous) sont fork-only |

| `june-api/crates/{domain,config}/src/lib.rs`, `june-api/crates/providers/src/venice.rs`, `june-api/crates/services/{pricing,agent_chat,charge_flow,note_generate,dictate}.rs`, `june-api/crates/api/src/handlers/agent.rs`, `src-tauri/src/{june_api,lib,hermes_bridge}.rs`, `src/components/agent/{AgentWorkspace,SessionUsagePanel}.tsx`, `src/lib/tauri.ts`, `src/styles/app.css` (**Cache de prompt Carpe Diem**, 2026-08-21, [ADR-0023](docs/adr/0023-cache-telemetry-crosses-the-sidecar-as-headers.md)) | L'operator sert une part du prompt depuis son cache et la facture moins cher ; le fork le lisait nulle part. `TokenUsage` gagne 4 champs (`cached_tokens`, `cache_creation_input_tokens`, `cache_saved_usdc_micro`, `cost_usdc_micro`) lus **lâchement** dans les deux chemins de parsing (`token_usage_from_value` + `ChatCompletionUsage`) ; le handler `/v1/chat/completions` republie le métrage en 6 en-têtes additifs `x-june-*` (le desktop streame le corps vers Hermes et ne doit pas le bufferiser) ; `ModelPriceConfig.cache_input_credits_per_million_tokens` + `CarpeDiemPricingRow.cacheInputPrice` (**`Option` de bout en bout** — le tarif est OMIS pour la plupart des modèles, un `None` ne doit jamais disqualifier un modèle du catalogue) et `price_token_usage` facture 3 composantes. Garde-fou `price_settled_work` : une erreur de tarification **après** un appel upstream réussi ne jette plus la réponse (3 sites). Fenêtre de conversation à **deux marques** (`AGENT_PROXY_MAX_MESSAGES` 64 / `AGENT_PROXY_KEEP_MESSAGES` 48) : tronquer par blocs garde le préfixe stable ~15 tours sur 16. Test de **stabilité binaire du SOUL** (`the_soul_is_byte_stable_across_runs_with_the_same_inputs`) — c'est l'invariant dont dépend tout le bénéfice. **Addendum même jour** : la table de prix ne **facture rien** dans cette distribution (`JUNE__LOCAL_DEV__ENABLED` câble `LocalDevOsAccountsClient`, dont `charge` rend toujours `Credits(0)`, et aucun composant de `src/` ne lit `credits_charged`). Ses deux rôles vivants sont ailleurs et sont maintenant nommés dans le code : **liste blanche de modèles** (`require_priced_model` tourne AVANT l'appel upstream → 422 `model_not_priced` = modèle *inutilisable*, pas seulement non facturé) et **ligne de prix du sélecteur** — d'où `cache_input_credits_per_million_tokens` propagé jusqu'à `ModelPickerDialog` (`$1.40 input / $5.50 output per 1M tokens ($0.26 cached input)`, sous-centime lisible). Corollaire : `price_settled_work` est de la défense en profondeur, pas un correctif — le portillon rend le mode d'échec inatteignable. | Réappliquer : les 4 champs + les 2 lectures, les 6 en-têtes, le champ `Option` de prix (ne **jamais** l'ajouter au test « modèle non tarifé » de `carpe_diem_model_config`) propagé sur les 4 couches de DTO jusqu'au sélecteur, les 3 `price_settled_work`, les 2 marques de fenêtre, la prop `fetchCacheStats` du panneau + son injection dans AgentWorkspace ; les fichiers ajoutés (ci-dessous) sont fork-only |

> **Note deep-link scheme** : la registration OS (tauri.conf) est `subrosa`. Le callback OAuth OS Accounts
> (`osjune://…` dans `os_accounts.rs`) est **inutilisé** en mode local (OS Accounts = hors périmètre) et laissé
> tel quel pour minimiser le diff + éviter la casse des tests. À aligner si OS Accounts est un jour réactivé.

| `src/components/agent/AgentWorkspace.tsx`, `src/lib/simple-markdown.tsx`, `src/components/mobile/screens/AgentScreen.tsx`, `src-tauri/src/{hermes_bridge.rs, agent_lite/mod.rs, lib.rs}`, `src/lib/agent-chat-gallery.ts`, `src/styles/app.css` (**blocs de chat**, 2026-08-21, [ADR-0024](docs/adr/0024-chat-blocks-are-in-band-fenced-json.md)) | **Cartes riches dans les réponses** : les deux renderers markdown interceptent les fences `subrosa:<kind>` (payload JSON versionné, parse dans `src/lib/chat-blocks.ts` ajouté) et montent une carte (`ChatBlockView`), squelette sur fence non fermé pendant le stream (prop `streaming` threadée : `MarkdownContent`/`renderMarkdownBlocks` desktop, `SimpleMarkdown`/`TypewriterMarkdown` mobile), dégradation en bloc de code sinon. Les ancres markdown des deux renderers passent par la nouvelle commande `open_external_url` (les webviews jettent `target=_blank`). Prompts : paragraphe « Link cards » dans `SYSTEM_PROMPT` agent-lite + `JUNE_SOUL_BLOCKS_MD` dans les DEUX assemblages soul. Galerie dev : section « Chat block: link card ». | Réappliquer : la branche fence des deux renderers (desktop : capturer l'info string, aujourd'hui ignorée upstream) + le threading `streaming`, l'onClick des ancres, la note soul dans les deux `format!`, le paragraphe agent-lite, `open_url::open_external_url` dans les **2 `generate_handler!`** |

| `june-api/crates/{domain/src/lib.rs, api/src/{handlers/web.rs, state.rs, lib.rs}, services/src/lib.rs, providers/src/lib.rs, embed/src/lib.rs, api/tests/http_boundary.rs}`, `src-tauri/src/{hermes_bridge.rs, agent_lite/mod.rs, lib.rs}`, `src-tauri/src/hermes/june_web_mcp.py`, `src/lib/tauri.ts`, `src/components/mobile/screens/AgentScreen.tsx` (**carte lieux : /v1/web/places + places_search + render_map_card**, 2026-08-21, [ADR-0024](docs/adr/0024-chat-blocks-are-in-band-fenced-json.md)) | **Bloc `subrosa:places`** : endpoint additif `/v1/web/places` (trait domaine `PlacesSearcher`, service sans metering — OSM gratuit —, provider Nominatim avec UA + rate-limit 1 req/s + cache 24 h imposés par la politique OSM), outil `places_search` sur les deux shells (MCP `june_web` + bras proxy `/v1/web/places` dans hermes_bridge ; branch + tool def + `summarize_places_results` + stage `searching-places` dans agent-lite), commande partagée `render_map_card` (tuiles OSM assemblées par Rust → data URL, cache disque 30 j, retina zoom+1 ; **2 `generate_handler!`**), prompts étendus (paragraphe Place cards mobile + soul). | Réappliquer : la verticale june-api (additive, aucun contrat existant touché), le bras proxy, l'outil MCP, la branch agent-lite + const `PLACES_SEARCH_RESULTS`, `map_render.rs` dans les 2 listes, l'union `stage` de tauri.ts + `STAGE_TEXT` mobile |

| `june-api/crates/{domain/src/lib.rs, services/src/places.rs, api/src/handlers/web.rs, embed/src/lib.rs, api/tests/http_boundary.rs}`, `src-tauri/src/{june_api.rs, hermes_bridge.rs, agent_lite/mod.rs, lib.rs}`, `src/components/settings/AppSettings.tsx`, `src/components/mobile/screens/ConnectionScreen.tsx`, `src/test/mobile-settings.test.tsx` (**lieux premium : clé Google par requête + photos**, 2026-08-21) | **Provider Google Places (New) derrière le même trait** : la clé de l'utilisateur voyage PAR REQUÊTE (header `x-places-google-key`, pattern provider_credentials — jamais de config june-api, jamais de restart), lue du keychain par `june_api::forward_places_request` (agent-lite) et `forward_places_tool` (proxy Hermes : la clé est posée sur le hop sortant, jamais visible du MCP ni de l'agent). `PlacesService` route keyless/keyed sur présence de clé ; `PlaceResult.photo_ref` additif. Photos : commande `places_photo_data_url` (module `places.rs` app) — Rust appelle Google directement avec la clé keychain, data URL en cache disque, la clé n'atteint jamais le DOM. Réglages : section « Place search » (desktop onglet Carpe Diem, mobile ConnectionScreen) — seule la PRÉSENCE de clé traverse l'IPC. Prompts : `photoRef` rejoint la liste copy-verbatim. Test mobile-settings adapté (2 formulaires de clé). | Réappliquer : la verticale keyed (header→service→provider), les 2 forwards à clé, `places.rs` + ses 4 commandes dans les **2 `generate_handler!`**, les 2 sections réglages, le scoping `within(form)` du test |

| `src/lib/{chat-blocks.ts, map-projection.ts}`, `src/components/chat-blocks/{ChatBlockView.tsx, PlacesCard.tsx}`, `src/app/App.tsx`, `src/app/mobile/MobileApp.tsx`, `src-tauri/src/{agent_lite/mod.rs, hermes_bridge.rs}`, `src/lib/agent-chat-gallery.ts` (**blocs de chat phase 4 : carte interactive lite + bloc subrosa:notes**, 2026-08-22) | **Carte interactive sans lib JS** : boutons de zoom ±1 et pan à la souris (translation CSS live du layer image+épingles, re-rendu au relâcher ; les épingles se projettent sur la vue qui a produit l'image visible, jamais sur la cible — zéro dérive pendant le rendu en vol ; tactile exclu volontairement, le drag doit rester le scroll de la conversation). `unproject`/`panCenter` ajoutés à map-projection (round-trip testé). **Bloc `subrosa:notes`** : les notes citées deviennent des cartes qui NAVIGUENT dans l'app via l'événement fenêtre `june:open-note-from-chat` (`chat-blocks-nav.ts` ajouté) — App.tsx → `handleSelectNote`, MobileApp → `openNote` (le détail se pousse par-dessus l'onglet Chat). Ids de notes validés `[\w-]{1,64}`. Prompts « Note cards » sur les deux shells (ids verbatim des outils, jamais inventés). | Réappliquer : la machine mapState/targetView/dragOffset de PlacesCard (l'invariant : épingles projetées sur la vue RENDUE), les 2 listeners racine, le kind notes + sa nav, les 2 paragraphes de prompt |

| `src/app/App.tsx`, `src/app/mobile/MobileApp.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/{carpe_diem/jobs.rs, carpe_diem/workflow_runs.rs, dictation_mobile.rs, agent_lite/mod.rs}`, `src-tauri/gen/apple/{Podfile, project.yml, os-june_iOS/Info.plist}`, `src/test/ios-privacy-usage.test.ts` (**socle : routeur de destinations**, 2026-08-22) | Le schéma `subrosa://` était déclaré dans 4 fichiers et traité nulle part (aucun `on_open_url`, zéro route) et les **taps de notification n'étaient pas gérés** : même problème, même réponse. `subscribeToDestinations` (nouveau `src/lib/destinations.ts`) câble les 3 sources — URL de lancement, `onOpenUrl` à chaud, `onAction` de notification — vers un handler par shell (abonnement **mount-once** : un ré-abonnement relit l'URL de lancement et re-navigue ; le handler vit dans un ref rafraîchi au render). Les 4 notifications Rust portent leur adresse dans `extra.destination` (miroir `src-tauri/src/destinations.rs`). Piège de parsing corrigé : `new URL` normalise `note/../../etc` en `/etc` — on rejette `..` sur la chaîne brute et on n'accepte qu'un seul segment. Au passage : cible morte `os-june_macOS` supprimée du Podfile, et la dérive de version iOS (plist 1.30.0 vs project.yml 1.0.5) corrigée + épinglée par test. | Réappliquer : `destinations.ts`/`destinations.rs`, les 4 `.extra(...)`, les 2 effets mount-once, le durcissement du parseur |

| `src-tauri/src/{lib.rs, build.rs, db/migrations.rs, db/repositories.rs, domain/types.rs, hermes_bridge.rs, agent_lite/mod.rs}`, `src-tauri/src/hermes/june_context_mcp.py`, `src-tauri/{Cargo.toml, Info.plist}`, `src-tauri/gen/apple/{project.yml, os-june_iOS/Info.plist}`, `src/{app/App.tsx, app/mobile/MobileApp.tsx, lib/tauri.ts, components/note-editor/NoteEditor.tsx, styles/app.css}` (**contexte agenda**, 2026-08-22, [ADR-0025](docs/adr/0025-the-calendar-is-context-on-a-note.md)) | **L'app lit l'agenda sans jamais devenir un agenda.** Les specs 001/002 excluent explicitement « calendar » et « meeting object » : la décision est respectée à la lettre — 3 colonnes nullables sur `notes` (`calendar_event_id`, `scheduled_start`, `attendees_json`), **aucune table, aucun écran, aucun nom nouveau**. `src-tauri/src/calendar.rs` (ajouté) lit EventKit via `objc2-event-kit` — **un seul module pour macOS ET iOS** —, règle de rattachement pure et testée (T−10/T+15, événement déjà en cours, jamais un all-day), `match_recording` → One (rattache en silence + nomme la note si elle est vide) / Ambiguous (on DEMANDE, une fois) / None (comportement d'avant). Permission demandée au premier enregistrement, jamais au lancement ; refus = silence. Outil `search_calendar` sur les deux shells (agent-lite + MCP `june_context`, qui reçoit désormais `--proxy=` et est synchronisé APRÈS le MCP web) : **récupération, jamais d'injection du planning**. `request_access_blocking` volontairement non-async (les `Retained` objc2 ne sont pas `Send`). Clés `NSCalendars*UsageDescription` dans les 3 fichiers + test. | Réappliquer : `calendar.rs` + les 7 commandes dans les **2 `generate_handler!`**, le lien EventKit dans build.rs, les 3 `ensure_column`, l'ordre context-après-web dans le spawn, l'argv `--proxy=`, la note soul étendue |

| `src-tauri/src/{lib.rs, background.rs, commands.rs, db/migrations.rs, db/repositories.rs, destinations.rs, calendar.rs}`, `src-tauri/migrations/013_briefs.sql`, `src-tauri/tests/{briefs.rs, processing.rs}`, `src/{lib/tauri.ts, components/settings/AppSettings.tsx, components/mobile/screens/SettingsScreen.tsx, components/note-editor/NoteEditor.tsx, styles/app.css}` (**les moments : brief, récap, récap parlé**, 2026-08-22) | **Les deux seuls moments où l'app parle en premier.** `moments.rs` (ajouté) : le **brief** 10 min avant une réunion (planifié en LIGNE DURABLE relue par le sweep — jamais un timer, ADR-0018 ; une par réunion via l'index unique, plafond 6/jour qui ne compte QUE les livraisons), et le **récap** quand une note est prête (posté depuis Rust : la webview est gelée quand une longue transcription finit). **Règle du silence** : un créneau solo, un all-day, une réunion déjà commencée, ou des notes qui ne disent rien des participants ⇒ `skipped`, et le sentinel `NOTHING` du modèle est une réponse valide (le filtre du contexte vide se déclenche AVANT de payer un appel). Taps routés par le socle : un brief démarre l'enregistrement, un récap ouvre la note. Réglages `moments.json` (miroir `OnceLock<Mutex>` comme memory) exposés sur les 2 shells — **brief OFF par défaut** (rien ne doit se mettre à parler à qui n'a pas dit oui), récap ON. **Récap parlé** : `note-speech.ts` (markdown → texte prononçable, tables/code jetés, cap 4000 car car la TTS est facturée au caractère, blob URL jamais data: pour WKWebView) + bouton `ListenButton` dans le NoteEditor partagé. | Réappliquer : `moments.rs` + les 2 commandes dans les **2 `generate_handler!`** + `moments::setup`, `crate::moments::tick` dans le sweep, l'`announce_note_ready` du task de traitement (app handle threadé dans `finish_recording_session`), la migration 013 (**aucun `;` dans les commentaires**), les 2 sections de réglages |

| `src-tauri/src/{lib.rs, db/migrations.rs, db/repositories.rs, Cargo.toml, hermes_bridge.rs, agent_lite/mod.rs}`, `src-tauri/migrations/014_agent_actions.sql`, `src-tauri/{Info.plist}`, `src-tauri/gen/apple/{project.yml, os-june_iOS/Info.plist}`, `src/{lib/chat-blocks.ts, lib/tauri.ts, components/chat-blocks/ChatBlockView.tsx, styles/app.css}` (**actions proposées**, 2026-08-22, [ADR-0024](docs/adr/0024-chat-blocks-are-in-band-fenced-json.md)) | **L'agent propose, l'utilisateur tape, et alors seulement ça se fait.** Bloc `subrosa:proposal` + registre d'actions typées (`reminder`, `event`, `note`) : UNE seule surface de confirmation, ajouter un type = un bras dans `actions.rs` + une icône, jamais un écran. **Le problème résolu** : un message est immuable, donc l'état « fait » ne peut pas vivre dans le texte — sinon rouvrir la conversation repropose la même action. La table `agent_actions` (unique sur proposal_id+action_id) est la vérité, la carte la lit au montage (ADR-0018 appliqué à l'interface). Ligne écrite **seulement en cas de succès** : un échec laisse honnêtement le bouton, avec la raison à côté. Écritures EventKit (`EKReminder`/`EKEvent`, permission d'écriture demandée au moment du tap, sélecteurs iOS 17 vs 15 via `respondsToSelector`) + `NSReminders*UsageDescription` dans les 3 fichiers + test. Un bloc sans `proposalId` est refusé (nulle part où enregistrer). | Réappliquer : `actions.rs` + les 2 commandes dans les **2 `generate_handler!`**, la migration 014 (**pas de `;` en commentaire**), le kind `proposal` du parseur, `ProposalCard`, les 2 paragraphes de prompt |

| `src-tauri/src/{lib.rs, background.rs, commands.rs, Cargo.toml}`, `src/components/settings/{AppSettings.tsx, MomentsSettingsSection.tsx}`, `src/components/mobile/screens/SettingsScreen.tsx`, `src/lib/tauri.ts`, `src/styles/app.css` (**être joignable : Spotlight + automatisations**, 2026-08-22) | **Spotlight** (`spotlight.rs` ajouté) : les notes trouvables depuis la recherche système, via `objc2-core-spotlight` — **aucun Swift, aucune cible d'extension**, exactement le patron des autres ponts natifs. Chaque item porte `contentURL = subrosa://note/<id>`, donc un résultat s'ouvre par le routeur du socle. **La question de vie privée est posée, pas supposée** : titres + dates indexés par défaut, **corps de note seulement sur opt-in explicite** (l'index système n'est pas le stockage de l'app et survit à celui-ci) ; couper l'indexation SUPPRIME ce qui y est déjà. Réindexation dans le sweep + après génération d'une note, `forget()` sur les deux commandes de suppression (un résultat ne doit jamais survivre à sa note). **Automatisations** : le routeur rend déjà chaque destination pilotable depuis Shortcuts (action « Open URL ») — les 3 adresses (`record`, `dictation`, `chat?q=`) sont listées et copiables dans les réglages des 2 shells, ce qui est la valeur d'App Intents pour ces verbes, sans Swift. **App Intents / Live Activity NON faits, et pourquoi** : les deux exigent du Swift dans une cible (le projet n'en a aucun), un **app group** (entitlement → capability à activer dans le portail développeur) et, pour la Live Activity, une **cible d'extension `.appex`** avec sa propre signature. La lane iOS signe en provisioning cloud (`-allowProvisioningUpdates`) : un changement d'entitlement peut casser la release, et rien ici ne permet de le vérifier sans build device. À ouvrir comme un chantier propre, pas comme une phase. | Réappliquer : `spotlight.rs` + les 2 commandes dans les **2 `generate_handler!`** + `spotlight::setup`, le `reindex_all` du sweep, les 2 `forget()`, la section Automatisations |

## Fichiers ajoutés par le fork (préférés)

| Fichier | Rôle |
|---|---|
| `FORK_NOTES.md`, `HANDOFF.md` | Traçabilité fork + handoffs humains |
| `src/lib/chat-blocks.ts`, `src/components/chat-blocks/ChatBlockView.tsx`, `src-tauri/src/open_url.rs`, `docs/adr/0024-chat-blocks-are-in-band-fenced-json.md` | Protocole des blocs de chat (parse/validation sans dépendance, caps + https-only + domaines dérivés), composants carte/squelette partagés desktop+mobile, commande d'ouverture https (navigateur desktop / `UIApplication openURL:` iOS) |
| `src/lib/destinations.ts`, `src-tauri/src/destinations.rs` | Vocabulaire des destinations (`subrosa://note/<id>`, `chat[/<id>][?q=]`, `dictation`, `studio`, `record`) : parseur strict côté shell, constructeur côté Rust, un test par côté |
| `src-tauri/src/calendar.rs`, `src/lib/calendar-link.ts`, `src/components/calendar/MeetingContext.tsx`, `docs/adr/0025-the-calendar-is-context-on-a-note.md` | Pont EventKit (les 2 plateformes), règle de rattachement + permission au bon moment côté shell, les 2 seules surfaces d'agenda de l'app (ligne sous le titre, question d'ambiguïté avec « Neither » comme vraie réponse) |
| `src-tauri/src/moments.rs`, `src-tauri/migrations/013_briefs.sql`, `src/lib/note-speech.ts`, `src/components/note-editor/ListenButton.tsx`, `src/components/settings/MomentsSettingsSection.tsx` | Le brief et le récap (règles pures testées : qualification, sentinel NOTHING, première phrase du récap), la table durable, le texte prononçable d'une note et son bouton, le réglage des deux moments |
| `src-tauri/src/actions.rs`, `src-tauri/migrations/014_agent_actions.sql`, `src/components/chat-blocks/ProposalCard.tsx` | Le registre d'actions proposées, la table qui porte l'état « fait » hors du message immuable, et la carte qui la lit |
| `src-tauri/src/spotlight.rs`, `src/lib/automations.ts`, `src/components/settings/AutomationsSection.tsx` | L'index système (règle de vie privée pure et testée : le corps n'atteint jamais l'index sans consentement) et les adresses d'automatisation partagées par les 2 shells |
| `june-api/crates/{providers/src/osm_places.rs, services/src/places.rs}`, `src-tauri/src/map_render.rs`, `src/lib/map-projection.ts`, `src/components/chat-blocks/PlacesCard.tsx` | Verticale lieux : provider Nominatim (mapping wire testé), service, compositeur de carte statique (projection miroir de map-projection.ts — les deux doivent rester d'accord ou les épingles dérivent), fitBounds/pixelOffset, carte lieux (épingles DOM synchronisées survol⇄liste, attribution obligatoire, dégradé liste seule sans carte) |
| `june-api/crates/providers/src/google_places.rs`, `src-tauri/src/places.rs`, `src/components/settings/PlacesSettingsSection.tsx` | Provider Google Places API (New) (searchText + FieldMask minimal facturé, mapping wire testé, 1ʳᵉ photo seulement), module clé+photos app (keychain `.places`, `SUBROSA_DEV_PLACES_KEY` en debug, validation stricte des photo refs), section réglages desktop |
| `src-tauri/src/carpe_diem/{mod,branding,settings,sidecar}.rs` | Branding Rust + store réglages/keyring + IPC + **gestionnaire de sidecar june-api** |
| `src/lib/branding.ts` | Constantes de marque + défauts Carpe Diem (frontend) |
| `src/lib/carpe-diem-credits.ts` | Hook `useCarpeDiemCredits` (solde + facteur de prix pour le footer sidebar ; poll 60 s + refresh au focus). **Rail-aware (2026-07-15)** : `carpe_diem_get_credits` (settings.rs) renvoie le solde du **rail ACTIF** (pas toujours le pool credits) — si `effective_rail`=prepaid, `availableCredits` = `usdcBalance × 100` du compte prepaid + champ `rail` ; footer (`creditsLabel`) et écran Réglages mobile étiquettent « · prepaid ». Sinon le footer mentait (pool credits affiché pendant qu'un rail prepaid vide 402-ait). **Proposition proactive (2026-07-15)** : `carpe_diem_get_credits` renvoie aussi `suggestSwitchTo` (`suggest_switch` : rail actif < 0,01 $ ET l'autre rail a des fonds → l'autre rail), et `components/carpe-diem/RailSwitchBanner.tsx` (partagé, monté dans `App.tsx` main-panel + `MobileApp` shell) affiche une bannière « ton X est vide, bascule sur Y ? » avec un bouton one-click `carpe_diem_set_rail` — dismissible par suggestion, pas de poll en plus (réutilise `useCarpeDiemCredits`). |
| `src/components/settings/CarpeDiemSettings.tsx` + `src-tauri/src/carpe_diem/settings.rs` + `src/lib/carpe-diem-billing.ts` (**panneau Paiement rail-aware**, 2026-07-15) | Section Réglages (base URL + clé + test + statut sidecar) **+ panneau « Payment »** : CD facture **un rail à la fois** — un **compte prepaid** (USDC auto-custodial) et un **pool credits** sont des soldes séparés, et le rail actif (`auto` route vers le prepaid si un compte existe) peut être **vide pendant que l'autre a des fonds** → 402 « Payment rail cannot cover » que « recharge » ne corrige pas (incident « Rosa - Spot »). Commandes Rust `carpe_diem_get_billing` (agrège `/v1/credits` + `/v1/prepaid/status` + `/v1/prepaid/rail`, cdm_ only, best-effort) et `carpe_diem_set_rail` (`POST /v1/prepaid/rail`) — **dans les DEUX `generate_handler!`** (carpe_diem partagé). `deriveBilling` (lib) calcule le rail effectif + l'alerte « rail actif vide / fonds ailleurs ». UI : 2 soldes distincts + rail actif + bascule (auto/credits/prepaid) + bandeau d'alerte ; réutilisé compact sur mobile (`SettingsScreen`). Messages 402 runtime (`june_api.rs`, `agent_lite/mod.rs`) reformulés pour pointer le panneau Paiement (substring « balance is too low » gardé pour `isInsufficientCreditsMessage`). |
| `src-tauri/src/db/{migrations,repositories}.rs`, `src-tauri/src/{domain/types,commands,lib}.rs`, `src/lib/tauri.ts`, `src/lib/vision-routing.ts` (nouveau), `src/components/mobile/{ModelSheet.tsx, screens/AgentScreen.tsx}`, `src/app/mobile/MobileApp.tsx`, `src/components/agent/AgentWorkspace.tsx`, `src/styles/mobile.css` (**Changer de modèle en cours de conversation**, 2026-07-17, [ADR-0013](docs/adr/0013-mid-conversation-model-switching.md)) | Le modèle devient une **propriété du tour**, pas de la session (voir ADR-0013 : on n'utilise **pas** le rebind `/model` Hermes, invérifiable). **(1) Modèle persistant par session** : colonne `agent_tasks.model` (via `ensure_column`), `create_agent_task(model)` + `set_agent_task_model` (commande partagée, **2 `generate_handler!`**), le picker mobile restaure `task.model` à l'ouverture et persiste les switches. **(2) Resend** : mobile ne perd plus le message (retry re-joue le tour sans retaper, sur le modèle courant ; composer restauré si la création du task échoue) ; desktop pose un « Try again » sur `UpstreamBusyNoticePart` (prop `onRetry` de `AgentChatTurnRow`, re-soumet le dernier message user). **(3) Fork** : `fork_agent_task` (repo + commande partagée) copie le transcript sur un modèle choisi, l'original intact ; UI = bouton branch par ligne du `ModelSheet` (`onFork` optionnel) → nouveau thread via `openChatSession` (prop `onOpenSession` d'`AgentSessionScreen`, câblée dans MobileApp). **(4) Vision auto-route** : `resolveTurnModel` (lib pure) route un tour image vers un modèle vision-capable indépendamment du modèle de chat, appliqué dans `send()`/`retryTurn()`. Tests : `agent.rs` (model+fork repo), `tauri-contract`, `mobile-chat-model`, `agent-workspace` (busy retry), `vision-routing`. | Réappliquer : `ensure_column` model + `fork_agent_task`/`set_agent_task_model` (repo+DTO+**2 listes**), binding tauri, `onRetry` d'`AgentChatTurnRow`, `onFork`/`onFork` du ModelSheet, `onOpenSession` MobileApp, `resolveTurnModel` + son câblage ; garder l'ADR-0013 |
| `src/components/carpe-diem/CarpeDiemGate.tsx` | Écran de connexion premier lancement |
| `src/test/carpe-diem-settings.test.tsx` | Tests UI Carpe Diem |
| `src-tauri/src/carpe_diem/cache_stats.rs`, `src/lib/carpe-diem-cache.ts`, `src/test/carpe-diem-cache.test.tsx` (**Ledger de cache**, 2026-08-21) | Agrégat **en mémoire, par lancement** de ce que le cache de prompt de l'operator a fait : alimenté depuis `proxy_agent_chat_completions` (le seul point que traversent les deux coques — agent desktop, agent-lite, extraction mémoire, titres de session, briefs Studio), lu par la commande `carpe_diem_cache_stats` (**dans les DEUX `generate_handler!`**, avec un test qui le vérifie en lisant `lib.rs`). Rendu par `SessionUsagePanel` (2e source à côté de celle du gateway Hermes, qui ne peut pas connaître le cache) et par la carte « Prompt cache » de `CarpeDiemSettings` (donc aussi sur mobile). Pas de table : la question est « est-ce que le cache marche là maintenant », pas un historique. |
| `src-tauri/src/carpe_diem/media.rs` | **Proxy média Studio** : commande générique allowlistée vers `/image/*`, `/video/*`, `/audio/*`, `/chat/completions` (clé lue du keychain, jamais exposée à la webview) ; catalogue fusionné CD `/v1/models` + contraintes du catalogue public Venice (ids identiques) + `/pricing` ; galerie d'artefacts sur disque (`$APPDATA/studio-media/`). Voir `docs/adr/0008-studio-media-proxy-in-tauri.md` |
| `src/lib/studio/seedance.ts` (2026-08-14) | **Contrat seedance** (guide Venice Seedance 2.0) : caps par version (refs images 9 en 2.0 / 30 en 2.5, clips 3/10, durée combinée 15s/30s), **mentions canoniques** `<Image 1>`/`<Video 1>`/`<Audio 1>` (`referenceMention`, prose ailleurs), les 4 workflows routés par le prompt (`SEEDANCE_WORKFLOWS`, `detectSeedanceWorkflow`) + garde-fou anti-misrouting (`seedancePromptAdvice`, branché sous le prompt des deux shells), validation locale des photos (≥300px, ratio hors 0,4-2,5), caveat des modèles publics `-basic` (refus des personnes malgré l'attestation), plafond 35 MB de requête. `video-request.ts` gagne `reference_video_urls`/`reference_audio_urls`/`reference_video_total_duration` (audio jamais seul), `model-constraints.ts` gagne l'entrée seedance-2-5 (4-30s, 480p/720p) et le ratio `adaptive` sur les variantes reference (en dernier : ne doit pas devenir le défaut) |
| `src/lib/studio/{seedance,reference-media,catalog,video-request}.ts` + `src/components/{studio/VideoStudio.tsx, mobile/{ModelSheet.tsx, screens/StudioScreen.tsx}}` + `src/lib/artifact-media.ts` (**Médias de référence : découvrabilité, gating, parité**, 2026-08-14, [ADR-0022](docs/adr/0022-model-inputs-follow-published-constraints.md)) | Parti de « je ne vois pas seedance 2.5 R2V sur mobile » — le modèle était atteignable mais invisible, et deux vrais bugs derrière. **(1) Découvrabilité** : une famille vidéo = 1 ligne pour jusqu'à 4 modèles, donc chercher « r2v » / « rtv » / `seedance-2-5` ne matchait rien ; `videoFamilySearchTerms` (ids + noms des variantes + raccourcis de direction) alimente `ModelSheetEntry.keywords`, et `variantHint(family, model)` nomme la variante résolue (« reference to video · Seedance 2.5 R2V ») sur les **deux** shells. **(2) Gating par contraintes publiées (ADR-0022)** : `supportsReferenceMedia` (id-only) → `takesReferenceClips`/`takesReferenceAudio` qui lisent `constraints.video_input`/`audio_input`, le repli id ne s'appliquant qu'en l'absence de flag (et connaissant le tier `-basic`) ; le desktop n'offre donc plus de slot clips sur les variantes qui les refusent (dépense inutile), `maxReferenceAudio` est un cap séparé, `seedanceWorkflowsFor` retire les 3 ouvertures clip-driven aux modèles sans video input, et les clips/audio déjà choisis sont purgés au changement de famille. **(3) Parité mobile** : `MediaReferencePicker` (clips + audio, liste numérotée, `accept=video/*|audio/*`, galerie) — mesure via **object URL** (WKWebView ne charge pas un `data:` dans un `<video>`), envoi via `artifactDataUri` (jamais un blob dans un body) ; boutons de workflow des deux côtés (dont la recette `reference`, qui manquait aussi au desktop). **(4) Garde-fous** : `reference-media.ts` partagé (`referenceClipProblem`, `referenceAudioProblem`, `referenceFileTooBig` avant lecture, `mediaSeconds` borné), `seedanceImageProblem` sur mobile, et `inlineMediaInputs(body)` + `requestSizeProblem` qui plafonnent le **corps entier** avant l'envoi (les deux shells). **(5) Attestation** : un clip montre une personne comme une photo → `needsSeedanceConsent(model, hasFaceMedia)` et `videoRequestBody` incluent les clips. **(6) Catalogue** : `videoFamilyKey` découpe la direction **au milieu** de l'id en gardant `-basic` (les deux tiers ne doivent pas fusionner), et `familyDisplayName` rend lisibles les familles que Venice ne nomme pas (`seedance-2-0` → « Seedance 2.0 (full) »), le tag de tier n'apparaissant que si les deux tiers existent. Tests : `studio-seedance-catalog` (fixture capturée du catalogue live, 22 ids), `studio-seedance-discovery`, `studio-reference-media`, + ajouts dans `studio-catalog`/`studio-seedance`/`studio-video-request`/`studio-workflow-validator`. | Réappliquer : les 3 nouveaux fichiers (`reference-media.ts`, la fixture, les 2 suites), `keywords` dans `ModelSheet`, `variantHint`/`videoFamilySearchTerms`/`humanizeModelId` dans `catalog.ts`, `inlineMediaInputs` dans `video-request.ts`, `artifactDataUri` dans `artifact-media.ts` ; garder l'ADR-0022 |
| `src/lib/studio/{types,client,catalog,paths,async-job,artifacts}.ts` | Lib Studio frontend : client IPC typé (retry/backoff), catalogue + groupement familles vidéo t2v/i2v + matrice lyrics musique + estimation de coûts, chemins par backend (musique = `/audio/music/*` sur CD ; retrieve superset `{id, queue_id, model}`), jobs async persistés (reprise après restart), galerie |
| `src/lib/studio/workflow/{schema,validator,engine,cost,models,store,templates,index}.ts` + `src/lib/studio/workflow-run.ts` | Workflows média : schéma déclaratif de nodes (textInput/asset/document/chat/image/**imageEdit** (composeImages 1-3 sources, modèles via `imageEditModels` incl. passthroughs CD)/tts/music/video/lastFrame/gate/assemble/output) à **ports d'entrée nommés** (un node vidéo distingue prompt / opening frame / end frame / références ; ports média contraignants, résolution par affinité de kind pour les edges sans port — rétro-compat), validateur (cycles DFS, kinds par port, capacités, ports requis, params requis), engine par niveaux topologiques avec outputs typés et **persistance à la production** via un `WorkflowStorage` injecté (chaque média sauvé au node qui l'a produit, avec modèle/prompt réels et **liens parent ADR-0019** quand un plan continue un autre via lastFrame — les chaînes produites par workflow sont de vraies chaînes galerie), node assemble (cut list en ordre de connexion, trims automatiques aux handoffs, piste audio optionnelle → un film dans la galerie), **node gate** (pause d'approbation : statut `awaiting` + statut de run `awaiting_gate`, passthrough du candidat choisi — les prises alternatives sont des nodes séparés branchés sur un même gate, l'approbation choisit ; approbations par run, jamais stockées dans le workflow — addendum ADR-0021), **modèle de coût** (`cost.ts` : estimation par node via la même machinerie que le reste du Studio — costCredits plats, paliers musique × priceMultiplier, `/video/quote` USD→crédits au lancement — total sur la toolbar, handshake de confirmation pré-dépense au-delà de 20 crédits / vidéo quotable / média non pricé, coûts estampillés sur les artefacts produits donc `chainCost` juste), persistance localStorage, templates (dont « Short film with score ») |
| `src/components/studio/*` + `src/styles/studio.css` | Vues Studio : Image (contraintes serveur, variants, edit/upscale, path async pour modèles lourds), Video (quote de prix, poll + chrono, reprise de jobs), Music (règles lyrics par modèle, prix par palier de durée), Workflows (canvas `@xyflow/react`, handles par port nommé, connexions refusées au drop si kind/capacité incompatibles, statut live + % de progression par node, pickers galerie/notes sur les nodes asset/document — `GalleryPicker` multi-kinds + `NotePicker`) ; galerie commune (lightbox, export, suppression). Mobile : l'éditeur linéaire offre aussi asset/document/imageEdit/gate (sheets galerie/notes dans `WorkflowEditor.tsx`), les modèles passent par `modelsForParam` partagé (le mobile ne listait que les modèles t2v pour le step vidéo), et `assembleWorkflow` applique la règle « pending sources » : les steps sans entrée s'accumulent et alimentent tous le prochain step qui accepte des entrées (corrige le textInput en milieu de liste). **Ordre des connexions** (`workflow/ordering.ts`) : l'ordre d'un port multi = l'ordre des edges dans le tableau (contrat verrouillé par tests moteur sur `reference_image_urls`, les sources multi-edit et la cut list) ; UI = badges numérotés côté port (edge custom, masqués sous zoom 0.75), liste réordonnable ↑/↓ sous le port, clic sur une entrée image = insère « image N » dans le prompt, bouton « Order by chain » sur assemble quand le graphe (video→lastFrame→video) contredit l'ordre câblé, candidats du gate numérotés avec « (default) » sur le n° 1 ; côté mobile l'ordre est l'ordre des steps (déjà réordonnable). **Passe d'ergonomie 2026-08-14** (addendum ADR-0022) : (1) **ports pilotés par le modèle** — capacité 0 = port *fermé* (non dessiné, non connectable, erreur nommée du validateur), lu partout via `openInputPorts` et jamais via `schema.inputs` ; la direction vient du catalogue (`videoDirection`) et voyage dans les params (`modelDirection`, écrit par `modelParamPatch`) car ni le validateur ni l'engine n'ont de catalogue ; un id qui n'annonce aucune direction laisse tout ouvert (9 modèles vidéo sur 101, dont 5 i2v) ; l'affinité re-loge sur les ports ouverts mais ne dégrade jamais un média vers un port texte ; `strandedEdges` lâche visiblement les connexions orphelines au changement de modèle **et à l'ouverture** ; (2) **duration / aspect ratio / resolution en listes** (`ParamSchema.modelOptions` + `paramOptions`/`effectiveParamValue`/`paramApplies` dans `workflow/models.ts`) : valeurs de `effectiveVideoConstraints`, affichage = ce qui sera envoyé (miroir du `pick` de `video-request`), re-calage au changement de modèle, réglage inexistant masqué (liste publiée vide ≠ absente, cf. `videoFieldApplies`), et le canvas **apprend des refus** (`rememberConstraintError` sur l'échec d'un node + `explainConstraintError` à l'affichage) ; (3) **nœuds nommables** (`nodeLabel`, nœuds créés sans nom, type en placeholder) ; (4) **vignettes d'asset** (`useArtifactIndex` : un seul `listArtifacts` pour tout l'éditeur ; `useArtifactPreview` : protocole asset sur desktop, image seule sur iOS ; artefact supprimé signalé avant le run) ; (5) **badges d'ordre côté source** + mise en évidence croisée liste ↔ fil ; (6) **bouton « Insert {{input}} »** au curseur, offert seulement là où une entrée texte est câblée (`textSourceLabels`) |
| `src/test/studio-*.test.ts` | Tests catalogue/paths/statuts + validateur + engine (28 tests) |
| `src-tauri/src/memory/{mod,extract,recall}.rs` + `src-tauri/migrations/010_memory.sql` | **Mémoire inter-conversations** : réglages (`memory.json`), commandes CRUD, extraction auto (cadence 3, fenêtre 5+5, importance 1-10 inversée, dédup), bloc d'injection partagé, embeddings BGE-M3 (appel direct Carpe Diem `/embeddings`, blobs f32 LE, backfill best-effort) + recall hybride RRF. Voir `docs/adr/0009-local-cross-conversation-memory.md` |
| `src/lib/memory.ts` | Déclencheur d'extraction desktop (compte les tours assistant par session Hermes, fenêtre les messages, appelle `memory_extract`) |
| `src/components/settings/MemorySettingsSection.tsx` + `src/components/mobile/MemorySettings.tsx` | UI de gestion : toggles (mémoire / apprentissage auto), liste avec pause/édition/suppression, ajout manuel, « forget all » en deux temps |
| `src/test/memory.test.ts`, `src/test/memory-settings-section.test.tsx`, `src-tauri/tests/memory.rs` | Tests : normalisation/fenêtrage frontend, UI Settings, intégration SQLite du repository |
| `src-tauri/src/hermes_working_dir.rs` | **Dossier de travail par session** (ADR-0014) : validation canonique d'un dossier utilisateur avant tout grant sandbox (refus : racines, ancêtres/descendants des stores de secrets, app data dir, préfixes système, containers exacts ; warning « broad ») + commandes `validate_agent_working_dir`/`reveal_agent_working_dir` + tests unitaires (symlinks, espaces/accents) |
| `src/lib/agent-session-working-dir.ts` + `src/test/agent-session-working-dir.test.ts` | Registre localStorage du dossier par session (miroir d'`agent-session-modes.ts` : absence = workspace par défaut) + récents plafonnés + `workingDirDisplayName` |

| `src-tauri/src/{bible,shotlist,timeline,studio_actions}.rs` + `src-tauri/migrations/{017_bible,018_shot_lists}.sql` | **Production de films locale (ADR-0029 à 0033, 2026-08-24)** : la bible (identités persistantes, pointeurs vers des artefacts galerie), la shot list (ligne dérivée sur une note, reprise partie par partie), l'écriture d'un bundle timeline, et la table d'actions partagée par le MCP et agent-lite. Remplace tout le module `videomaker/`, retiré. |
| `src-tauri/src/hermes/june_studio_mcp.py` + `hermes_bridge.rs` (`/v1/studio/request`, `JUNE_SOUL_STUDIO_MD`) | **Surface agent** : deux outils action-discriminés (`bible`, `shots`), ~700 tokens toujours chargés, avec un test qui cliquette la taille. Le détail vit dans le skill `subrosa-production`. Remplace `june_films_mcp.py` et `/v1/films/request`. |
| `src/lib/studio/{timeline/,mix.ts,loudness.ts,judge.ts,bible/}` + `workflow/compile.ts` | **Finition et compilation fork-side** : export FCPXML/xmeml + `.srt`, mix hors-ligne déterministe avec loudness BS.1770 et ducking par automation, juge best-effort, discipline de prompt, et la compilation d'une shot list vers le graphe workflow existant. |
| `src/components/studio/{BibleStudio,ScriptToFilm}.tsx` | Les deux surfaces neuves : nommer une identité une fois, et aller d'une note à un film. Remplacent `FilmStudio`, `FilmDirectorPanel`, `FilmProduceControl` et `VideomakerSettings`, tous supprimés. |
| `.github/workflows/repository-hygiene.yml` (garde `furetier.com\|vmk_\|videomaker`) | Le retrait est **exécutoire**, pas seulement souhaité : une PR qui réintroduit le studio distant échoue, même via un sync amont. Même mécanique que les gardes June d'ADR-0017. |

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
- **Catalogue de modèles (tâche 12, résolue 2026-07-04)** : `VeniceModelCatalog::priced_models`
  (`june-api/crates/providers/src/venice.rs`) tente d'abord le shape Venice puis retombe sur le shape Carpe Diem
  (OpenAI-flat + discriminant `carpe_diem_type`). Carpe Diem ignore `?type=` (une réponse = tout le catalogue) et ne
  met pas de pricing dans `/v1/models` ; le fallback joint donc `GET {racine opérateur}/pricing` (base_url sans le
  suffixe `/v1`) par id de modèle — prix USD/M tokens pour le texte, **USD/minute audio pour l'ASR** (converti en /s).
  Résultat : ~94 modèles servis (89 text + 5 asr) ; les types image/vidéo/tts/musique/embedding sont ignorés (aucun
  endpoint June ne les consomme). Un modèle sans ligne de pricing est écarté (même règle que le parseur Venice).
  Échec du fetch/parse → dégradation gracieuse inchangée vers les 6 modèles curatés de `config.toml`.
  C'est **le** point chaud du merge upstream dans `venice.rs` (voir tableau des fichiers modifiés).

## Autonomie vis-à-vis de June (2026-07-25)

Le fork ne contacte plus **aucune** infra upstream et ne se présente plus comme June.
Décision + alternatives rejetées : [`docs/adr/0017-product-autonomy-from-june.md`](docs/adr/0017-product-autonomy-from-june.md).

- **Identifiants techniques gardés volontairement** : crate `os-june`, crates `june-*`,
  env `JUNE_*`/`OS_JUNE_LOCAL_DEV*`/`JUNE__*`, événements `june://`, clés `os-june:*`,
  outils MCP `june_*`. Renommer aurait cassé le cherry-pick des correctifs upstream
  (~2000 occurrences, 233 fichiers) pour un gain invisible côté utilisateur.
- **Identité** : `JUNE_SOUL_MD` (`hermes_bridge.rs`) disait « You are June … made by Open
  Software » et récitait les garanties du backend hébergé de June. Réécrit : identité
  Sub Rosa, et les garanties TEE sont attribuées à **Carpe Diem**, pas reprises à notre
  compte. Les fragments `JUNE_SOUL_*` et `JUNE_HINT_*` sont purgés du nom produit ;
  les noms d'outils MCP restent. Épinglé par `sync_june_soul_replaces_default_hermes_identity`.
- **Mot d'éveil dictée** : « hey June » → « hey Rosa » / « hey Sub Rosa »
  (`agent_session_prompt_from_dictation`, le parseur consomme désormais deux mots).
- **OS Accounts supprimé** (voir tableau). Les marques `JuneMark`/`JuneGradientMark`
  vivaient dans `AccountGate.tsx` et sont utilisées par 7 fichiers dont le shell mobile :
  elles ont migré vers `src/components/brand/Marks.tsx` (`BrandMark`/`BrandGradientMark`)
  **avant** la suppression. `SignInStep` portait aussi l'écran de bienvenue → conservé en
  `WelcomeStep` sans les parties compte.
- **Fail-closed** : `june_api_url()` renvoie `Option<String>` et **n'a plus de défaut
  distant** (c'était `june-api.opensoftware.co`, actif à chaque boot avant le spawn du
  sidecar et en permanence si le spawn échouait). Les appelants remontent
  `backend_not_ready` ; `ensure_sidecar_ready()` attend désormais aussi côté desktop.
- **`/verify`** décrit le sidecar local (ce qu'il garde, ce qui sort, ce qu'il ne peut pas
  prouver) au lieu de l'enclave Phala de June. `[attestation]`, `[issue_reports]` et
  `os_accounts.iss` de `config.toml` sont neutralisés — inertes déjà, mais `config.toml`
  est embarqué dans le binaire iOS via `include_str!`.
- **CI** : `rc-desktop-dmg.yml`, `promote-desktop.yml` et `production-desktop-windows.yml`
  supprimés (ils publiaient sur `os-june-releases` avec un token GitHub App scopé sur les
  repos upstream). Addendum daté sur l'ADR 0003. `upstream-sync.yml` gardé.
- **⚠️ Garde CI** : l'étape « Reject reintroduced June coordinates » de
  `repository-hygiene.yml` fait **échouer la PR** si `opensoftware.co`, `os-june-releases`,
  `You are June` ou `made by Open Software` réapparaît hors allowlist. C'est le point le
  plus important de ce lot : sans elle, un cherry-pick réintroduit ces chaînes sans qu'aucun
  test ne bronche. Si une PR de sync échoue là-dessus, **retirer l'apport**, ne pas
  l'adopter ni élargir l'allowlist.

## Portage iOS (2026-07-05)

L'app iPhone partage le frontend React et le core Rust ; Tauri 2 cible iOS via le projet Xcode
généré (`src-tauri/gen/apple/`, committé). Décisions structurantes :

- **Sidecar in-process** : iOS interdit les sous-processus. La composition root de june-api a été
  extraite dans **`june-api/crates/embed/` (`june-embed`)** — `crates/app/src/main.rs` devient un
  CLI mince par-dessus — et `carpe_diem/sidecar.rs` a deux backends (`#[cfg(desktop)]` = spawn du
  binaire inchangé ; `#[cfg(mobile)]` = `june_embed::serve` sur une tâche tokio, shutdown par
  oneshot). Contrat inchangé : mêmes 4 env vars, même `/livez`, mêmes événements de statut.
  `config.toml` est embarqué par `include_str!` (pas de resource path dans le sandbox iOS).
- **Pas de Hermes sur mobile** : l'agent est **agent-lite** (`src-tauri/src/agent_lite/`) — boucle
  d'outils sur `/v1/chat/completions` avec `search_notes` (LIKE sur notes+transcripts locaux,
  `Repositories::search_note_context`) et `web_search` (`/v1/web/search`). Sessions dans les mêmes
  tables `agent_tasks`/`agent_messages`. Desktop garde Hermes.
- **Audio** : cpal enregistre sur iOS, mais il faut configurer/activer `AVAudioSession` avant
  d'ouvrir le stream — `src-tauri/src/audio/ios_session.rs` (objc2, framework AVFAudio lié dans
  build.rs). `UIBackgroundModes: audio` (Info.plist) couvre l'écran verrouillé. Capture système
  et mode `MicrophonePlusSystem` refusés sur mobile.
- **Arrière-plan = lignes durables, pas de tâches longues**
  ([ADR-0018](docs/adr/0018-ios-background-work-is-durable-rows.md)). iOS gèle la WebView et
  suspend le process : rien de long ne peut vivre dans une promesse JS ni dans une tâche tokio
  nue. Toute opération qui peut survivre au premier plan **écrit d'abord une ligne** (`notes`,
  `media_jobs`, `pending_dictations`, `agent_tasks`), et `crate::background::sweep` la relance au
  boot, au `Resumed` et dans les fenêtres BGTaskScheduler. Corollaire : ne jamais rajouter une
  boucle de polling dans `src/lib/studio/` — elle s'arrêterait à l'instant où l'app passe en
  arrière-plan.
- **Deux listes `generate_handler!`** dans `lib.rs` (desktop complète / mobile sous-ensemble) —
  la macro ne cfg-e pas les entrées individuelles. **Garder les commandes partagées en sync.**
- **Shell mobile dédié** : `src/main.tsx` choisit `MobileApp` (`src/app/mobile/`) via
  `isMobilePlatform()` (plugin-os ; override `?mobile=1` en dev navigateur). `App.tsx` desktop
  intact. Le shell réutilise `notesReducer`, les wrappers IPC, `NoteEditor`, `CarpeDiemSettings`.
- **Keychain** : crate `keyring` étendu à `cfg(any(macos, ios))` — validé sur simulateur (probe
  debug au boot, `lib.rs`).

**Fichiers upstream modifiés (iOS) :**
| Fichier(s) | Raison | Re-merge |
|---|---|---|
| `src-tauri/src/lib.rs` | cfg-gating des modules/plugins/setup desktop, split des deux listes de handlers, `#[tauri::mobile_entry_point]`, probe keychain debug | Réappliquer le gating ; toute nouvelle commande partagée va dans **les deux** listes |
| `src-tauri/Cargo.toml` | `crate-type` staticlib/cdylib, plugins desktop sous `cfg(not(ios/android))`, keyring étendu iOS, deps iOS (`june-embed`, objc2), plugins os/clipboard | Garder les blocs target |
| `src-tauri/build.rs` | `rustc-link-lib=framework=AVFAudio` pour iOS | 3 lignes |
| `src-tauri/src/carpe_diem/sidecar.rs` | Backend embedded mobile (voir ci-dessus) | Réappliquer le split |
| `src-tauri/src/audio/capture.rs` | Hooks `ios_session` (configure/deactivate), branche permission iOS | 3 hooks |
| `src-tauri/src/commands.rs` | Rejet `MicrophonePlusSystem` sur mobile, readiness système « unsupported », commande `import_audio_note` | Additif |
| `src-tauri/src/domain/processing.rs` | Tail factorisé `persist_transcript_and_generate` + `process_imported_audio` (m4a/mp3 envoyés entiers au backend) ; langue via `providers::configured_transcription_language` | Réappliquer la factorisation |
| `src-tauri/src/providers/mod.rs` | `configured_transcription_language()` (shim desktop→dictation / mobile→None) | Additif |
| `src-tauri/src/db/repositories.rs` | `search_note_context` + `NoteContextSnippet` (retrieval agent-lite) | Additif |
| `src-tauri/src/june_api.rs` | `extract_chat_completion_text` passé `pub` ; retry transport unique dans `proxy_agent_chat_completions` (verrouillage d'écran iOS : la connexion tombe pendant la suspension, on soigne le sidecar et on rejoue le tour au réveil) | 1 ligne + le bloc retry |
| `june-api/Cargo.toml`, `crates/app/*` | Workspace + CLI mince sur `june-embed` | Réappliquer l'extraction |
| `june-api/crates/config/src/lib.rs` | `load_from_toml_str` + `validate_config` (config programmatique) | Additif |
| `src/main.tsx` | Choix du shell desktop/mobile + import `mobile.css` | 4 lignes |
| `src/app/App.tsx` | `recordingToStatus` extrait vers `src/lib/recording-status.ts` | 1 import |
| `src/components/studio/ImageStudio.tsx` | Logique queue/heavy extraite vers `src/lib/studio/generate-image.ts` | 1 import + 1 appel |
| `src/lib/studio/async-job.ts`, `media-notifications.ts` | Le poll/download/notify est passé côté Rust ; les hooks `useMediaJob`/`useMediaJobQueue` ne font plus qu'observer les lignes `media_jobs` (événement `june://media-job` + réconciliation `media_job_list` au montage) | Ne pas réintroduire un poll JS (ADR-0018) |
| `src/components/studio/{VideoStudio,MusicStudio,SoundFxStudio}.tsx`, `src/components/mobile/screens/StudioScreen.tsx` | Nouvelle signature des hooks (`kind` + `urlFields`, callback qui reçoit un `ArtifactFile` déjà écrit) ; les puces « Resume » ont disparu (Rust poll déjà tout) | Additif |
| `src/lib/tauri.ts` | Wrappers `importAudioNote`, `mobileDictation*`, `agentLiteRun` + types | Additif |
| `vite.config.ts` | `host: TAURI_DEV_HOST \|\| 127.0.0.1` (dev sur device) | 1 ligne |
| `src-tauri/capabilities/*.json` | `platforms` desktop ajoutés (sinon tauri-build iOS rejette `process:allow-restart`) ; permission clipboard | Garder `platforms` |
| `.gitignore` | `src-tauri/gen/` affiné : gen/apple committé, schemas/build ignorés | Garder |

**Ajouts iOS :**
| Fichier | Rôle |
|---|---|
| `june-api/crates/embed/` | Composition root partagée + `serve()` embarquable |
| `src-tauri/gen/apple/` | Projet Xcode (Info.plist : micro, `UIBackgroundModes` audio+processing+fetch, `BGTaskSchedulerPermittedIdentifiers` ; `BackgroundTasks.framework` lié dans `project.yml` **et** dans le `.pbxproj` committé) |
| `src-tauri/tauri.ios.conf.json` | 1 fenêtre, pas d'externalBin/resources/updater |
| `src-tauri/capabilities/mobile-main.json` | Capability du webview mobile (⚠️ `haptics:default` n'existe pas dans tauri-plugin-haptics — lister les `haptics:allow-*` explicites, sinon tous les invokes haptics sont refusés en silence) |
| `src-tauri/src/audio/ios_session.rs` | AVAudioSession (objc2) |
| `src-tauri/src/dictation_mobile.rs` | Dictée in-app (cpal→WAV→`/v1/dictate`+cleanup, historique partagé) |
| `src-tauri/src/agent_lite/mod.rs` | Boucle d'outils agent-lite (tient un `ios_background::BackgroundTask` pendant tout le tour ; `resume_interrupted_turns` rejoue les tours coupés, `TurnClaim` évite la double réponse) |
| `src-tauri/src/ios_background.rs` | Coordinateur d'arrière-plan iOS (objc2) : garde RAII **ref-comptée** sur un seul `beginBackgroundTaskWithName:`, enregistrement + soumission `BGTaskScheduler`, observateurs `didEnterBackground`/`willEnterForeground` ; no-op hors iOS |
| `src-tauri/src/background.rs` | Le sweep durable : notes, jobs média, dictées, tours de chat. Lancé au boot, au `Resumed` et depuis les handlers BGTaskScheduler. `has_pending_work()` décide si on demande une fenêtre à iOS |
| `src-tauri/src/carpe_diem/jobs.rs` | Runner durable des générations Studio (poll + download + notification côté Rust, table `media_jobs`) — la WebView ne fait plus que la mise en file et l'observation |
| `src-tauri/migrations/011_background_jobs.sql` | Tables `media_jobs` + `pending_dictations` |
| `src-tauri/src/carpe_diem/workflow_runs.rs` + `src-tauri/migrations/012_workflow_runs.sql` + `src/lib/studio/workflow-run.ts` (runner durable) | **Runs de workflow durables (ADR-0021)** : tables `workflow_runs`/`workflow_run_nodes` (graphe figé + coûts + état par node), commandes `workflow_run_*` (**2 listes `generate_handler!`**), notification de fin de production ; côté JS le runner crée la ligne avant d'exécuter, persiste chaque transition, route vidéo/musique vers `media_job_start` (`source: "workflow"`, pointeur `pendingJobId` sur la ligne du node), et la reprise réhydrate les sorties (références galerie) + se ré-attache aux jobs en vol ; `media_jobs` gagne la colonne `source` (les hooks Studio ignorent les rows workflow) |
| Sweep `resume_interrupted_processing` (`commands.rs`) | Au `Resumed` et au lancement : re-traite les notes en `failed` (`last_error LIKE '%error sending request%'`) **et** celles restées en `transcribing`/`generating` sans pipeline vivant (`domain::processing::is_processing`) ; s'appuie sur le heal request-side du sidecar |
| `src/lib/mobile.ts`, `src/lib/recording-status.ts`, `src/lib/studio/generate-image.ts` | Détection plateforme + helpers factorisés |
| `src/app/mobile/{MobileApp.tsx,nav.ts}` | Shell mobile (gates, état, navigation tabs+stack) |
| `src/components/mobile/**` | TabBar, StackHeader, écrans Notes/NoteDetail/Folders/Dictation/Agent/Studio/Settings |
| `src/styles/mobile.css` | Chrome mobile (safe areas, 44 pt, tab bar, chat, studio) |

**Résolu (2026-08-13, [ADR-0021](docs/adr/0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md))** :
les runs de workflow sont désormais des lignes durables (`workflow_runs` + une ligne par node,
migration 012) ; les rendus vidéo/musique passent par les `media_jobs` existants (tag
`source = "workflow"`, ignoré par les surfaces Studio), un node en attente enregistre son
job id, et la reprise (bannière sur les deux shells) rejoue les nodes finis depuis leurs
sorties déshydratées et se ré-attache aux rendus en vol — jamais de double achat. La couture
entre rendus reste WebView (lastFrame/assemble exigent WebKit, décision no-ffmpeg) : un run
interrompu reprend au premier plan suivant, exactement le contrat ADR-0018.

## Imports et résumés longs (2026-08-23)

Sub Rosa transforme désormais en note ce qu'il n'a **pas** enregistré : un fichier
déposé, un podcast, une conférence. Trois ADR portent les décisions —
[0026](docs/adr/0026-imported-media-is-decoded-in-process.md) (décodage),
[0027](docs/adr/0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)
(résumé long), [0028](docs/adr/0028-import-links-are-fetched-never-scraped.md)
(ingestion par lien) — et la section « Imports (fork) » de `CONTEXT.md` porte le
vocabulaire. **Aucune ligne n'a été écrite dans `june-api/`** : c'est délibéré
(ADR-0027), et c'est ce qui rend ce lot sans coût de re-merge côté backend.

### Fichiers ajoutés

| Fichier | Rôle |
|---|---|
| `src-tauri/src/audio/decode.rs` | Décodage in-process (Symphonia) d'un conteneur audio/vidéo vers le WAV 16 kHz mono que la transcription veut. En flux : la mémoire dépend du paquet, jamais de la durée. Un fichier vidéo est une piste audio qu'on lit et un conteneur qu'on saute |
| `src-tauri/src/longform/{mod,chunk,prompts}.rs`, `migrations/015_note_summaries.sql` | Le résumé long : découpage sur frontières de tours avec recouvrement, passes map/merge/short vers `/v1/chat/completions` **par le sidecar**, résolution des marqueurs `[t:N]` en horodatages *côté app*, ligne durable reprise partie par partie |
| `src-tauri/src/ingest/{mod,link,feed,fetch,vtt,extractor}.rs`, `migrations/016_ingests.sql` | L'ingestion par lien : classification pure d'une URL, lecture RSS/Atom, téléchargement borné (plafond sur ce qui arrive, pas sur `Content-Length`), lecture des sous-titres publiés, rail extracteur opt-in |
| `src/lib/{import-media,chapters}.ts` | Dépôt d'un fichier par tranches (aucun plafond de taille, sur les 2 shells) ; relecture des chapitres depuis les titres du résumé |
| `src/components/note-editor/NoteSummaryPanel.tsx`, `src/components/notes-list/ImportLinkBar.tsx`, `src/components/settings/ImportSettingsSection.tsx` | L'onglet Summary (invitation chiffrée, progression, chapitres, copie), la barre de lien (prévisualisation hors ligne + téléchargements en cours), le réglage du rail extracteur |
| `src-tauri/tests/{media_decode,shared_commands}.rs`, `src-tauri/tests/fixtures/media/` | 4 tests de décodage sur de vraies fixtures MP3/AAC/H.264 (~35 ko) + **le garde de parité des deux `generate_handler!`** |
| `src/test/{import-media,note-summary-panel,import-link-bar,chapters}.test.ts(x)` | 37 tests front |

### Fichiers upstream modifiés

| Fichier(s) | Raison | Re-merge |
|---|---|---|
| `src-tauri/src/audio/turns.rs` | `normalize_wav_for_transcription` **réécrit en flux** (il chargeait tout l'enregistrement en `Vec<i16>` avant même de décider qu'il n'avait rien à faire) ; ajout de `LinearResampler` (rééchantillonnage incrémental, épinglé contre l'ancien oracle whole-buffer), `TranscriptionWavWriter`, `split_wav_for_transcription_with_limit`, `MAX_IMPORT_CHUNK_MS` | Garder la version fork : elle lève un plafond de durée réel. L'ancien `resample_linear` vit maintenant dans le module de test comme oracle |
| `src-tauri/src/domain/processing.rs` | `process_imported_audio` décode d'abord et ne retombe sur l'envoi du fichier entier que si Symphonia ne sait pas le lire ; `PreparedWavRun`/`transcribe_prepared_wav_and_generate` extraits pour partager le chemin ; `process_captioned_import` (sous-titres au lieu de transcription) ; `persist_generation_for_transcript` extrait ; `is_wav_path` | Réappliquer ; le découpage en helpers est la partie à garder |
| `src-tauri/src/commands.rs` | `IMPORTABLE_AUDIO_EXTENSIONS` élargi (vidéo incluse), `stage_imported_file`/`discard_staged_import` (dépôt par tranches), variante `staged_path`, `import_media_from_path[_with_captions]` extraits, **`retry_processing` route les imports compressés vers `process_imported_audio`** (un réessai les envoyait à un lecteur WAV : cassé depuis toujours) | Le fix de `retry_processing` est un correctif de bug, pas une préférence |
| `src-tauri/src/lib.rs` | 12 commandes dans les **deux** `generate_handler!` (2 desktop-only : le rail extracteur) ; `pub mod {ingest,longform}` ; suppression d'un doublon préexistant `commands::delete_agent_task` | `tests/shared_commands.rs` refuse maintenant toute dérive entre les deux listes |
| `src-tauri/src/background.rs` | Deux entrées de balayage : résumés longs inachevés, téléchargements inachevés | Additif |
| `src-tauri/src/db/repositories.rs` | Méthodes `note_summary*`/`ingest*`, `set_audio_artifact_duration`, et **`search_note_context` couvre les résumés** (sans ça le meilleur contenu de l'app serait le seul que la recherche ne trouve pas) | Additif |
| `src-tauri/src/agent_lite/mod.rs` | Outils `summarize_note` + `import_link` (ils *démarrent* un travail et le disent), `read_note` transmet le résumé long, prompt système étendu | Additif |
| `src-tauri/src/actions.rs`, `src/lib/chat-blocks.ts`, `src/components/chat-blocks/ProposalCard.tsx`, `src-tauri/src/hermes_bridge.rs` | Deux nouvelles actions proposées (`summarize`, `importLink`) : c'est la parité desktop, et c'est le bon garde-fou puisque les deux dépensent de l'argent | Une branche par fichier, comme le dit la doc d'`actions.rs` |
| `src-tauri/src/hermes/june_context_mcp.py` | `get_note` renvoie `longFormSummary` (lecture défensive : la colonne n'existe pas sur une base antérieure) | Additif |
| `src/components/note-editor/NoteEditor.tsx` | 3ᵉ onglet « Summary » (offert seulement s'il y a un transcript), saut de chapitre vers le tour du transcript, `data-turn-id` | Réappliquer |
| `src/components/notes-list/NotesList.tsx`, `src/app/App.tsx`, `src/app/mobile/MobileApp.tsx`, `src/components/mobile/screens/NotesScreen.tsx` | Zone de dépôt + bouton Import + `headerAccessory` (la barre de lien est passée en `ReactNode` : `NotesList` doit rester présentationnel), destination `import`, sélecteur mobile élargi à la vidéo | Réappliquer |
| `src/lib/destinations.ts` | Destination `subrosa://import?url=…`, validée deux fois | Additif |
| `src-tauri/Cargo.toml` | `symphonia` 0.5.5, `quick-xml` 0.39 (déjà transitif), feature `process` de tokio **par cible desktop** | Garder le ciblage : iOS ne doit pas embarquer de machinerie de sous-processus |
| `src/test/setup.ts` | Polyfill `Blob.arrayBuffer` (jsdom ne l'a pas ; tous les moteurs de l'app l'ont depuis 2019) | Additif |
| `THIRD_PARTY_NOTICES.md` | Symphonia (MPL-2.0) | Obligatoire |

### Pièges

- **Opus et HE-AAC ne sont pas décodables** (Symphonia ne les implémente pas), et
  Opus est le codec audio par défaut de YouTube. C'est pour ça que le rail
  extracteur **sélectionne** un flux m4a/mp3 (`-f bestaudio[ext=m4a]/…`) au
  lieu de demander une conversion `-x --audio-format`, qui exigerait un ffmpeg
  que l'app n'embarque pas. Ne pas prétendre le contraire :
  un fichier indécodable retombe sur l'envoi entier, et le dit par son nom.
- **Le modèle ne produit jamais d'horodatage.** Il rend un marqueur `[t:N]`
  qu'on lui a donné, et l'app résout N en `start_ms`. Un marqueur hors plage
  est borné, pas cru.
- **Une reprise ne rachète pas les parties déjà payées** (`parts_json`), et ne
  les réutilise que si `chunk_count` correspond encore — une note
  re-transcrite se découpe autrement.
- **Supprimer la ligne, c'est annuler** : le résumé long comme le
  téléchargement vérifient l'existence de leur ligne entre deux étapes.
- **Aucun téléchargeur n'est embarqué.** Le rail extracteur cherche un
  `yt-dlp` que l'utilisateur a installé, et seulement si le réglage est activé.
- **Le sidecar embarqué n'est reconstruit par aucun flux local.**
  `scripts/build-sidecar.mjs` n'est appelé que par `release.yml` ; `pnpm
  tauri:dev` lance l'app contre le binaire déjà présent dans
  `src-tauri/binaries/` (gitignoré). Un correctif dans `june-api/` peut donc
  être écrit, testé, mergé — et rester **sans effet dans l'app qui tourne**.
  C'est ce qui a fait qu'un modèle gratuit (`stealth-ox-alpha`, `inputPrice: 0`)
  est resté invisible dans le sélecteur desktop bien après le correctif de prix.
  `make sidecar` reconstruit, `make sidecar-check` avertit, et `pnpm tauri:dev`
  lance l'avertissement au démarrage (sans bloquer).
- **`ProposedAction` a besoin de `rename_all_fields`, pas seulement de
  `rename_all`.** Le premier renomme les *variantes*, le second les champs
  qu'elles contiennent. Il manquait, et le type `note` était donc cassé depuis
  le jour de sa livraison : la carte écrit `noteId`, Rust attendait `note_id`,
  et taper la carte échouait à la frontière IPC. `reminder` et `event` n'étaient
  épargnés que parce que tous leurs champs sont des mots simples. Les
  *arguments* de commande, eux, sont convertis par Tauri (`ArgumentCase::Camel`)
  — le piège ne concerne que les corps désérialisés par serde.
- **Une note créée par une tâche de fond n'apparaît pas toute seule.** La liste
  ne se recharge que sur action explicite, d'où le `onCompleted` de
  `ImportLinkBar`. Toute future création de note hors UI a le même besoin.
- **L'extension de partage iOS n'existe pas** : la destination
  `subrosa://import?url=…` est le contrat qu'elle utiliserait, et elle est déjà
  utilisable via Raccourcis. Ajouter la cible demande un second bundle id et un
  second profil dans `ios-release.yml` — chantier Xcode à part.

## Le conseil (2026-08-28)

Plusieurs modèles lisent une demande **en aveugle**, chacun sur une famille de
poids différente, et la présidence (l'app) en tire un **mandat** : des cases
plafonnées dont le centre est une liste de **critères d'acceptation**, chacun
nommant comment il se vérifie. Un seul agent l'exécute. Le conseil relit
ensuite le travail contre ce même mandat et rend un **verdict**, critère par
critère, avec les preuves.

Décision et alternatives rejetées :
[ADR-0034](docs/adr/0034-the-council-issues-a-verifiable-mandate.md).
Vocabulaire : la section « The council (fork) » de [CONTEXT.md](CONTEXT.md).

### Fichiers ajoutés

| Fichier | Rôle |
| --- | --- |
| `src-tauri/migrations/019_council.sql` | `council_mandates`, `council_turns` (unité de reprise), `council_verdicts` (un par tour) |
| `src-tauri/src/council/mod.rs` | racine : plan chiffré, convocation, situation du terrain, commandes, reprise |
| `src-tauri/src/council/seats.rs` | rosters intégrés, `model_family`, attribution un modèle par famille |
| `src-tauri/src/council/prompts.rs` | tous les prompts + `COUNCIL_PROMPT_VERSION` |
| `src-tauri/src/council/mandate.rs` | plafonds, validation, **rendu déterministe** du prompt et de la reprise |
| `src-tauri/src/council/merge.rs` | routage sans appel modèle : intersection des questions, détection de dissensus |
| `src-tauri/src/council/parse.rs` | extraction du premier objet JSON équilibré |
| `src-tauri/src/council/deliberate.rs` | la séance : aveugle → questions → second tour → présidence → objection |
| `src-tauri/src/council/evidence.rs` | ce que le verdict a le droit de lire (diff git, sinon mtime) |
| `src-tauri/src/council/verdict.rs` | trois lentilles, réconciliation mécanique, résumé |
| `src/lib/council.ts` | types, bindings, estimation de coût par appel |
| `src/components/agent/council/` | `CouncilSitting`, `MandateEditor`, `VerdictPanel` |
| `src/components/settings/CouncilSettingsSection.tsx` | Réglages › Conseil |
| `src/styles/council.css` | styles (importé par `main.tsx`) |

### Fichiers upstream modifiés

| Fichier | Modification |
| --- | --- |
| `src-tauri/src/lib.rs` | `#[cfg(desktop)] pub mod council` + 13 commandes dans la **seule** liste desktop |
| `src-tauri/src/background.rs` | `council::resume_unfinished` et `council::verdict::resume_unfinished` dans le sweep |
| `src-tauri/src/db/migrations.rs` | enregistrement de `019_council.sql` |
| `src-tauri/src/db/repositories.rs` | bloc `impl Repositories` + 3 mappeurs de ligne |
| `src-tauri/src/domain/types.rs` | DTO du conseil (compilés sur les deux plateformes, pilotés seulement sur desktop) |
| `src-tauri/tests/shared_commands.rs` | préfixe `council::` déclaré platform-specific |
| `src/components/agent/AgentWorkspace.tsx` | `/council`, la séance dans la région principale, le verdict au tour terminal |
| `src/lib/agent-composer-slash-commands.ts` | commande `/council` (**et** la garde `isBuiltinComposerSlashCommandName`) |
| `src/components/settings/AppSettings.tsx`, `src/components/sidebar/Sidebar.tsx` | onglet Conseil dans les **deux** endroits |

### Pièges

- **Desktop uniquement.** Pas de Hermes sur iOS, donc rien à qui remettre un
  mandat. `council::` est déclaré dans `tests/shared_commands.rs` ; c'est le
  seul endroit autorisé à le dire.
- **L'app possède le prompt.** Les sièges remplissent des champs,
  `mandate::render` fabrique la chaîne. Ne jamais demander la chaîne finale à
  un modèle, ni pour le mandat ni pour une reprise (une paraphrase de verdict
  l'adoucit).
- **Un siège parle au plus deux fois.** Une fois en aveugle, puis soit pour
  absorber les réponses de l'utilisateur, soit pour affronter la table, jamais
  les deux. C'est cet invariant qui borne la facture (5 à 9 appels).
- **Le routage ne s'achète pas.** Quelles questions atteignent l'utilisateur et
  qui reprend la parole sont calculés dans `merge.rs`, sans appel modèle.
- **Le verdict ne tourne pas sur les poids de l'auteur** (`session_model` est
  enregistré à la remise, exprès) et **diffe contre `base_commit`**, capturé au
  même moment : sans lui, un travail commité est invisible.
- **Une pause n'est pas une fin.** Le tour terminal propose le verdict ; une
  offre déclinée est mémorisée par tour, sinon chaque pause de l'agent rouvre
  le panneau.
- Ajouter une commande partagée oblige à toucher les **deux**
  `generate_handler!` ; celles-ci sont desktop-only et n'en touchent qu'une.
- **Choisir le modèle d'un siège** : `council/seat_models.rs` (`council.json`,
  miroir en mémoire comme `memory.json`, donc lisible sans `AppHandle` depuis
  `build_roster`). Un choix est **par siège et optionnel** ; les sièges libres
  restent attribués automatiquement. `assign_models` reçoit
  `held_families` pour ne pas redonner une famille qu'un siège épinglé occupe
  déjà. Deux règles survivent à l'utilisateur : un modèle absent du catalogue
  est ignoré (sinon la séance meurt au premier appel), et un juge n'est
  **jamais** mis sur les poids de l'auteur (ADR-0034) — le choix est écarté
  pour cette séance-là, pas supprimé. `reusedByChoice` dit laquelle des deux
  raisons explique un doublon de famille : accuser le catalogue d'un choix de
  l'utilisateur serait faux.
- **`submitHermesSession` rend l'id de session sur le chemin de succès.** Il
  ne le rendait que sur `skipPrompt` (`/image`) ; tout envoi réussi résolvait
  `undefined`. Le seul appelant qui lit cette valeur est la remise du conseil,
  qui en concluait « session could not be started », laissait la séance ouverte
  sur une erreur et **n'appelait jamais `councilBindSession`** — donc le
  verdict n'avait plus rien pour retrouver le travail. Livré cassé en v1.50.0,
  corrigé en v1.52.0. `council-sitting.test.tsx` ne pouvait pas le voir : il
  passe au composant un `onHandOff` mocké qui retourne un id, précisément ce
  qui était faux. Test : `binds the session the mandate was handed to`.
- **Le verdict lit la réponse quand le travail n'a pas touché de fichier.**
  `evidence.rs::from_reply` (kind `reply`) : toutes les demandes ne produisent
  pas de fichiers, et un verdict sans preuve dépensait 3 appels pour écrire
  « unverifiable » une fois par critère. Le transcript vit dans le runtime,
  donc **le shell passe la réponse** (`councilRequestVerdict(id, reply)`,
  prop `readReply` injectée comme le fetcher de `SessionUsagePanel`) et Rust la
  **stocke** (colonne `council_verdicts.reply` via `ensure_column`) — un
  verdict re-piloté après relance doit encore tenir ce qu'il juge (ADR-0018).
  ⚠️ `ensure_column` doit venir **après** les blocs qui créent les tables,
  sinon `run_migrations` panique au lancement. Le dossier de travail reste
  prioritaire : un diff est ce qu'un système de fichiers a observé, la réponse
  est ce que l'agent dit de lui-même — et l'arme `reply` du prompt trace
  explicitement la limite (le texte est le livrable, pas la preuve de ce qu'il
  prétend avoir fait ailleurs).
- **Sans dossier, on ne demande pas l'invérifiable.** `blind_user_message`
  dit aux sièges d'écrire des critères réglables en lisant la réponse. La
  carte de proposition le dit aussi (« No working folder ») **avant** de
  dépenser, et `request` refuse tôt quand il n'y a ni dossier ni réponse.
- **Un siège vide est rejoué une fois** (`completion` → `completion_once`).
  Seule la réponse vide est rejouée : un refus ou un 500 est l'opérateur qui
  parle. Ce n'est pas un siège qui parle deux fois (la borne de l'ADR-0034) —
  un siège qui n'a rien rendu n'a pas parlé. L'appel supplémentaire est
  **annoncé sur la carte** au lieu de gonfler l'estimation.
- **L'objection est visible.** `council_drafts` renvoie aussi
  `PHASE_OBJECTION`, `wasContested()` en dérive, et la vue du mandat dit
  « Nobody attacked this mandate » **là où on décide de le remettre**.
- **Une session ramène à son conseil.** `councilCycleForSession` existait et
  n'était appelé par **aucune** UI ; le bandeau de reprise excluait pourtant
  les séances `executing` au motif qu'« elles sont joignables par leur
  session », ce qui n'était vrai de rien. Un second bandeau, porté par la
  session sélectionnée, ouvre la séance — et `CouncilSitting` affiche
  désormais le mandat **en lecture seule** pour `executing|reviewing|settled`,
  sinon on revenait sur une page sans la seule chose qu'on venait y chercher.
  Le mandat n'est jamais éditable après remise : changer ce contre quoi le
  travail est jugé une fois le travail commencé viderait le verdict de sens.
- **Une séance survit à l'écran qui la portait.** Le mandat est une ligne
  durable, `councilRequest` est un état React : un relancement laissait une
  séance déjà payée (9 appels modèle) vivante en base et injoignable, et
  `/council` n'ouvrait jamais que la suivante. Le workspace cherche donc au
  montage une séance `deliberating|questions|ready` (`isUnfinished`) et
  **propose** de la rouvrir dans un bandeau — jamais ne l'impose : atterrir
  dans un conseil qu'on a quitté exprès est aussi faux que le perdre.
  `/council` sans argument reprend au lieu de gronder. Rouvrir passe le
  `mandateId`, donc lit le cycle existant au lieu de replanifier (et de
  facturer deux fois). ⚠️ Le X **à l'intérieur** de la séance reste un
  `councilForget` : il supprime la ligne, c'est l'annulation ; le X du bandeau
  ne fait que masquer l'offre.
- **La séance met fin au hero.** `detailContent` (donc `CouncilSitting`) n'est
  rendu que dans la branche non-hero d'`AgentWorkspace` ; `heroMode` doit donc
  inclure `!councilRequest`. Sans ça, `/council` sur une session neuve vidait
  le composer et ne changeait rien à l'écran — et un conseil se convoque
  justement avant que le travail commence, donc toujours sur une session
  neuve. Livré cassé en v1.50.0, corrigé en v1.51.0 ; le test de
  non-régression est `puts a new request to the council instead of doing
  nothing` dans `agent-workspace.test.tsx`. `council-sitting.test.tsx` teste
  le composant isolé et ne pouvait pas voir ce trajet.

## L'agent desktop écrit des notes (2026-08-28)

Deux corrections d'un même symptôme : **ce que l'app dit avoir, elle l'a
vraiment**.

**L'agent desktop peut écrire une note.** Son seul outillage local, le MCP
`june_context`, ne savait que lire ; à qui lui demandait « fais-en une note »,
il écrivait un `.md` dans son workspace Hermes et tentait AppleScript vers
Notes.app. Le MCP déclare désormais `create_note` / `append_to_note` et les
fait exécuter **par l'app** via le proxy local (`POST /v1/notes/{create,append}`),
jamais par Python : la base est ouverte `mode=ro` là-bas, exprès. Décision et
alternatives rejetées :
[ADR-0035](docs/adr/0035-the-desktop-agent-writes-notes-through-the-app.md).

**Le panneau Usage ne perd plus ses compteurs.** Hermes garde les compteurs
d'une session en mémoire sur son agent et en reconstruit un à chaque
rechargement : `session.usage` répond alors le modèle et une rangée de zéros
(`tui_gateway/server.py`, `_get_usage`). Le garde-fou existant cherchait un
objet **vide**, que le runtime ne renvoie jamais, donc les zéros passaient pour
une lecture et écrasaient les vrais chiffres.

### Fichiers ajoutés

| Fichier | Rôle |
| --- | --- |
| `src-tauri/src/agent_notes.rs` | le seul endroit où un assistant écrit une note, sur les deux shells : bornes, `create` / `append`, `june://notes-changed` + réindexation Spotlight |
| `docs/adr/0035-…md` | pourquoi l'écriture passe par le proxy et jamais par Python |

### Fichiers upstream modifiés

| Fichier | Modification |
| --- | --- |
| `src-tauri/src/hermes/june_context_mcp.py` | `WRITE_TOOLS` (annoncés seulement avec les coordonnées du proxy) + `create_note` / `append_to_note` qui appellent `call_proxy` |
| `src-tauri/src/hermes_bridge.rs` | routes `/v1/notes/create` et `/v1/notes/append`, `NoteWriteBody`, et le paragraphe « Writing a note » de `JUNE_SOUL_CONTEXT_MD` |
| `src-tauri/src/agent_lite/mod.rs` | les deux outils passent par `crate::agent_notes` (la logique d'append dupliquée est supprimée) |
| `src-tauri/src/lib.rs` | `pub mod agent_notes` |
| `src/lib/hermes-session-usage.ts` | `apiCalls`, `hasAnyReading` refait, mémoire des dernières lectures par session |
| `src/components/agent/SessionUsagePanel.tsx` | repli sur la lecture mémorisée, compteurs inconnus rendus « Unavailable » |
| `src/lib/tauri.ts`, `src/app/mobile/MobileApp.tsx` | `AGENT_LITE_NOTES_CHANGED_EVENT` → `NOTES_CHANGED_EVENT` (`june://notes-changed`) |
| `src/app/App.tsx` | écoute `NOTES_CHANGED_EVENT` et rafraîchit la liste (`refreshNotesList`, jusque-là mort) |

### Pièges

- **Ne jamais écrire dans le SQLite depuis Python.** `connect_readonly` est un
  contrat, pas une commodité. Tout nouvel outil d'écriture suit le chemin de
  l'ADR-0035 : déclaré dans le MCP, routé par le proxy, implémenté une fois en
  Rust.
- **La clé est `noteId`, en camelCase.** `crate::actions` a déjà livré ce bug
  exact une fois. `note_write_reads_the_key_the_mcp_actually_sends` épingle les
  deux côtés ; ne pas le contourner en lisant le JSON champ par champ.
- **Les outils seuls ne suffisent pas.** Sans le paragraphe du SOUL, un modèle
  qui voit un système de fichiers écrit dans le système de fichiers. Le test
  `june_soul_sends_a_written_note_to_the_app_rather_than_the_workspace` garde
  la phrase, y compris le « never write a note the user did not ask for ».
- **Une note écrite est une note**, pas une *meeting note* : celle-ci naît d'un
  enregistrement transcrit. Voir CONTEXT.md.
- **Le compteur qui compte est `calls`.** Un agent frais annonce son modèle
  avec des compteurs à zéro ; ne jamais traiter la présence de `model` comme la
  preuve d'une lecture. Les zéros ne s'affichent pas non plus : un compteur
  inconnu est « Unavailable », pas « 0 ».
- **Les dernières lectures vivent dans un `Map` de module** (`hermes-session-usage.ts`),
  donc elles survivent à un composant et à un test : `forgetReadings()` dans un
  `beforeEach`.
- L'éditeur ouvert sur une note que l'agent complète ne se recharge pas ; seule
  la liste le fait. Connu, non résolu.

## Les rapports deviennent des issues GitHub (2026-08-28)

Le sink upstream vise le tracker os-platform de June via une clé de bot tenue
par le backend hébergé. Ce fork n'a ni backend hébergé ni clé, donc
`june-api/config.toml` laisse la destination vide, le sidecar construit son
`LogIssueReportSink`, et **chaque rapport jamais envoyé est devenu une ligne de
`june-api.log`** pendant que l'app affichait « Your report was sent to the Sub
Rosa team ». C'est la phrase qui était le bug.

Les rapports ouvrent désormais des issues sur `Irdanwen/sub-rosa`, avec une
**identité que l'utilisateur possède** : token GitHub dans le trousseau (l'app
dépose l'issue et rend son URL), sinon le formulaire GitHub pré-rempli dans le
navigateur (l'utilisateur valide). Décision et alternatives rejetées :
[ADR-0036](docs/adr/0036-reports-are-github-issues-filed-with-the-users-own-credential.md).

### Fichiers ajoutés

| Fichier | Rôle |
| --- | --- |
| `src-tauri/src/carpe_diem/issue_reports.rs` | destination : token (trousseau + import depuis le CLI `gh`), découpage `Issue N:`, corps, POST GitHub, URL pré-remplie, `Delivery` |
| `src/lib/issue-report-outcome.ts` | la phrase montrée, dérivée de ce qui s'est réellement passé |
| `src/components/settings/ReportsSettingsSection.tsx` | Réglages › Reports |
| `docs/adr/0036-…md` | pourquoi c'est le token de l'utilisateur et pas une clé embarquée |

### Fichiers upstream modifiés

| Fichier | Modification |
| --- | --- |
| `src-tauri/src/commands.rs` | `submit_issue_report` passe par `carpe_diem::issue_reports::deliver` et renvoie le `Delivery` |
| `src-tauri/src/domain/types.rs` | `SubmitIssueReportResponse.delivery` (optionnel, rétrocompatible) |
| `src-tauri/src/lib.rs` | 5 commandes `issue_reports_*` dans les **deux** listes |
| `src/components/agent/AgentWorkspace.tsx` | la notice vient de `issueReportOutcomeMessage`, plus d'une phrase fixe |
| `src/components/settings/AppSettings.tsx`, `src/components/sidebar/Sidebar.tsx` | onglet Reports dans les **deux** endroits |
| `src/lib/tauri.ts` | `IssueReportDelivery`, `IssueReportSettingsDto`, bindings |

### Pièges

- **Jamais de token dans le binaire.** Le repo source et les builds sont
  publics. C'est la raison d'être de tout le module ; ne pas « simplifier » en
  embarquant une clé de bot, ni en ajoutant un relais (ADR-0017).
- **Le chemin navigateur n'est pas un envoi.** Rien n'existe sur le tracker
  tant que l'utilisateur n'a pas cliqué Submit. `issue-report-outcome.test.ts`
  interdit explicitement le mot « sent » dans cette branche.
- **Un échec avec token ne déclenche pas le navigateur.** Un souci réseau n'est
  pas une raison d'ouvrir une fenêtre à quelqu'un ; ça retombe sur le journal
  local, et l'UI le dit.
- **Les pièces jointes sont nommées, jamais téléversées** : l'API REST GitHub
  ne sait pas attacher un fichier à une issue. Ne pas laisser la copie
  suggérer le contraire.
- **`open_external_url` n'est pas le bon chemin** pour l'URL pré-remplie : il
  plafonne à 2 Ko parce qu'il garde des URL écrites par un modèle. Celle-ci est
  composée par l'app, vers un hôte constant.
- **Le corps navigateur est coupé à ~5 000 caractères** et le dit dans le
  texte. Le chemin token porte le rapport entier.
- **Un en-tête `Issue N:` est un titre**, qu'il y en ait un ou six : le prompt
  le dit explicitement. Un seul en-tête titre l'issue (ne pas « simplifier »
  en `sections.len() < 2` → titre depuis la description : ça jette le titre
  rédigé dans le cas le plus courant). Sans aucun en-tête, la première ligne
  de l'utilisateur fait le titre. Un en-tête sans contenu n'est pas une issue,
  et un en-tête devenu titre ne se répète pas dans le corps.

## Écrire une note, et la faire réécrire (2026-09-01)

L'éditeur de note était un TipTap avec trois boutons, posé sur un convertisseur
markdown de 90 lignes qui **supprimait silencieusement tout ce qu'il ne
connaissait pas au `blur`** : chaque niveau de titre retombait en H1, et les
listes numérotées, imbriquées, les citations, le code, les filets, les liens et
le barré — tous déjà dans le schéma StarterKit — disparaissaient dès que le
curseur quittait l'éditeur. Le bug était invisible parce que la barre ne savait
produire que trois des cinq choses que le convertisseur connaissait.

Trois décisions, trois ADR :
[ADR-0037](docs/adr/0037-the-note-body-round-trips-through-a-document-not-the-dom.md)
(le convertisseur sérialise le **document**, pas le DOM rendu, et il échappe),
[ADR-0038](docs/adr/0038-a-note-rewrite-is-proposed-never-applied.md) (une
réécriture est **proposée**, jamais appliquée), et le vocabulaire dans la
section « Writing a note (fork) » de [CONTEXT.md](CONTEXT.md).

### Fichiers ajoutés

| Fichier | Rôle |
| --- | --- |
| `src/lib/note-markdown.ts` | markdown ⇄ ProseMirror : sérialise le document, échappe à trois niveaux, six normalisations nommées |
| `src/components/note-editor/extensions.ts` | le vocabulaire d'édition en un seul endroit — l'éditeur **et** le test en dérivent leur schéma |
| `src/components/note-editor/SelectionToolbar.tsx` | la barre flottante (titres · listes · marques · lien · IA), forme ancrée sur mobile |
| `src/components/note-editor/blockPalette.ts`, `BlockPaletteList.tsx` | la palette `/` (desktop seulement), sur le popover du composer |
| `src/components/note-editor/useAnchoredPanel.ts` | mesure, calage aux bords, bascule sous la sélection quand il n'y a pas la place au-dessus |
| `src/components/note-editor/RewritePanel.tsx` | la **révision** : ce que le modèle propose, tant que personne n'a cliqué |
| `src/lib/note-rewrite.ts` | le hook qui pilote un run (deltas, annulation, erreurs) et **n'écrit rien** |
| `src-tauri/src/note_ai/` | `mod.rs` + `prompts.rs` : sept réécritures, streaming, annulation, bornes |
| `note-lab.html`, `src/dev/note-lab.tsx` | banc d'essai : monte l'éditeur seul, sans sidecar, avec un faux pont Tauri. **Pas une entrée de build** (`vite.config.ts` liste 4 HTML, celui-ci n'y est pas) |
| `src/test/note-markdown.test.ts` | la propriété : un document survit à l'aller-retour (corpus + 1000 docs générés) |
| `src/test/note-{preview,toolbar,rewrite}.test.tsx` | le câblage, la surface d'écriture, la révision |

### Fichiers upstream modifiés

| Fichier | Modification |
| --- | --- |
| `src/components/note-editor/NotePreview.tsx` | passe par `note-markdown` et `noteEditorExtensions`, porte la barre, la palette et le panneau ; l'ancien convertisseur est supprimé |
| `src-tauri/src/lib.rs` | `note_ai` + `note_rewrite` / `cancel_note_rewrite` dans les **deux** listes |
| `src/lib/tauri.ts` | `NOTE_REWRITE_EVENT`, `RewriteKind`, `noteRewrite`, `cancelNoteRewrite`, `MAX_REWRITE_CHARS` |
| `src/styles/app.css` | hiérarchie des titres, listes numérotées, cases à cocher, surlignage, citation, code, filet, liens ; barre, palette, menu, panneau |
| `src/styles/tokens.css` | `--note-highlight` (clair + sombre) |
| `package.json` | `@tiptap/extension-highlight`, `@tiptap/extension-list` (épinglés en 3.27.1 comme le reste) |

### Pièges

- **Le fichier d'abord, la surface ensuite.** Tout contrôle ajouté à la barre
  doit être écrivable par `docToMarkdown` avant d'exister. C'est pour ça que
  `underline` est **désactivé** dans StarterKit : markdown n'a pas de souligné,
  et une marque que l'éditeur accepte et que le fichier ne peut pas écrire est
  exactement le bug qu'ADR-0037 supprime.
- **Le test dérive son schéma de `noteSchemaExtensions()`**, pas d'une liste
  recopiée. Un convertisseur testé contre un schéma qui a dérivé ne prouve
  rien, et ce qu'il raterait est une perte de données silencieuse.
- **Aucune emphase n'est partagée entre deux nœuds de texte** dans le
  sérialiseur. Partager produit des séquences asymétriques (`***x*y**`) que
  seule la pile de délimiteurs complète de CommonMark sait relire. Ne pas
  « optimiser » ça.
- **`isAllowedUri`, jamais `protocols`.** L'option `protocols` *enregistre* des
  schémas auprès de linkify, elle n'en restreint aucun : la lister avec
  http/https/mailto ne filtre rien et fait avertir linkify. Une note contient
  du texte écrit par un modèle et des transcriptions ; `javascript:` n'a rien à
  faire dans un lien cliquable.
- **Une révision ne remplace jamais du texte que le modèle n'a pas vu.** La
  plage peut s'élargir jusqu'au bloc (ou à l'élément de liste s'il ne contient
  rien d'autre), jamais jusqu'à la liste entière : les puces voisines n'ont pas
  été envoyées.
- **La plage suit les modifications concurrentes.** Le panneau ne verrouille
  pas l'éditeur : sans `transaction.mapping`, taper pendant la réécriture puis
  accepter écrase le mauvais texte. Le test le prouve — vérifier qu'il **échoue**
  si on retire le suivi avant de toucher à cette zone.
- **Un champ de la barre qui prend le focus blure l'éditeur.** La barre doit
  rester montée tant qu'elle possède un champ ouvert (`onFieldOpenChange`),
  sinon elle disparaît sous les doigts. Vaut pour le lien, la langue cible et
  l'instruction libre.
- **La palette `/` est desktop seulement**, et c'est une décision : elle
  s'ancre au curseur, et sur un téléphone le curseur est juste au-dessus du
  clavier. La barre ancrée offre les mêmes blocs.
- **`note_ai` ne touche pas à `june-api/`** (ADR-0027). Les prompts sont le
  produit ; c'est eux qu'on change quand une réécriture déçoit.
- **Une seule réécriture peut changer la structure** : `restructure`. Un test
  vérifie que la dérogation n'apparaît que dans ce prompt.

## Interroger ses notes (2026-09-04)

Une question posée dans la palette ⌘K (ou sous la recherche du téléphone)
reçoit une réponse tirée des notes, chaque affirmation citant sa note, et la
liste exacte des passages envoyés sous la réponse
([ADR-0044](docs/adr/0044-an-answer-over-the-notes-cites-passages-the-app-chose.md)).

### Fichiers ajoutés

- `src-tauri/src/ask/mod.rs` : la commande `ask_notes` (retrieval FTS5 via
  `search_note_context`, prompt versionné `ASK_PROMPT_VERSION`, résolution
  des `[n]` en notes, indices inventés nommés). Rien dans `june-api/`.
- `src/components/ask/AskNotesPanel.tsx` : le panneau (réponse, citations
  cliquables, « What was sent »), `looksLikeAQuestion`, `answerParts`.
- `src/test/ask-notes-panel.test.tsx`.

### Fichiers upstream modifiés

- `src-tauri/src/lib.rs` : `pub mod ask` + `ask::ask_notes` dans les deux
  `generate_handler!`.
- `src-tauri/src/june_api.rs` : `record_egress` lit
  `egress_ledger::current_context()` (purpose + note_id du scope).
- `src-tauri/src/egress_ledger.rs` (fork) : `scoped` / `current_context`
  (task-local tokio).
- `src/components/sidebar/Sidebar.tsx` : groupe « Ask » en tête de la
  palette quand la requête se lit comme une question ; overlay portail
  `.ask-overlay` qui survit à la fermeture de la palette.
- `src/lib/tauri.ts` : `askNotes`, `AskAnswerDto`, `AskSourceDto`.
- `src/styles/app.css` (`.ask-*`), `src/styles/mobile.css`
  (`.mobile-ask*`), `src/components/mobile/screens/NotesScreen.tsx`
  (bouton « Ask your notes »).

### Pièges

- Le modèle ne choisit jamais les passages ni ne donne de timestamp : il
  numérote, l'app résout (même discipline qu'ADR-0027).
- Une ligne du registre ne porte qu'un `note_id` : il n'est renseigné que si
  tous les passages venaient de la même note ; la liste « What was sent »
  est la vérité par requête.

## Démarrage mesuré, registre de schéma, chunks (2026-09-04)

- `src-tauri/src/diagnostics.rs` : `mark(label)` / `startup_marks()` ; jalons
  `run` (lib.rs), `database open` et `migrations` (db/migrations.rs),
  `sidecar setup` (lib.rs). Ils sortent dans le log et dans le rapport de
  diagnostic (« ## Startup »).
- `src-tauri/src/db/migrations.rs` : table `schema_migrations` (nom, checksum
  SHA-256 du fichier, date). `replay` / `replay_statements` sautent un fichier
  déjà enregistré avec le même checksum ; les `ensure_column` continuent de
  tourner à chaque lancement. Test : deux passes, la seconde ne rejoue rien.
- `src-tauri/src/db/repositories/passages.rs` : module enfant de
  `repositories` (accès à `pool`), pour que le fichier du store ne grossisse
  plus (cliquet de taille).
- `src/main.tsx` : les deux shells sont chargés paresseusement (chunks
  séparés) ; `src/app/lazy-views.tsx` : Réglages et Studio à la demande ;
  `src/components/studio/studio-keys.ts` : les clés de stockage du Studio
  sorties de la vue pour que le shell ne l'importe plus statiquement ;
  `vite.config.ts` : `manualChunks` `editor` / `motion` / `flow` / `react`.

## Clavier et focus des surfaces modales (2026-09-04)

- `src/lib/modal-focus.ts` : `useModalFocus(ref, { open, onClose,
  initialFocusSelector, lockScroll, restoreFocus })` ; pile de jetons pour
  que seule la surface du dessus écoute Escape/Tab ; écoute en phase de
  capture. Test : `src/test/modal-focus.test.tsx`. Règle : `spec/modal-focus.md`.
- Fichiers upstream modifiés : `src/components/ui/Dialog.tsx` (les effets
  inline remplacés par le hook), `src/components/sidebar/Sidebar.tsx`
  (palette : ref + hook, plus d'effet rAF de focus ni de branche Escape).
- Fichiers fork modifiés : `AskNotesPanel.tsx`, `mobile/ActionSheet.tsx`,
  `mobile/ModelSheet.tsx`, `mobile/screens/studio/StudioLightbox.tsx`.

## Parcours applicatifs (2026-09-04)

- `src/test/app-journeys.test.tsx` : cinq parcours au niveau de `App` (lancer
  et ouvrir une note, recherche palette, « Ask your notes », Réglages ›
  Stockage chargé à la demande, hors-ligne puis « Retry all »).
- `src/test/helpers/fake-bridge.ts` : `fakeBridge(actual, scripted)` garde
  les constantes du vrai `src/lib/tauri`, remplace chaque fonction par un
  no-op résolu, et prend les bindings scriptés par le test. Pièges : importer
  le helper *dans* la factory `vi.mock` (hissée) ; le shell démarre sur
  l'agent (cliquer « Meeting notes » d'abord) ; `isPrimaryShortcut` refuse
  meta+ctrl ensemble ; le bouton « Retry all » est désactivé hors-ligne
  (avancer la sonde de 30 s avec les faux timers).

## Export Markdown et Rapports sur iPhone (2026-09-04)

- `src-tauri/src/note_export.rs` : `export_note_markdown` (desktop seulement,
  allowlisté dans `tests/shared_commands.rs`) ; dialogue natif en Rust,
  `note_markdown` (titre en H1 + corps édité sinon généré),
  `suggested_file_name`. Binding : `src/lib/note-export.ts`.
- `src-tauri/src/diagnostics.rs` : `diagnostics_report_text` (partagé) ;
  binding `src/lib/diagnostics-report.ts` ; écran `ReportsScreen`
  (`mobile/screens/SectionScreen.tsx`), section `reports` dans `nav.ts`,
  ligne dans `SettingsScreen`, route dans `MobileApp`.
- `src/app/tab-meta.tsx` : `tabMeta` + `agentSessionTabTitle` sortis de
  `App.tsx` (cliquet de taille) ; `NoteEditor` reçoit `onExportMarkdown`.

## L'agent desktop cherche comme « Ask » (2026-09-04)

- `src-tauri/src/hermes/june_context_mcp.py` : `search_meeting_notes` passe
  par FTS5 (`notes_fts` + `transcripts_fts`, bm25, un résultat par note,
  notes avant transcriptions) avec les mêmes mots de contenu qu'`ask/`
  (`content_terms`, stop-words FR/EN) ; repli LIKE sur `OperationalError`
  (base sans l'index). La réponse garde sa forme (+ `terms`).
- Test : `src/test/june-context-mcp.test.ts` pilote le vrai module avec le
  `python3` de la machine sur une base synthétique (sauté sans python3).
- ADR 0003 : le doublon du fork (image generation) devient
  `docs/adr/0045-…` avec une note de renumérotation ; lien de CONTEXT.md
  mis à jour.

## « Ask » par le sens (2026-09-04, ADR-0046)

- `src-tauri/migrations/022_note_passages.sql` ; méthodes dans
  `db/repositories/passages.rs` (`passage_source`, `replace_passages`,
  `notes_with_stale_passages`, `passages_missing_embedding`,
  `set_passage_embedding`, `passages_with_embeddings`, `passages_counts`,
  `clear_passages`, `note_titles`).
- `src-tauri/src/ask/semantic.rs` : réglage `ask.json` (`semantic`, défaut
  vrai), découpe (`chunk_body`, `chunk_turns`, hash de source),
  `refresh_note` / `refresh_stale` / `backfill` / `catch_up`, recherche
  cosinus + `fuse` (RRF par note), commandes `ask_index_status` et
  `set_ask_settings` (les deux listes). Hooks : `background::sweep` et
  `agent_notes::announce`.
- `memory/recall.rs` : `embed`, `encode/decode_embedding`,
  `cosine_similarity` passés `pub(crate)` ; l'appel `/embeddings` écrit une
  ligne du registre (purpose `embeddings`).
- Tests : `tests/note_passages.rs`, tests unitaires dans `semantic.rs`,
  `src/test/semantic-ask-card.test.tsx`.

## Escape hatch dev
- `SUBROSA_DEV_API_KEY` (env, **debug uniquement**) : injecte la clé sans passer par le trousseau, pour
  `pnpm tauri:dev` (le trousseau refuse un item créé par un autre binaire). Jamais compilé en release.
- Sur simulateur iOS : `SIMCTL_CHILD_SUBROSA_DEV_API_KEY=cdm_… xcrun simctl launch booted xyz.carpediem.subrosa`.

---

## Procédure de synchronisation upstream (voir aussi `.github/workflows/upstream-sync.yml`)

> **Remplacée le 2026-09-02 par [ADR-0040](docs/adr/0040-upstream-is-a-source-of-patches-not-a-merge-base.md).**
> Le fork ne fusionne plus upstream : il le lit et cherry-picke. `upstream-sync.yml` ouvre désormais
> une issue « Upstream digest » listant les commits upstream non lus depuis le marqueur
> `.github/upstream-reviewed` ; on avance le marqueur quand on a lu. La procédure ci-dessous décrit
> l'ancien flux par PR de fusion et n'est conservée que pour l'historique.

1. `git fetch upstream`
2. Brancher `sync/upstream-<date>` depuis `main`, `git merge upstream/main`.
3. Conflits attendus sur les fichiers listés « modifiés » ci-dessus (surtout `tauri.conf.json`, `lib.rs`,
   `os_accounts.rs`, scripts de build). Résoudre en gardant la logique fork (module `carpe_diem/`, branding).
4. CI verte (`pnpm check`, `typecheck`, `test`, `test:rust`, `test:june-api`) → PR → merge.
