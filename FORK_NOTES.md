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
| `src-tauri/src/os_accounts.rs` | `KEYCHAIN_SERVICE`/`DEV_KEYCHAIN_SERVICE` rebrandés (le scheme OAuth `osjune://` interne est laissé — mort en mode local ; voir note) | 2 constantes |
| `src-tauri/src/lib.rs` | `pub mod carpe_diem;` + `settings::setup`/`sidecar::setup` dans `.setup()` + commandes IPC dans `invoke_handler` + `sidecar::shutdown` dans `RunEvent::Exit` | Réappliquer les 4 hooks |
| `src-tauri/icons/*` | Icônes placeholder Sub Rosa (régénérées via `tauri icon`) | Remplacer par les sources définitives |
| `src/app/App.tsx` | Gate Carpe Diem (état + effet + `carpeDiemRequired` dans `appBlocked` + rendu du gate avant l'onboarding) | Réappliquer le bloc gate |
| `src/components/settings/AppSettings.tsx` | Onglet « Carpe Diem » (union `SettingsTab` + `SETTINGS_TABS` + rendu de `<CarpeDiemSettings/>`) ; Models › More options : `VeniceApiKeyRow` (BYOK Venice) remplacée par `CarpeDiemKeyRow` (lien vers l'onglet Carpe Diem + purge d'une clé Venice legacy, qui écraserait la clé `cdm_` par requête) | 3 points + 1 rangée |
| `src/components/sidebar/Sidebar.tsx` | Entrée « Carpe Diem » ajoutée au groupe Personal de `SETTINGS_SIDEBAR_GROUPS` (sinon l'onglet est inatteignable) ; footer `SidebarIdentity` : une fois le solde chargé (`useCarpeDiemCredits`), le libellé « You » est remplacé par « N credits · ×0.42 » (solde disponible + facteur de prix du jour) avec icône carte | 1 item + bloc footer |
| `src/lib/tauri.ts` | Wrappers IPC `carpeDiem*` + types (ajout en fin de section provider) ; valeur `JUNE_COMMUNITY_URL`→`https://t.me/CarpeDiemCommu` (miroir d'affichage de la constante dans `commands.rs`, qui ouvre réellement le lien) | Additif |
| `src-tauri/src/hermes_bridge.rs` + `src-tauri/src/hermes/june_web_mcp.py` | **Bugfix (candidat upstream, 2026-07-04)** : le MCP `june_web` relit les coordonnées du proxy (port éphémère + token) depuis `hermes-mcp/june_web_proxy.json` **à chaque appel d'outil**, au lieu d'argv/env figés au spawn. Sans ça, la gateway Hermes (launchd, survit à l'app) garde le port d'un ancien lancement après relance de l'app → toutes les routines cron échouent en `web_search`/`web_fetch` avec `[Errno 61] Connection refused`. Le script garde un mode legacy (argv = URL http, token en env) pour les process spawnés depuis une vieille config. | Proposer upstream ; sinon réappliquer fichier-coordonnées + entrée YAML `june_web` |
| `src-tauri/src/hermes_bridge.rs`, `scripts/bundle-hermes-runtime-windows.ps1`, `.github/workflows/{release,desktop}.yml` (Windows runtime, 2026-07-04) | **Fix runtime Hermes Windows** : (1) bug PowerShell dans le bundling CI — la restauration d'une env var absente écrivait `""` au lieu de la supprimer (coercion `$null`→`""` de PowerShell), tous les appels `uv` suivants échouaient (`UV_PYTHON_INSTALL_BIN … expected a boolish value`), et `continue-on-error` avalait l'échec → le NSIS v1.0.3 est sorti **sans** runtime embarqué ; (2) bundling Windows désormais bloquant dans `release.yml` + vérification explicite des fichiers du bundle ; (3) `WINDOWS_MANAGED_HERMES_INSTALL_SCRIPT` réécrit : bootstrap d'un `uv.exe` standalone épinglé (URL+SHA256 constantes dans `hermes_bridge.rs`, à garder en sync avec le .ps1) qui installe son propre CPython 3.11 — plus aucun besoin d'un Python système chez l'utilisateur ; (4) copy d'erreur visible neutralisée (« built-in agent runtime », plus de « June »/« Hermes ») ; (5) `desktop.yml` (job windows-rust) parse la syntaxe de tous les `.ps1` **et** du script embarqué | Réappliquer les 5 blocs ; garder l'URL/SHA uv en sync entre `hermes_bridge.rs` et le .ps1 |
| `scripts/patch-hermes-cron-shadow.sh` (nouveau), `scripts/bundle-hermes-runtime.sh`, `scripts/bundle-hermes-runtime-windows.ps1`, `src-tauri/src/hermes_bridge.rs` (MANAGED + WINDOWS_MANAGED install scripts) (**Fix 500 Routines**, 2026-07-06) | **Fix collision `sys.path` du plugin `cron`** : `plugins/platforms/{raft,discord}/adapter.py` font `sys.path.insert(0, parents[2])` — pour un adaptateur à `plugins/platforms/<name>/adapter.py`, `parents[2]` = `hermes-agent/plugins`. Inséré en tête de `sys.path`, ça fait résoudre le nom top-level `cron` vers le plugin `plugins/cron/` (provider de scheduler, sans sous-module `jobs`) au lieu du core `cron/`. Tout endpoint cron du dashboard fait alors `from cron import jobs` → `ImportError: cannot import name 'jobs' from 'cron'` → **HTTP 500** → bannière « Hermes API returned 500 » sur la page Routines. Intermittent : ne mord qu'une fois qu'un adaptateur de plateforme se charge et que son insert gagne le slot `sys.path[0]` après celui de `web_server` (PROJECT_ROOT). Reproduit et corrigé end-to-end (500→200) le 2026-07-06. **Fix** : pointer les deux inserts vers `parents[3]` (racine hermes-agent), comme le font déjà les `gateway/platforms/*.py` (un niveau moins profonds, donc leur `parents[2]` est déjà la racine — **ne pas y toucher**). Patch scopé aux 2 fichiers, idempotent, appliqué dans les 4 chemins qui déposent la source hermes-agent (2 bundles + 2 installeurs managés). | Réappliquer le patch dans les 4 chemins ; si upstream corrige (ou renomme le plugin `cron`), le patch devient no-op / à retirer |
| `src-tauri/tauri.conf.json` (fenêtre `main`, durcissement WebView2, 2026-07-08) | **`additionalBrowserArgs` : désactivation préventive de Local Network Access dans le webview.** Historique honnête : ajouté comme fix supposé du bug « Could not connect to Hermes gateway » sur un PC d'entreprise (stratégie Edge `LocalNetworkAccessAllowedForUrls` repérée dans `edge://policy`) — **ce n'était pas la cause** : le diagnostic sur machine (dump registre) a montré que WebView2 n'applique pas les stratégies du navigateur Edge (arbres `Policies\Microsoft\Edge\WebView2` vides) et le flag actif n'a pas résolu le bug. La vraie cause était le garde Origin du serveur Hermes (voir la ligne « Fix WS origin_mismatch » ci-dessous). L'arg est **conservé** en défense : Chromium déploie Local Network Access par défaut (M138+), et le jour où WebView2 l'active, le `ws://127.0.0.1` du chat serait bloqué. Conserve les défauts Tauri (`msWebOOUI,msPdfOOUI,msSmartScreenProtection`) qu'un `additionalBrowserArgs` explicite écraserait sinon. No-op hors Windows. | Garder l'arg ; si Tauri change ses défauts, re-fusionner la liste `msWebOOUI,…` |
| `scripts/patch-hermes-ws-origin.sh` (nouveau), `scripts/bundle-hermes-runtime.sh`, `scripts/bundle-hermes-runtime-windows.ps1`, `src-tauri/src/hermes_bridge.rs` (MANAGED + WINDOWS_MANAGED install scripts) (**Fix WS `origin_mismatch` Windows**, 2026-07-09) | **Le chat Windows ne s'est jamais connecté : garde Origin du dashboard Hermes.** `hermes_cli/web_server.py` protège `/api/ws` (et `/api/pty`) contre le DNS-rebinding : si le handshake WS porte un header `Origin` en `http(s)`, son hôte doit appartenir à `_LOOPBACK_HOST_VALUES = {localhost, 127.0.0.1, ::1}` (`_ws_host_origin_reason`), sinon `ws.close(4403)` **avant** accept → échec de handshake → bannière « Could not connect to Hermes gateway ». Or le webview Tauri v2 Windows sert l'app depuis **`http://tauri.localhost`** → `origin_mismatch` systématique. macOS passe car WKWebView est sur `tauri://localhost`, schéma non-web que le garde exempte explicitement ; tout le HTTP passe par le proxy Rust, donc **seul** le WS cassait (modèle/crédits OK, chat KO). Diagnostiqué sur machine utilisateur (backend HTTP 200 au moment de l'erreur + flag LNA actif = causes réseau éliminées), confirmé en lisant la source épinglée. **Fix** : ajouter `"tauri.localhost"` à `_LOOPBACK_HOST_VALUES` (ligne 331, unique avec son indentation ; un jumeau **non indenté** existe dans `_local_dashboard_request` et ne doit pas être touché). `*.localhost` = loopback par RFC 6761 (imposé par Chromium), donc zéro surface de rebinding ajoutée — le cas `evil.test` reste rejeté (vérifié contre la logique du garde épinglé). Patch idempotent appliqué dans les 4 chemins qui déposent la source hermes-agent (2 bundles + 2 installeurs managés), comme le fix cron-shadow. ⚠️ même limite que cron-shadow : un runtime **managé** déjà installé au même commit épinglé n'est pas re-patché (l'installeur ne re-tourne pas) ; les runtimes **bundlés** (NSIS/DMG) le sont à chaque build. | Réappliquer dans les 4 chemins ; si upstream ajoute `tauri.localhost` (candidat upstream) le patch devient no-op ; si upstream reformate la ligne 331, ré-ancrer les 3 motifs (`bad`/`good` du .sh, sed du script unix, `.Replace` des 2 .ps1) |
| `src-tauri/tauri.conf.json` + `src-tauri/src/hermes_bridge.rs` (skills bundlés, 2026-07-05 ; +remotion 2026-07-10) | **Pack de skills par défaut** : les 15 dossiers `.agents/skills/carpe-diem-*` du repo + `.agents/skills/remotion-best-practices` (skill officiel `remotion-dev/skills`, suivi dans `skills-lock.json`) sont bundlés en resources (`resources/skills/`) et `external_skill_dirs(app)` (ex-`external_skill_dirs()`) ajoute `resource_dir/skills` **après** les `~/.agents/skills` utilisateur (une copie utilisateur shadow le skill livré ; helpers `bundled_skill_dir`/`merge_external_skill_dirs`, précédence testée). Read-only dans l'éditeur de skills comme tout external dir. `tauri.ios.conf.json` garde `resources: null` → rien ne part sur iOS (pas de Hermes mobile). | Réappliquer les 17 entrées resources + le trio de fns ; re-lister les dossiers si le pack skills change |
| `src-tauri/src/hermes_bridge.rs` + `src-tauri/src/hermes/june_media_mcp.py` (nouveau) (MCP média agent, 2026-07-05) | **Outils média de l'agent** : MCP `june_media` (`generate_image`, `generate_video`, `generate_music`, `check_media`, `list_media_models`) sur le patron `june_web` (script + fichier de coordonnées partagé, relu à chaque appel). Le provider proxy loopback gagne 3 routes : `POST /v1/media/request` (délègue au proxy allowlisté du Studio `carpe_diem::media::carpe_diem_media_request` — la clé reste dans le process Rust), `POST /v1/media/save` (télécharge/décode dans la galerie `studio-media/` via les commandes artifact, retourne le path) et `GET /v1/media/catalog` (relaye le catalogue fusionné du Studio — traits/tier/prix/contraintes par modèle — pour que l'agent choisisse le modèle adapté à chaque demande ; défaut = trait Venice `default`, jamais l'ordre alphabétique). `AppHandle` threadé dans le proxy (`ensure_provider_proxy(app, bridge)`). Note `JUNE_SOUL_MEDIA_MD` ajoutée aux deux souls (sans le mot « sandbox », gardé par `unsandboxed_soul_makes_no_sandbox_claims`). Motivation : le jail Seatbelt bloque le keychain, donc le CLI du skill carpe-diem-media ne peut pas résoudre de clé en session sandboxée. | Réappliquer script + consts + 2 routes + threading AppHandle + entrée YAML + soul note |
| `june-api/crates/providers/src/venice.rs` | **Fallback catalogue Carpe Diem** : `priced_models` tente le shape Venice puis le shape OpenAI-flat (`carpe_diem_type`) + join `GET {racine}/pricing` (structs `CarpeDiem*`, `carpe_diem_priced_model_items`). Sans lui, retour aux 6 modèles curatés de `config.toml`. | Conflits probables sur `priced_models`/`fetch_models` ; réappliquer le bloc fallback (les fns/structs `carpe_diem_*` sont additives) |
| `src/app/App.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/main.tsx` (Studio, 2026-07-04) | Vue « Studio » : cas `"studio"` dans `SidebarView`/`tabMeta`/le switch de rendu, bouton nav + quick command sidebar, import `styles/studio.css` | Réappliquer les 3 hooks (additifs) |
| `src-tauri/tauri.conf.json` (Studio) | Scope assetProtocol `$APPDATA/studio-media/*` (affichage des fichiers de la galerie via `convertFileSrc`) | 1 entrée de scope |
| `package.json` (Studio) | Dépendance `@xyflow/react` (canvas de workflows) | Additif |
| `src-tauri/src/{lib,domain/types}.rs`, `src-tauri/src/db/{migrations,repositories}.rs`, `src-tauri/src/agent_lite/mod.rs`, `src-tauri/src/hermes_bridge.rs`, `src-tauri/src/hermes/june_context_mcp.py`, `src/components/agent/AgentWorkspace.tsx`, `src/components/mobile/screens/{AgentScreen,SettingsScreen}.tsx`, `src/components/settings/AppSettings.tsx`, `src/components/sidebar/Sidebar.tsx`, `src/lib/tauri.ts`, `src/styles/mobile.css` (**Mémoire inter-conversations**, 2026-07-10) | Système de mémoire façon Venice Memoria (voir `docs/adr/0009-local-cross-conversation-memory.md`) : table `memories` (migration 010) + méthodes repository, module `src-tauri/src/memory/` (réglages `memory.json`, commandes CRUD + `memory_extract`, extraction tous les 3 tours assistant, injection `prompt_block`, recall hybride LIKE+cosinus/RRF avec embeddings BGE-M3 appelés en direct sur Carpe Diem). Injection : bloc « User memory » dans `sync_june_soul` (desktop, + section `JUNE_SOUL_CONTEXT_MD` étendue) et dans le system prompt d'agent-lite (mobile, chaque tour). Outils de rappel : `search_user_memories` dans `june_context_mcp.py` (gaté par argv `--memory=off`) et `search_memories` dans agent-lite. Déclencheur desktop : `noteAssistantTurnCompleted` (`src/lib/memory.ts`) branché sur l'événement terminal d'`AgentWorkspace`. UI : onglet Settings « Memory » (desktop) + section Memory mobile. | Réappliquer : migration+repo, `pub mod memory` + 8 commandes dans **les deux** `generate_handler!`, hook agent_lite, param `user_memory` de `sync_june_soul`, arg mémoire du MCP context, trigger AgentWorkspace, entrées UI |
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
| `src/lib/carpe-diem-credits.ts` | Hook `useCarpeDiemCredits` (solde + facteur de prix pour le footer sidebar ; poll 60 s + refresh au focus) |
| `src/components/settings/CarpeDiemSettings.tsx` | Section Réglages (base URL + clé + test + statut sidecar) |
| `src/components/carpe-diem/CarpeDiemGate.tsx` | Écran de connexion premier lancement |
| `src/test/carpe-diem-settings.test.tsx` | Tests UI Carpe Diem |
| `src-tauri/src/carpe_diem/media.rs` | **Proxy média Studio** : commande générique allowlistée vers `/image/*`, `/video/*`, `/audio/*`, `/chat/completions` (clé lue du keychain, jamais exposée à la webview) ; catalogue fusionné CD `/v1/models` + contraintes du catalogue public Venice (ids identiques) + `/pricing` ; galerie d'artefacts sur disque (`$APPDATA/studio-media/`). Voir `docs/adr/0008-studio-media-proxy-in-tauri.md` |
| `src/lib/studio/{types,client,catalog,paths,async-job,artifacts}.ts` | Lib Studio frontend : client IPC typé (retry/backoff), catalogue + groupement familles vidéo t2v/i2v + matrice lyrics musique + estimation de coûts, chemins par backend (musique = `/audio/music/*` sur CD ; retrieve superset `{id, queue_id, model}`), jobs async persistés (reprise après restart), galerie |
| `src/lib/studio/workflow/{schema,validator,engine,store,templates,index}.ts` | Workflows média : schéma déclaratif de nodes (textInput/chat/image/tts/music/video/output), validateur (cycles DFS, kinds, params requis), engine par niveaux topologiques avec outputs typés (chaînage image→vidéo en `image_url`), persistance localStorage, templates |
| `src/components/studio/*` + `src/styles/studio.css` | Vues Studio : Image (contraintes serveur, variants, edit/upscale, path async pour modèles lourds), Video (quote de prix, poll + chrono, reprise de jobs), Music (règles lyrics par modèle, prix par palier de durée), Workflows (canvas `@xyflow/react`, statut live par node) ; galerie commune (lightbox, export, suppression) |
| `src/test/studio-*.test.ts` | Tests catalogue/paths/statuts + validateur + engine (28 tests) |
| `src-tauri/src/memory/{mod,extract,recall}.rs` + `src-tauri/migrations/010_memory.sql` | **Mémoire inter-conversations** : réglages (`memory.json`), commandes CRUD, extraction auto (cadence 3, fenêtre 5+5, importance 1-10 inversée, dédup), bloc d'injection partagé, embeddings BGE-M3 (appel direct Carpe Diem `/embeddings`, blobs f32 LE, backfill best-effort) + recall hybride RRF. Voir `docs/adr/0009-local-cross-conversation-memory.md` |
| `src/lib/memory.ts` | Déclencheur d'extraction desktop (compte les tours assistant par session Hermes, fenêtre les messages, appelle `memory_extract`) |
| `src/components/settings/MemorySettingsSection.tsx` + `src/components/mobile/MemorySettings.tsx` | UI de gestion : toggles (mémoire / apprentissage auto), liste avec pause/édition/suppression, ajout manuel, « forget all » en deux temps |
| `src/test/memory.test.ts`, `src/test/memory-settings-section.test.tsx`, `src-tauri/tests/memory.rs` | Tests : normalisation/fenêtrage frontend, UI Settings, intégration SQLite du repository |

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
| `src-tauri/src/june_api.rs` | `extract_chat_completion_text` passé `pub` | 1 ligne |
| `june-api/Cargo.toml`, `crates/app/*` | Workspace + CLI mince sur `june-embed` | Réappliquer l'extraction |
| `june-api/crates/config/src/lib.rs` | `load_from_toml_str` + `validate_config` (config programmatique) | Additif |
| `src/main.tsx` | Choix du shell desktop/mobile + import `mobile.css` | 4 lignes |
| `src/app/App.tsx` | `recordingToStatus` extrait vers `src/lib/recording-status.ts` | 1 import |
| `src/components/studio/ImageStudio.tsx` | Logique queue/heavy extraite vers `src/lib/studio/generate-image.ts` | 1 import + 1 appel |
| `src/lib/tauri.ts` | Wrappers `importAudioNote`, `mobileDictation*`, `agentLiteRun` + types | Additif |
| `vite.config.ts` | `host: TAURI_DEV_HOST \|\| 127.0.0.1` (dev sur device) | 1 ligne |
| `src-tauri/capabilities/*.json` | `platforms` desktop ajoutés (sinon tauri-build iOS rejette `process:allow-restart`) ; permission clipboard | Garder `platforms` |
| `.gitignore` | `src-tauri/gen/` affiné : gen/apple committé, schemas/build ignorés | Garder |

**Ajouts iOS :**
| Fichier | Rôle |
|---|---|
| `june-api/crates/embed/` | Composition root partagée + `serve()` embarquable |
| `src-tauri/gen/apple/` | Projet Xcode (Info.plist : micro + `UIBackgroundModes` audio) |
| `src-tauri/tauri.ios.conf.json` | 1 fenêtre, pas d'externalBin/resources/updater |
| `src-tauri/capabilities/mobile-main.json` | Capability du webview mobile |
| `src-tauri/src/audio/ios_session.rs` | AVAudioSession (objc2) |
| `src-tauri/src/dictation_mobile.rs` | Dictée in-app (cpal→WAV→`/v1/dictate`+cleanup, historique partagé) |
| `src-tauri/src/agent_lite/mod.rs` | Boucle d'outils agent-lite |
| `src/lib/mobile.ts`, `src/lib/recording-status.ts`, `src/lib/studio/generate-image.ts` | Détection plateforme + helpers factorisés |
| `src/app/mobile/{MobileApp.tsx,nav.ts}` | Shell mobile (gates, état, navigation tabs+stack) |
| `src/components/mobile/**` | TabBar, StackHeader, écrans Notes/NoteDetail/Folders/Dictation/Agent/Studio/Settings |
| `src/styles/mobile.css` | Chrome mobile (safe areas, 44 pt, tab bar, chat, studio) |

**Reste à faire (iOS)** : test micro sur iPhone physique (spike AVAudioSession réel), gestion des
interruptions/changements de route audio, partage (share sheet), lane TestFlight
(`tauri ios build --export-method app-store-connect` + fastlane), CI `ios-release.yml`.

## Escape hatch dev
- `SUBROSA_DEV_API_KEY` (env, **debug uniquement**) : injecte la clé sans passer par le trousseau, pour
  `pnpm tauri:dev` (le trousseau refuse un item créé par un autre binaire). Jamais compilé en release.
- Sur simulateur iOS : `SIMCTL_CHILD_SUBROSA_DEV_API_KEY=cdm_… xcrun simctl launch booted xyz.carpediem.subrosa`.

---

## Procédure de synchronisation upstream (voir aussi `.github/workflows/upstream-sync.yml`)

1. `git fetch upstream`
2. Brancher `sync/upstream-<date>` depuis `main`, `git merge upstream/main`.
3. Conflits attendus sur les fichiers listés « modifiés » ci-dessus (surtout `tauri.conf.json`, `lib.rs`,
   `os_accounts.rs`, scripts de build). Résoudre en gardant la logique fork (module `carpe_diem/`, branding).
4. CI verte (`pnpm check`, `typecheck`, `test`, `test:rust`, `test:june-api`) → PR → merge.
