# Brief d'implémentation autonome — Fork de June « Carpe Diem Edition »

> **Pour Claude Code.** Ce document est ta feuille de route complète. Tu dois livrer un fork de l'application desktop **June** (`open-software-network/os-june`, licence MIT) rebrandé, dans lequel l'utilisateur final n'a plus qu'à **télécharger l'app, ouvrir les Réglages, saisir `base_URL` et `API_KEY` Carpe Diem, et l'app fonctionne**. L'app doit être **signée/distribuable**, se **mettre à jour automatiquement**, et le fork doit **suivre les évolutions GitHub de June**.

---

## 0. Comment tu dois travailler

1. **Lis le code réel avant de coder.** Ce brief décrit l'architecture de mémoire ; la source de vérité reste le dépôt. Avant chaque phase, ouvre et lis les fichiers concernés (`scripts/tauri-dev.mjs`, `scripts/tauri-build.mjs`, `scripts/build-signed-dmg.sh`, `src-tauri/tauri.conf.json` et ses variantes, `src-tauri/capabilities/*`, `june-api/`, `.env.example`, `june-api/.env.example`, `june-api/config.toml`, `docs/release-*.md`, `docs/reproducible-builds.md`). Si ce brief contredit le code, **le code gagne** — signale l'écart et adapte-toi.
2. **Vérifie les API Tauri v2 contre la doc officielle courante.** Les noms exacts de plugins, d'entrées de permissions (capabilities) et la convention de nommage des sidecars peuvent avoir évolué. Ne devine pas : consulte la doc Tauri v2 à jour et le code existant, puis implémente.
3. **Procède par phases.** À la fin de chaque phase, exécute les critères d'acceptation de la phase. **Ne passe pas à la suivante tant que la phase courante n'est pas verte.**
4. **Commits conventionnels, petits et fréquents** (`feat:`, `fix:`, `chore:`, `build:`, `ci:`, `docs:`). Un commit par tâche logique.
5. **Discipline du diff minimal** (voir §3). Chaque fichier upstream modifié est un coût de merge futur : préfère l'ajout de fichiers, isole les changements, documente-les.
6. **Arrête-toi et demande à l'humain** dès qu'une tâche est marquée `⚠️ HUMAIN` (comptes, certificats, secrets, clé de test). Ne fabrique jamais de secret ni de credential.
7. **Tout ce qui est identifiant technique reste en anglais** (chemins, commandes, noms de variables, messages de commit). Les commentaires de code peuvent être en anglais pour cohérence avec l'upstream.

---

## 1. Définition de « terminé » (Definition of Done)

Le travail est terminé quand **les trois** critères ci-dessous sont vérifiables :

- **DoD-1 — Expérience utilisateur final.** Un utilisateur non technique installe l'app via un installeur téléchargé, la lance, un écran d'onboarding lui demande `base_URL` (pré-rempli sur `https://carpe-diem.xyz/api/operator/v1`) et `API_KEY` (`cdm_…`). Après saisie, une note de réunion enregistrée est **transcrite** puis **résumée** sans qu'aucun terminal, fichier `.env`, ni installation de dépendance ne soit requis. Les Réglages permettent de modifier `base_URL` et `API_KEY` à tout moment.
- **DoD-2 — Vraie app distribuable.** `pnpm tauri:build` (ou le script de release) produit des installeurs **signés** pour macOS (DMG notarisé) et Windows (NSIS signé), embarquant `june-api` comme sidecar interne. Aucune dépendance dev n'est requise sur la machine cible.
- **DoD-3 — Auto-update suivant June.** L'app se met à jour via le plugin updater Tauri depuis un flux de release. Un pipeline CI **synchronise périodiquement l'upstream `open-software-network/os-june`** et, lorsqu'une nouvelle version est intégrée et publiée, les utilisateurs la reçoivent automatiquement.

---

## 2. Contexte technique (état des lieux de June)

**Type de projet :** app desktop **Tauri v2**. Gestionnaire de paquets **pnpm** (respecte `packageManager` dans `package.json`, actuellement `pnpm@9.15.4`, via `corepack`).

**Arborescence clé :**
- `src/` — frontend **React 18 + TypeScript** (Vite). UI utilisant TipTap, framer-motion, jeu d'icônes maison.
- `src-tauri/` — backend desktop **Rust** (Tauri v2) + helpers natifs (dont du Swift sur macOS).
- `june-api/` — backend **Rust** séparé : transcription, génération, catalogue de modèles, billing. **C'est lui qui détient les clés fournisseur et parle aux modèles.**
- `scripts/` — `tauri-dev.mjs` (lance Vite **et** un `june-api` local), `tauri-build.mjs`, `build-signed-dmg.sh`.
- `docs/` — `release-macos.md`, `release-windows.md`, `reproducible-builds.md`, checklists Hermes.
- `.env.example` (racine, config desktop, variables **build-time** Vite) et `june-api/.env.example` (secrets serveur).

**Contrat de fonctionnement actuel :** le desktop **ne stocke jamais** de clé fournisseur ; il parle à `june-api` (local en dev, hébergé en prod). En **mode local open source**, tout billing/compte externe est désactivé et un **bearer token partagé** authentifie le desktop auprès du `june-api` local.

**Variables d'environnement pertinentes (confirmées dans le README) :**
- Racine `.env` : `JUNE_API_URL`, `OS_JUNE_LOCAL_DEV`, `OS_JUNE_LOCAL_DEV_BEARER_TOKEN`, `OS_JUNE_LOCAL_DEV_USER_ID`, `VENICE_TRANSCRIPTION_MODEL`, `VENICE_GENERATION_MODEL`, `OS_NOTETAKER_TRANSCRIPTION_LANGUAGE` (optionnel).
- `june-api/.env` : `JUNE__LOCAL_DEV__ENABLED`, `JUNE__LOCAL_DEV__BEARER_TOKEN`, `JUNE__LOCAL_DEV__USER_ID`, `JUNE__UPSTREAMS__VENICE__API_KEY`, `JUNE__UPSTREAMS__VENICE__BASE_URL`, `JUNE__UPSTREAMS__OPENAI__API_KEY`.
- Le bearer token local **doit être identique** dans les deux fichiers.

**Carpe Diem = remplacement d'URL transparent.** Endpoint compatible OpenAI : `https://carpe-diem.xyz/api/operator/v1`. Clé : `cdm_…`. Même protocole que Venice, **mêmes identifiants de modèles** (catalogue synchronisé depuis Venice). Endpoints utiles à June : `POST /chat/completions` (génération) et `POST /audio/transcriptions` (multipart, transcription). Découverte des modèles : `GET /v1/models`.

**Plugins Tauri déjà présents** (`package.json`) : `deep-link`, `dialog`, `notification`, `process`, `updater`. **Absents et probablement nécessaires** : un plugin pour spawn le sidecar (shell) et un stockage de réglages/secret (voir phases 1–3). À confirmer/ajouter.

---

## 3. Décision d'architecture (à respecter)

**On garde `june-api` et on l'embarque comme sidecar Tauri, piloté par les Réglages.** On ne réécrit **pas** la logique d'inférence. Rationale : `june-api` sait déjà parler le protocole, et Carpe Diem est un simple changement de `base_URL`. On réutilise donc tout le code testé (orchestration transcription/génération, reprise sur audio sauvegardé, catalogue de modèles).

**Principe du bearer/URL à l'exécution.** Aujourd'hui l'URL et le token du `june-api` local sont des variables **build-time**. Le fork doit **décorréler** cela : au lancement, l'app choisit un **port libre**, génère un **bearer token aléatoire**, spawn `june-api` en **mode local** avec l'URL Carpe Diem + la clé `cdm_` + ce token (via variables d'environnement du processus enfant), puis pointe le client sur `http://127.0.0.1:<port>` avec ce token. **C'est le cœur du fork.**

**Discipline du diff minimal (obligatoire pour DoD-3).**
- Privilégie **l'ajout de fichiers** (nouveau module de gestion du sidecar, nouveau composant Réglages, nouveaux workflows, config de branding) plutôt que la modification de fichiers upstream.
- Quand tu **dois** toucher un fichier upstream, garde le changement le plus petit et le plus localisé possible.
- Tiens un fichier **`FORK_NOTES.md`** à la racine listant **chaque fichier upstream modifié**, la raison, et comment le re-merger. C'est ce qui rendra les syncs upstream soutenables.
- Regroupe autant que possible la logique du fork derrière une **« distribution flavor »** (ex. une constante/branding config + un module `carpe_diem/`) pour concentrer le diff.

**Alternative explicitement hors périmètre v1 :** supprimer `june-api` et appeler Carpe Diem directement depuis `src-tauri`. Plus léger mais réécriture lourde. **Ne pas faire** ici.

---

## 4. Prérequis & handoffs humains

Ces éléments **ne peuvent pas** être produits par toi. Demande-les à l'humain, arrête-toi si bloquant, et documente clairement ce que tu attends.

- `⚠️ HUMAIN` **Dépôt fork créé** sur GitHub (ex. `<org>/carpe-diem-notes`) et `gh` CLI authentifié, ou remote configuré. Confirme l'accès `git push` et la permission d'écrire des secrets Actions.
- `⚠️ HUMAIN` **Clé Carpe Diem de test** (`cdm_…`) avec quelques crédits, pour la vérification end-to-end. Sans elle, tu ne peux pas valider DoD-1.
- `⚠️ HUMAIN` **Signature macOS** : compte Apple Developer, certificat *Developer ID Application*, et identifiants de notarisation (Apple ID + mot de passe d'app, ou clé API App Store Connect). À fournir en **secrets GitHub**.
- `⚠️ HUMAIN` **Signature Windows** : certificat de code-signing (ou service type Azure Trusted Signing / SignPath). À fournir en **secret GitHub**.
- `⚠️ HUMAIN` **Clé updater Tauri** : tu peux **générer la paire** (`pnpm tauri signer generate`), mais l'humain doit stocker la **clé privée + son mot de passe** en secrets GitHub. La clé publique va dans la config.
- `⚠️ HUMAIN` **Identité de marque** : nom du produit, identifiant de bundle (remplacer `co.opensoftware.june`), et **icônes** (fournir des sources, ou valider des placeholders générés).

Regroupe tes demandes dans un fichier `HANDOFF.md` que tu tiens à jour (ce dont tu as besoin, sous quel nom de secret, pourquoi).

---

## 5. Contraintes légales & branding

- **Licence MIT** : le fork est autorisé (usage commercial inclus) à condition de **conserver** `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` et la mention de copyright d'Open Software. Ajoute ta propre mention sans retirer la leur.
- **Marque** : la MIT couvre le code, pas la marque. **Rebrande intégralement** — nom, `productName` et `identifier` dans `tauri.conf.json`, icônes, chaînes visibles, schémas de deep-link, identifiant TCC (`co.opensoftware.june` → le tien). Aucune réutilisation du nom « June » ou des marques d'Open Software dans le produit distribué.
- **Attribution** : mentionne « basé sur June (open-software-network/os-june), MIT » dans l'À propos et le README du fork.
- **Licences tierces** : vérifie `THIRD_PARTY_NOTICES.md` (notamment le runtime **Hermes** de l'agent) pour confirmer la redistribuabilité dans un binaire distribué. Signale tout doute à l'humain.

---

## 6. Plan d'implémentation phasé

Coche au fur et à mesure. Chaque phase se termine par ses **critères d'acceptation**.

### Phase 0 — Mise en place du fork & build de référence
- [ ] Cloner le fork, configurer le remote `upstream` vers `https://github.com/open-software-network/os-june.git`.
- [ ] `corepack enable` puis `pnpm install`. Installer la toolchain Rust si absente.
- [ ] **Sans aucune modification**, valider le build local en **mode local open source** en suivant le README : copier les `.env.example`, renseigner temporairement `JUNE__UPSTREAMS__VENICE__API_KEY` avec la **clé Carpe Diem de test** et `JUNE__UPSTREAMS__VENICE__BASE_URL=https://carpe-diem.xyz/api/operator/v1`, lancer `pnpm tauri:dev`, et **confirmer une transcription + génération de bout en bout via Carpe Diem** (c'est aussi la validation du fameux test `/audio/transcriptions` multipart).
- [ ] **Lire et documenter** dans `FORK_NOTES.md` : comment `scripts/tauri-dev.mjs` démarre `june-api` (port, env, cycle de vie), comment le client résout `JUNE_API_URL` et le bearer token, où vit le catalogue de modèles, et où les modèles par défaut sont définis.
- **Acceptation P0 :** l'app upstream tourne en local contre Carpe Diem, transcription **et** génération OK. Le mécanisme de démarrage de `june-api` est documenté.

> Si la transcription échoue ici, diagnostique **avant** d'aller plus loin : compare les identifiants de `VENICE_TRANSCRIPTION_MODEL` / `VENICE_GENERATION_MODEL` avec `GET https://carpe-diem.xyz/api/operator/v1/models` et ajuste (racine `.env` et/ou `june-api/config.toml`). C'est un risque connu à lever tôt.

### Phase 1 — Branding & « distribution flavor »
- [ ] Introduire une **config de branding** centralisée (nom produit, identifiant, URLs, `base_URL` Carpe Diem par défaut) côté frontend et côté Tauri.
- [ ] Mettre à jour `productName`, `identifier`, icônes, et chaînes visibles. Remplacer l'identifiant TCC macOS partout où il apparaît (Info.plist, resets, etc.).
- [ ] Conserver les fichiers de licence upstream ; ajouter attribution.
- **Acceptation P1 :** l'app se construit et se lance sous le nouveau nom/identifiant, licences upstream préservées, `FORK_NOTES.md` à jour.

### Phase 2 — Stockage des réglages (URL non secrète + clé secrète)
- [ ] Choisir et intégrer un **stockage de réglages** pour `base_URL` (non secret) — plugin store Tauri v2 ou petit JSON dans l'appDataDir.
- [ ] Choisir et intégrer un **stockage sécurisé** pour l'`API_KEY` `cdm_` — **trousseau de l'OS** (crate `keyring` côté Rust) ou équivalent chiffré. **Jamais** en clair sur disque.
- [ ] Exposer des commandes Tauri (IPC) `get_settings` / `set_settings` / `set_api_key` / `clear_api_key` au frontend, la clé n'étant jamais renvoyée en clair au front une fois enregistrée (ne renvoyer qu'un booléen « présente »).
- **Acceptation P2 :** on peut écrire/lire `base_URL` et écrire/effacer la clé ; la clé survit à un redémarrage et n'apparaît nulle part en clair sur disque.

### Phase 3 — Gestionnaire de sidecar `june-api` (le cœur)
- [ ] Créer un module Rust (`src-tauri/src/carpe_diem/sidecar.rs` ou similaire) qui, au lancement de l'app : sélectionne un **port TCP libre**, génère un **bearer token aléatoire**, **spawn `june-api`** en **mode local** (`JUNE__LOCAL_DEV__ENABLED=true`, billing/OS Accounts off) avec, en variables d'environnement du processus : `JUNE__UPSTREAMS__VENICE__BASE_URL` et `JUNE__UPSTREAMS__VENICE__API_KEY` (depuis les réglages), le bearer token, le port, et un `user_id` local par défaut.
- [ ] Réutiliser la logique de démarrage lue en P0 (`scripts/tauri-dev.mjs`) — port, health check, réconciliation des tokens racine/`june-api`.
- [ ] **Rendre l'URL + le token du client dynamiques à l'exécution** : le frontend/desktop doit cibler `http://127.0.0.1:<port>` avec le token généré, **au lieu** des variables build-time. Trouver tous les points de lecture de `JUNE_API_URL` / bearer et les brancher sur le gestionnaire de sidecar.
- [ ] **Cycle de vie** : démarrer le sidecar au boot de l'app, le **redémarrer** quand `base_URL`/clé changent dans les Réglages, le **tuer proprement** à la fermeture, gérer les conflits de port et un **health check** avant de déclarer l'app prête. Gérer l'absence de clé (état « non configuré » → onboarding).
- **Acceptation P3 :** en `pnpm tauri:dev` **sans** `.env` fournisseur (uniquement via un réglage saisi à l'exécution), l'app spawn `june-api`, et une transcription + génération passent via Carpe Diem. Changer la clé dans les Réglages redémarre le sidecar et reprend le service.

### Phase 4 — UI Réglages + Onboarding
- [ ] Écran **Réglages** avec deux champs : `base_URL` (pré-rempli, éditable) et `API_KEY` (masqué, `cdm_…`), plus un bouton **« Tester la connexion »** qui appelle `GET /v1/models` (ou une requête minimale) via le sidecar et affiche succès/erreur lisible.
- [ ] **Onboarding premier lancement** : si aucune clé n'est configurée, guider l'utilisateur (champ + lien vers le dashboard Carpe Diem pour créer une clé et acheter des crédits). À la validation, enregistrer, démarrer le sidecar, confirmer.
- [ ] Respecter le design system existant de June (composants, typographie). Consulter `/mnt/skills/public/frontend-design/SKILL.md` si présent avant de créer l'UI.
- [ ] Messages d'erreur actionnables (clé invalide, crédits insuffisants/402, endpoint injoignable, modèle introuvable).
- **Acceptation P4 :** un utilisateur qui n'a jamais touché à un `.env` peut, uniquement via l'UI, saisir sa clé et obtenir une transcription. « Tester la connexion » reflète l'état réel.

### Phase 5 — Bundling du sidecar (externalBin) & cross-compilation
- [ ] Compiler `june-api` en **binaire release** pour chaque cible : `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc` (ajouter d'autres si besoin).
- [ ] Déclarer le binaire en **`externalBin`** dans `tauri.conf.json` avec la **convention de nommage par triplet** exigée par Tauri v2 (vérifier la doc courante), et ajouter l'**entrée de permission** (capabilities) nécessaire pour exécuter le sidecar.
- [ ] Adapter le gestionnaire P3 pour résoudre/lancer le **binaire bundlé** (et non plus un `cargo run`).
- [ ] Intégrer la compilation de `june-api` dans `scripts/tauri-build.mjs` (ou un pré-build) pour que le binaire soit prêt et correctement nommé avant le bundling.
- **Acceptation P5 :** `pnpm tauri:build` produit un bundle qui, **une fois installé sur une machine sans toolchain**, lance `june-api` embarqué et fonctionne. Vérifier sur au moins une cible réelle.

### Phase 6 — Signature & notarisation `⚠️ HUMAIN` (secrets)
- [ ] macOS : adapter `scripts/build-signed-dmg.sh` / la conf de bundle pour **signer l'app ET le sidecar embarqué** (hardened runtime, entitlements adéquats pour micro/capture audio) puis **notariser** le DMG. Vérifier la cohabitation avec le write-jail Seatbelt de June sur un processus enfant.
- [ ] Windows : produire un **NSIS signé**.
- [ ] Câbler les certificats/identifiants en **secrets GitHub** (demander leurs noms à l'humain via `HANDOFF.md`).
- **Acceptation P6 :** installeurs signés/notarisés qui s'installent sans avertissement de sécurité bloquant, sidecar inclus signé.

### Phase 7 — Auto-update (updater Tauri)
- [ ] Générer la **paire de clés updater** ; mettre la **clé publique** dans la config updater de `tauri.conf.json` ; l'humain met la **privée + mot de passe** en secrets.
- [ ] Configurer l'**endpoint updater** vers le flux de release du fork (GitHub Releases recommandé) et la génération/publication des **artefacts updater signés** + manifeste (`latest.json` par plateforme, en fusionnant les métadonnées Windows comme le fait déjà June).
- [ ] Implémenter la **vérification de mise à jour** au lancement (silencieuse) + une entrée « Rechercher les mises à jour » dans l'UI, avec le flux d'installation du plugin updater.
- [ ] Mettre en place le **bump de version** (réutiliser `scripts/bump-version.mjs` / `pnpm version:bump`).
- **Acceptation P7 :** une build antérieure installée détecte, télécharge et applique une build plus récente publiée sur le flux.

### Phase 8 — Suivi upstream de June (CI de sync)
- [ ] Workflow GitHub Actions **planifié** (ex. quotidien/hebdo) qui : `fetch` l'`upstream`, tente un merge/rebase sur une branche dédiée, et **ouvre une PR de sync** en cas de nouveautés (ne **pas** auto-merger aveuglément à cause du diff du fork ; laisser l'humain arbitrer les conflits). Un merge propre peut être auto-mergé si la CI passe ; un conflit reste en PR.
- [ ] Workflow **de release** déclenché quand `main` avance (ou sur tag) : build multi-plateforme signé (Phase 6) + publication des artefacts et du manifeste updater (Phase 7) sur GitHub Releases. **C'est la chaîne qui réalise DoD-3** : évolution upstream → PR de sync intégrée → release → utilisateurs mis à jour.
- [ ] Documenter dans `FORK_NOTES.md` la procédure de résolution des conflits récurrents (fichiers du fork vs upstream) et la cartographie des points de contact.
- **Acceptation P8 :** une modification simulée sur l'`upstream` déclenche une PR de sync ; une fois intégrée, une nouvelle release signée est publiée et détectée par l'updater.

### Phase 9 — Vérification globale & documentation
- [ ] **Parcours end-to-end sur build installée** (idéalement les deux OS) : installer → onboarding → saisir clé → transcrire → résumer → dicter (macOS) → modifier la clé dans les Réglages → auto-update depuis une version antérieure.
- [ ] Rédiger `README` du fork (installation utilisateur final, obtention d'une clé Carpe Diem), et compléter `FORK_NOTES.md` (diff upstream) et `HANDOFF.md`.
- [ ] Vérifier `pnpm lint`, `pnpm test`, `pnpm test:rust`, `pnpm test:june-api` au vert (adapter les tests impactés par le fork, sans casser ceux d'upstream).
- **Acceptation P9 :** DoD-1, DoD-2, DoD-3 tous démontrables. Documentation à jour.

---

## 7. Carte des fichiers (indicative — à confirmer sur le dépôt réel)

**Nouveaux fichiers (préférés) :**
- `src-tauri/src/carpe_diem/sidecar.rs` — gestion du process `june-api` (port, token, env, lifecycle, health).
- `src-tauri/src/carpe_diem/settings.rs` — commandes IPC réglages + accès trousseau.
- `src/features/settings/CarpeDiemSettings.tsx` — UI Réglages + test de connexion.
- `src/features/onboarding/CarpeDiemOnboarding.tsx` — premier lancement.
- `src/config/branding.ts` + équivalent Rust — flavor de distribution.
- `.github/workflows/upstream-sync.yml` — PR de sync upstream.
- `.github/workflows/release.yml` — build signé multi-OS + publication updater (peut réutiliser l'existant).
- `FORK_NOTES.md`, `HANDOFF.md`.

**Fichiers upstream probablement modifiés (à minimiser et documenter) :**
- `src-tauri/tauri.conf.json` (+ variantes) — `productName`, `identifier`, icônes, `externalBin`, config updater.
- `src-tauri/capabilities/*` — permission d'exécution du sidecar.
- Point(s) de lecture de `JUNE_API_URL` / bearer côté client et Rust — bascule en runtime.
- `scripts/tauri-build.mjs` / `scripts/build-signed-dmg.sh` — pré-build `june-api` + signature du sidecar.
- Éventuellement `june-api/config.toml` / racine `.env` — modèles par défaut valides sur Carpe Diem.

---

## 8. Commandes de référence

```bash
# Setup
corepack enable && pnpm install

# Dev (upstream tel quel, pour P0)
cp .env.example .env
cp june-api/.env.example june-api/.env
# éditer june-api/.env : JUNE__UPSTREAMS__VENICE__API_KEY=cdm_… et
#                        JUNE__UPSTREAMS__VENICE__BASE_URL=https://carpe-diem.xyz/api/operator/v1
pnpm tauri:dev

# Découverte des modèles Carpe Diem (pour aligner les IDs par défaut)
curl https://carpe-diem.xyz/api/operator/v1/models -H "Authorization: Bearer cdm_…"

# Build
pnpm tauri:build

# Qualité
pnpm lint && pnpm test && pnpm test:rust && pnpm test:june-api

# Upstream
git remote add upstream https://github.com/open-software-network/os-june.git
git fetch upstream

# Clé updater (garder la privée en secret GitHub)
pnpm tauri signer generate
```

---

## 9. Risques & pièges (traite-les explicitement)

- **Transcription multipart** : `POST /audio/transcriptions` doit passer tel quel sur Carpe Diem. Valider dès **P0**. En cas d'échec, c'est presque toujours un **identifiant de modèle** à aligner via `/v1/models`.
- **Signature du sidecar sur macOS** : le binaire `june-api` embarqué doit être **signé avec** l'app, sous hardened runtime, avec les entitlements micro/capture. Tester l'interaction avec le **write-jail Seatbelt** sur un process enfant — c'est la partie la plus fragile.
- **URL/token en runtime** : ne pas laisser traîner de chemin build-time vers `JUNE_API_URL`. Tout doit venir du gestionnaire de sidecar.
- **Sécurité de la clé** : trousseau OS, jamais de log ni de fichier en clair, jamais renvoyée au frontend une fois stockée.
- **Diff minimal** : chaque fichier upstream touché alourdit les syncs. Isole, documente, regroupe.
- **Auto-merge upstream** : ne pas auto-merger un upstream conflictuel — PR de sync + arbitrage humain.
- **Secrets** : jamais commités. Toujours en secrets GitHub, référencés par nom dans `HANDOFF.md`.
- **Reproducibilité** : lire `docs/reproducible-builds.md` et rester compatible avec les attentes de build de June.

---

## 10. Hors périmètre (non-goals v1)

- Supprimer/réécrire `june-api` (appel direct à Carpe Diem depuis `src-tauri`).
- Réintroduire OS Accounts, billing, ou attestation TEE distante (le `june-api` local n'est pas attesté à distance — c'est acceptable ; la confidentialité vient du TEE **de Carpe Diem** côté inférence).
- Support de fournisseurs autres que Carpe Diem/Venice.
- Store Apple/Microsoft (distribution directe via installeurs signés uniquement pour la v1).

---

### Rappel final
Livrable minimal côté utilisateur : **télécharger → onboarding → coller `base_URL` + `API_KEY` → ça marche**, avec **auto-update** qui suit June. Toute la valeur du fork tient dans : *réglages* + *sidecar `june-api`* + *build signée* + *CI de sync/release*. Garde le reste identique à l'upstream.
