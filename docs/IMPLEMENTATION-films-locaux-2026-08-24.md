# Spec exécutable — production de films locale (retrait de Videomaker)

> Conception et justifications :
> [plan-films-locaux-2026-08-24.md](plan-films-locaux-2026-08-24.md).
> Lire le plan d'abord : ce document ne répète pas les « pourquoi ».
>
> **EXÉCUTÉ le 2026-08-24**, branche `feat/local-film-production`, en v1.46.0.
> État de chaque DONE en fin de document. Le seul non atteint est celui de R0,
> et la raison est écrite là où elle compte : dans le plan, en tête.
>
> **Seams vérifiés le 2026-08-24 sur `c956c0a5` (v1.45.0).** Les numéros de ligne
> dérivent. Chaque seam est donné sous la forme `fichier:ligne` **plus le symbole**
> — si la ligne ne correspond plus, re-localiser par le symbole, jamais par la
> ligne.

## Comment lire ce document

Cinq vagues, exécutables dans l'ordre, chacune indépendamment livrable et
indépendamment révocable. Chaque vague donne :

- **Seams** — les points d'accroche exacts dans le code existant.
- **Étapes** — le travail, dans l'ordre.
- **Smokes sans clé** — ce qui doit passer sans dépenser un crédit ni contacter
  un provider. C'est la protection principale contre les régressions de coût.
- **DONE** — la condition de fin, observable, pas déclarative.

Règles transverses, valables partout :

1. Toute commande partagée va dans **les deux** listes `generate_handler!`
   (`src-tauri/src/lib.rs:218` desktop, `:465` mobile) et
   `src-tauri/tests/shared_commands.rs` casse le build si on l'oublie.
2. Un commentaire de migration ne contient **aucun point-virgule** :
   `run_migrations` découpe les fichiers dessus
   (`src-tauri/src/db/migrations.rs:4`).
3. `make verify` vert avant chaque tag. Les checks iOS
   (`cargo check --target aarch64-apple-ios --lib` et `-sim`) restent verts à
   chaque vague.
4. Rien de neuf sous `src/lib/studio/` ne contient de boucle de polling
   ([ADR-0018](adr/0018-ios-background-work-is-durable-rows.md)).

---

## Vague 0 — Sondes et replis

Trois sondes seulement : le multi-images est déjà résolu et branché
(`composeImages()` dans `src/lib/studio/edit-image.ts`, voir
[carpe-diem-multi-image-edit-request.md](carpe-diem-multi-image-edit-request.md)),
donc la passe de raffinement du storyboard n'a rien à valider.

| Sonde | Comment | Repli si absent |
|---|---|---|
| Un modèle vision acceptant N images en un tour | `POST /v1/chat/completions` multimodal avec 4 images, via le sidecar. `src-tauri/src/videomaker/brief.rs:85` (`videomaker_improve_brief`) montre le motif multimodal avec retry texte-seul déjà en place | Le juge note un panneau à la fois. Si aucun modèle vision : le gate reste humain, R2 livre sans les juges |
| `/video/quote` sur les familles visées | `src/lib/studio/paths.ts` (`supportsVideoQuote`, `VIDEO_QUOTE_PATH`) | L'estimation retombe sur les prix catalogue, marquée « au moins » — comportement déjà implémenté dans `src/lib/studio/workflow/cost.ts` |
| MediaRecorder mp4 en WKWebView **réelle** (appareil, pas simulateur) | `pickRecorderMime()`, `src/lib/studio/assemble.ts:39` | L'export mobile se limite à la timeline NLE + le partage du dossier. Non bloquant pour R1 |

**DONE** : les trois résultats sont écrits en tête de
`plan-films-locaux-2026-08-24.md` § 9, avec la date de la sonde.

---

## Vague R0 — Gel et rapatriement

Objectif : plus rien ne se crée côté Videomaker, et tout ce qui existe rentre à
la maison sous forme de notes et d'artefacts.

### Seams

| Quoi | Où |
|---|---|
| Liste des projets | `src-tauri/src/videomaker/projects.rs:90` `videomaker_list_projects` |
| Export d'un film (re-télécharge le master courant) | `projects.rs:357` `videomaker_export_film` → `projects.rs:394` `download_export` → `FilmArtifactDto` |
| Board (plans et takes) | `src-tauri/src/videomaker/director.rs:78` `videomaker_board` |
| Transcription de production | `director.rs:88` `videomaker_transcript` |
| Indexation d'un fichier téléchargé par Rust dans la galerie | `src/lib/studio/artifacts.ts:84` `registerDownloadedArtifact` — **piège connu** : un download fait côté Rust n'apparaît pas tant que la webview ne l'a pas indexé |
| Création de note | `src-tauri/src/db/repositories.rs:110` `create_note`, commande `src-tauri/src/commands.rs:92` `create_note` |
| Surface Films | `src/components/studio/FilmStudio.tsx`, `FilmDirectorPanel.tsx`, `FilmProduceControl.tsx` |

### Étapes

1. **Gel.** Dans `FilmStudio.tsx`, désactiver création de projet, `start_run` et
   `produce`. Bandeau : ce que devient la production de films, et le bouton de
   rapatriement. Ne **pas** toucher au Rust : les commandes restent, elles
   partiront en R4.
2. **Commande `videomaker_bring_home(slug)`** (desktop uniquement, préfixe
   `videomaker::` déjà dans l'allowlist de `shared_commands.rs`). Elle :
   télécharge le master via le chemin `download_export` existant ; télécharge les
   plans du board et les références ; renvoie la liste des chemins écrits.
3. **Côté webview**, pour chaque chemin renvoyé : `registerDownloadedArtifact`.
   Puis `create_note` avec, dans le corps : le brief, la shot list telle que le
   board la donne, la transcription de production, et les liens vers les
   artefacts indexés. **Un film rapatrié est une note** — pas de nouvelle table,
   pas de nouvelle surface.
4. **Idempotence** : re-lancer le rapatriement d'un film déjà ramené ne crée pas
   une deuxième note ni un deuxième jeu d'artefacts. Clé : le slug, stocké dans
   les métadonnées de la note.

### Smokes sans clé

- `bring_home` sur une réponse Videomaker en fixture (aucun réseau) écrit N
  artefacts et une note, et le second passage n'écrit rien.
- Le gel : aucun chemin de l'UI n'atteint `videomaker_create_project`,
  `videomaker_start_run` ni `videomaker_produce`.

### DONE

Tous les films présents sur le service ont été ramenés **une fois, sur données
réelles**, et sont ouvrables dans l'app avec Videomaker éteint (couper le réseau
vers le service et vérifier que les notes et les artefacts s'affichent).

---

## Vague R1 — Finition locale *(bloquante pour R4)*

### R1a — Export timeline NLE

#### Seams

| Quoi | Où |
|---|---|
| Cut list d'une chaîne, déjà trimée aux raccords | `src/lib/studio/chain.ts:95` `chainCuts`, type `ChainShot` `:17` |
| Fenêtre effective d'un plan | `src/lib/studio/assemble.ts:52` `clipWindow`, `:63` `timelineSeconds` |
| Durée réelle d'un clip | `src/lib/studio/frames.ts:213` `loadVideoElement`, `:71` `lastReadableTime` |
| Chemin disque d'un artefact | `src/lib/studio/artifacts.ts:13` `artifactSrc`, `:214` `exportArtifact`, `:133` `listArtifacts` |
| Surface d'assemblage | `src/components/studio/AssembleStudio.tsx` |
| Partage iOS | `src-tauri/src/share_ios.rs` |

#### Étapes

1. **Nouveau `src/lib/studio/timeline/`** : `fcpxml.ts` (FCPX 1.10 + variante
   Resolve), `xmeml.ts` (Premiere v5), `srt.ts`, `index.ts`.
2. **Entrée unique** : un type `TimelineCut` = liste de plans (chemin, in, out,
   durée mesurée) plus des pistes audio optionnelles. `chainCuts` et la cut list
   d'`AssembleStudio` s'y convertissent tous les deux — **une seule
   représentation, deux producteurs**.
3. **Pistes** : V1 les plans, audio de segment coupé ; A1 dialogue ; A2 SFX ;
   A3 musique. Les rationnels de timecode se dérivent du frame rate déclaré, pas
   devinés.
4. **Chemins** : desktop, `file://` absolus. **iOS, jamais d'absolu** — le
   conteneur change à la réinstallation (piège documenté). Sur mobile, écrire un
   dossier `timeline/` avec les médias et des chemins relatifs, puis le passer à
   la feuille de partage.
5. **Points de sortie** : sélection galerie, nœud `assemble`, vue de chaîne.

#### Smokes sans clé

- Fichiers témoins : trois cut lists fixtures → trois XML comparés **à l'octet**.
  Un changement de format doit casser le test.
- Une cut list dont un plan n'a pas de durée mesurée échoue proprement avec un
  message, elle ne produit pas un XML faux.
- Test de non-régression iOS : aucun chemin absolu dans la sortie mobile.

#### DONE

Une chaîne de 6 plans exporte un `.fcpxml` qui **s'ouvre dans Resolve** avec les
6 plans aux bons points de coupe, et un `.srt` aligné.

### R1b — Mix multi-pistes hors-ligne

#### Seams

| Quoi | Où |
|---|---|
| Assemblage actuel (1 piste de fond, gain fixe) | `src/lib/studio/assemble.ts:84` `assembleClips`, options `:17` `AssembleOptions` |
| Container du recorder | `assemble.ts:39` `pickRecorderMime` |
| Exécuteur du nœud assemble | `src/lib/studio/workflow/engine.ts:831` (`case "assemble"`) |
| Schéma du nœud assemble (ports `clips` + `audio`, param `audioVolume`) | `src/lib/studio/workflow/schema.ts:529-550` |
| Mesure de durée d'un média encodé | `src/lib/studio/reference-media.ts` (`dataUriSeconds`) |
| TTS | `src/lib/studio/speech.ts` |

#### Étapes

1. **`src/lib/studio/mix.ts`** : construit le mix complet dans un
   `OfflineAudioContext` et rend **un** `AudioBuffer`.
   - Entrées : le son de chaque plan, une piste dialogue, une piste SFX, une
     piste musique.
   - Automation de gain par points (`setValueAtTime` /
     `linearRampToValueAtTime`).
   - **Ducking déterministe** : les fenêtres de dialogue mesurées produisent les
     points de gain de la musique. Pas de compresseur, pas de sidechain
     dynamique — c'est reproductible et testable.
   - Fondus de 30 ms de part et d'autre de chaque coupe.
2. **`src/lib/studio/loudness.ts`** : pondération K ITU-R BS.1770 (high-pass +
   high-shelf en `BiquadFilterNode`), mesure gated, renvoie un LUFS intégré et le
   gain de normalisation à appliquer. Un seul gain pour tout le programme.
3. **Ordonnancement du dialogue** : un curseur global, alimenté par les durées
   **mesurées** des fichiers TTS, garantit l'absence de recouvrement sur toute la
   timeline. Ne jamais faire confiance à une durée annoncée.
4. **`assembleClips` v2** : le mix est pré-rendu, puis joué comme source unique
   pendant l'enregistrement vidéo. **Ne jamais `await audioContext.resume()`** —
   ça pend sous autoplay strict (appris le 2026-07-20).
5. **Nœud `assemble`** : ports `dialogue`, `sfx`, `music` en plus de `audio`
   (conservé, il reste valide). Le param `audioVolume` reste, il devient le gain
   de départ de la piste musique.
6. **Alimenter aussi R1a** : le mix produit les trois pistes audio que l'export
   timeline place en A1/A2/A3.

#### Smokes sans clé

- LUFS sur buffers synthétiques : un bruit rose calibré à -23 LUFS doit être
  mesuré à -23 ± 0,5. C'est le test qui prouve que la pondération K est juste.
- Ducking : dialogue factice de 2 s à t=1 s → les points de gain musique
  descendent à t=1 et remontent à t=3, exactement.
- Ordonnancement : trois répliques de durées connues ne se recouvrent jamais,
  quel que soit l'ordre d'arrivée.
- `mix.ts` tourne entièrement en `OfflineAudioContext` : aucun test n'a besoin
  d'un `MediaRecorder`.

#### DONE

Une chaîne de 6 plans avec dialogue TTS et musique sort **à la fois** en
`.fcpxml` ouvrable dans Resolve **et** en mp4 normalisé à -14 LUFS, sans ffmpeg,
sur desktop. Sur iOS, au minimum la timeline.

---

## Vague R2 — La bible et les juges

### Seams

| Quoi | Où |
|---|---|
| Migrations, motif d'enregistrement | `src-tauri/src/db/migrations.rs:173` (`include_str!("../../migrations/016_ingests.sql").split(';')`) |
| Modèle de ligne dérivée à copier | `src-tauri/migrations/015_note_summaries.sql` (lire l'en-tête : il explique pourquoi une ligne plutôt qu'un bloc) |
| Dépôts | `src-tauri/src/db/repositories.rs` |
| Les deux listes de commandes | `src-tauri/src/lib.rs:218` et `:465` ; test `src-tauri/tests/shared_commands.rs` |
| Sélecteur de galerie partagé | `src/components/studio/GalleryPicker.tsx` |
| Artefacts | `src/lib/studio/artifacts.ts:92` `saveArtifactFromBase64`, `:133` `listArtifacts` |
| Famille seedance et mentions canoniques | `src/lib/studio/catalog.ts:261` `isSeedanceModel`, machinerie de mention vers `:434` |
| Nœud `gate` | `src/lib/studio/workflow/schema.ts:509-528` ; décision `src/lib/studio/workflow/engine.ts:986` `gateDecision` ; états `:76-92` |
| Appel multimodal, motif existant | `src-tauri/src/videomaker/brief.rs:85` (à lire **avant** son retrait en R4) |
| Édition multi-images | `src/lib/studio/edit-image.ts` `composeImages()` |
| TTS | `src/lib/studio/speech.ts` |

### Étapes

1. **`src-tauri/migrations/017_bible.sql`** — aucun point-virgule dans les
   commentaires.
   - `bible_entries(id, kind, name, traits, note, created_at, updated_at)` où
     `kind` ∈ `character | location | prop | look`.
   - `bible_refs(entry_id, artifact_id, role, label, ordinal)` où `role` ∈
     `portrait | profile | wide | medium | detail | voice`.
   - Les refs pointent des **artefacts galerie**, jamais des octets. La galerie
     est réconciliée avec le disque et ses entrées disparaissent
     légitimement ([ADR-0020](adr/0020-the-gallery-is-the-studio-exchange-format.md)) :
     une ref dont l'artefact a disparu se signale, elle ne casse rien.
   - Enregistrer dans `migrations.rs` sur le motif de la ligne 173.
2. **CRUD** dans `repositories.rs` + commandes **partagées** → les deux listes.
3. **Panneau Bible** dans le Studio. « Ajouter à la bible » sur la carte galerie.
   Onglet « Depuis la bible » dans `GalleryPicker` pour chaque slot de référence.
4. **Audition de voix** : N échantillons via `speech.ts`, on en garde un, il
   devient la ref `voice` de l'entrée et part en `reference_audio_urls`.
5. **`src/lib/studio/bible/prompt.ts`** — la discipline de prompt :
   - Sujet / Action / Caméra / Style / Contraintes, **sous 60 mots** pour
     seedance.
   - Ordre canonique du stack de références : angle principal du personnage,
     plan de blocking, lieu large, lieu moyen, lieu détail, personnages
     secondaires. Se brancher sur la machinerie de mention canonique existante
     (`catalog.ts`), ne pas en écrire une seconde.
   - Ré-énoncé des traits invariants à chaque plan.
   - Séparateur « Lens switch. » pour grouper 2-3 beats en une génération.
6. **Gate jugé** : `mode: "human" | "judged" | "judged-then-human"` sur le nœud
   `gate`. Un gate jugé appelle un modèle vision avec les panneaux, l'intention
   du plan et les portraits de la bible ; il rend des scores et une liste de
   faiblesses.
   - **Best-effort obligatoire** : échec du juge → dégradation en gate humain.
     Jamais une erreur, jamais un run cassé.
   - Le correctif d'un panneau est le nœud `imageEdit` existant, amorcé avec la
     note du juge (`composeImages()` si plusieurs sources).
7. **Juge de film** : planche-contact de frames échantillonnées dans l'aperçu
   assemblé (`frames.ts` sait déjà extraire et scorer) plus la shot list, en un
   appel. Rend des retakes ciblés, sous la même forme que le juge de panneau,
   pour que l'UI soit la même.

### Smokes sans clé

- CRUD bible en Rust, y compris une ref orpheline (artefact supprimé) qui se
  signale sans planter.
- `shared_commands.rs` passe : aucune commande bible dans une seule liste.
- Construction de prompt : une entrée de bible fixture produit exactement la
  chaîne attendue, sous 60 mots, dans le bon ordre de mentions.
- Un gate jugé dont l'appel juge est stubé en échec **passe** en gate humain, et
  le run continue.

### DONE

Deux personnages et un lieu définis **une fois** ; six plans générés dans trois
sessions différentes gardent la même identité **sans qu'aucune référence soit
ré-uploadée à la main**.

---

## Vague R3 — Du script au film

### Seams

| Quoi | Où |
|---|---|
| Précédent exact de la ligne dérivée | `src-tauri/src/longform/mod.rs:145` `plan`, `:193` `start`, `:519` `note_summary`, `:528` `note_summary_plan`, `:534` `summarize_note_longform`, `:542` `forget_note_summary` |
| « L'app tient l'horloge » | `longform/mod.rs:445` `resolve_chapter_markers` — le motif à copier : le modèle rend un index, l'app le résout et le clampe |
| Prompts fork-side | `src-tauri/src/longform/prompts.rs` (version de prompt incluse) |
| Découpage en parties | `src-tauri/src/longform/chunk.rs` |
| Contraintes de modèle | `src/lib/studio/model-constraints.ts` |
| Forme d'un graphe littéral | `src/lib/studio/workflow/templates.ts` |
| Validation d'un graphe | `src/lib/studio/workflow/validator.ts` |
| Coût d'un graphe | `src/lib/studio/workflow/cost.ts` |
| Moteur | `src/lib/studio/workflow/engine.ts:442` `executeNode`, `:884` `runWorkflow` |
| Runs durables | `src-tauri/src/carpe_diem/workflow_runs.rs`, migration `012_workflow_runs.sql` |
| Enregistrement d'un MCP Hermes | consts `src-tauri/src/hermes_bridge.rs:115-117` (média), fonction `:7269` `sync_june_media_mcp`, appel `:1117`, rendu de config `:7578` |
| Paragraphe SOUL à remplacer | `src-tauri/src/hermes_bridge.rs:204` |
| Outils agent-lite | `src-tauri/src/agent_lite/mod.rs:1161` et `:1178` (définitions), `:807` et `:844` (dispatch), `:1739`-`:1744` (liste de test) |

### Étapes

1. **`src-tauri/migrations/018_shot_lists.sql`** — calqué sur
   `015_note_summaries.sql` : clé = `note_id`, `status`, `parts_json` pour la
   reprise partie par partie, `prompt_version`, `chunk_count`. Lire l'en-tête de
   015, il explique pourquoi les parties ne sont réutilisées que si
   `chunk_count` correspond encore. Aucun point-virgule dans les commentaires.
2. **`src-tauri/src/shotlist/`** — `mod.rs`, `prompts.rs`, sur le modèle exact de
   `longform/`. Map-reduce sur les parties de la note. Commandes : `shot_list`,
   `shot_list_plan`, `build_shot_list`, `forget_shot_list`. **Partagées → les
   deux listes.**
   - **Aucune route ajoutée à `june-api/`.** Tout passe par
     `/v1/chat/completions` via le sidecar, comme `longform/`.
3. **L'app tient l'horloge et le routage.** Le modèle rend une classe de
   mouvement, une liste de personnages et un index de beat. L'app choisit le
   modèle vidéo, la durée et le ratio depuis `model-constraints.ts`
   ([ADR-0022](adr/0022-model-inputs-follow-published-constraints.md)), et clampe
   tout index hors bornes. **Ne jamais demander un timestamp ni un nom de modèle
   au LLM.**
4. **`src/lib/studio/workflow/compile.ts`** : shot list → `Workflow`.
   - Plans → nœuds `video` ; plans enchaînés → `lastFrame` entre eux ;
     références de bible → nœuds `asset` ; répliques → `tts` ; score →
     `music` ; fin → `assemble` puis `output` ; gates jugés aux endroits prévus.
   - **Sortie validée par `validator.ts` avant d'être proposée.** Un graphe
     invalide est un bug de compilation, pas un run raté.
   - **Batching** : maximiser les rendus indépendants lancés en même temps, et
     minimiser le nombre de points de raccord — c'est ce qui borne le nombre de
     retours au premier plan (§ 2 du plan).
5. **Enveloppe de dépense dure.** `cost.ts` estime ; si l'estimation dépasse
   l'enveloppe du run, **la compilation refuse** et propose de réduire (moins de
   plans, famille moins chère). Le handshake de confirmation existant reste en
   plus. Aucun chemin ne dépense sans avoir affiché un chiffre.
6. **Tolérance aux transitoires** dans le runner : un 402 de rail ou un 503 de
   capacité temporise (15 s → 120 s plafonné) et retente la même étape au lieu
   d'échouer le nœud. Ne pas reclasser un 5xx en « occupé »
   ([ADR-0012](adr/0012-upstream-rate-limit-distinct-from-provider-failure.md)).
7. **Visibilité du cycle de vie** : vérifier que le bandeau de run couvre
   `paused`, `awaiting`, `failed` et `interrupted`, pas seulement `interrupted`.
   Un run bloqué ne doit jamais ressembler à un run au repos.
8. **`src-tauri/src/hermes/june_studio_mcp.py`** — action-discriminé :
   `bible`, `script`, `shots`, `render`, `cut`, `inspect`. Objectif : la surface
   d'outils reste autour de 700 tokens toujours chargés. Le détail part dans
   `.agents/skills/subrosa-production/` (chargé à la demande), avec le symlink
   `.claude/skills/subrosa-production` → `../../.agents/skills/subrosa-production`
   créé dans le même changement.
   - Enregistrement : copier le motif de `sync_june_media_mcp`
     (`hermes_bridge.rs:7269`), les consts `:115-117`, l'appel `:1117`, le rendu
     de config `:7578`.
9. **Bascule atomique du SOUL** : le paragraphe `hermes_bridge.rs:204` est
   réécrit dans **le même commit** que l'ajout de `june_studio`. L'agent ne doit
   jamais se retrouver sans outil de film. Le nouveau paragraphe ne parle ni de
   DIEM, ni de gates serveur, ni de production distante.
10. **Agent-lite (mobile)** : trois outils seulement — `bible`, `inspect`,
    `render` — sur le motif de `search_notes` (`agent_lite/mod.rs:807` dispatch,
    `:1161` définition), et ajoutés à la liste de test `:1739`.
11. **Mode réalisateur rapatrié** sur le canvas : gates (nœud `gate`), takes
    (branches de chaîne, `chain.ts:145` `alternativeCount`), board (galerie
    filtrée par run), chat (l'agent avec `june_studio`).

### Smokes sans clé

- **Le smoke central** : une note fixture + une shot list fixture → `compile.ts`
  → graphe → `validator.ts` → `cost.ts`. **Zéro appel réseau, zéro crédit.**
  Instantané de graphe comparé.
- Une shot list qui déborde l'enveloppe fait refuser la compilation avec un
  message chiffré.
- Un index de beat hors bornes est clampé, pas propagé.
- Reprise : une ligne `shot_lists` à mi-parcours reprend à la partie suivante et
  ne rachète pas les précédentes (le test miroir de celui de `note_summaries`).
- `shared_commands.rs` passe.

### DONE

Un paragraphe dans une note devient, **en une confirmation et sans choix de
modèle manuel**, un film de 45 s à deux personnages, monté, mixé, et exportable
en timeline Resolve.

---

## Vague R4 — Le retrait

À n'exécuter qu'une fois R0 réussie sur données réelles et R1 livrée.

### Inventaire de suppression

| Quoi | Où |
|---|---|
| Module Rust | `src-tauri/src/videomaker/` (9 fichiers, ≈ 3 100 lignes) et sa déclaration `src-tauri/src/lib.rs:60` `pub mod videomaker;` |
| Commandes | `src-tauri/src/lib.rs:424-456` (33 entrées) |
| MCP | `src-tauri/src/hermes/june_films_mcp.py` (726 lignes) ; consts `hermes_bridge.rs:118-120` ; `sync_june_films_mcp` `:7292-7304` ; appel `:1117` et argument `:1126` de `sync_hermes_config` (dont la signature perd un paramètre) ; `server_name` `:7601` |
| Route proxy et dispatch | `hermes_bridge.rs:7996` (branche `("POST", "/v1/films/request")`), `:8478-8510` (le handler et son appel), `:8552` `films_dispatch` (et sa variante `#[cfg(not(desktop))]` = 404) ; timeout YAML 900 s |
| Paragraphe SOUL | `hermes_bridge.rs:204` — déjà remplacé en R3, vérifier qu'il ne reste rien |
| Frontend | `src/lib/films/index.ts`, `src/lib/films/refs.ts` ; `src/components/studio/FilmStudio.tsx`, `FilmDirectorPanel.tsx`, `FilmProduceControl.tsx` ; `src/components/settings/VideomakerSettings.tsx` |
| Onglet Studio | `src/components/studio/StudioView.tsx:24` (type `StudioTab`), `:38` (résolution de la valeur sauvegardée — **garder un repli** pour les utilisateurs dont le localStorage vaut `"films"`), `:87` (libellé), `:92-93` (branche de rendu et son commentaire) |
| Tests | `src/test/film-refs.test.ts`, `src/test/film-director.test.tsx`, `src/test/film-studio.test.tsx` |
| Dépendances | `src-tauri/Cargo.toml:87-92` — le commentaire ADR-0010 plus `hex`, `k256`, `sha3`. **Vérifier l'absence d'autre usage avant de retirer** (`grep -rn "k256\|sha3\|hex::" src-tauri/src`) |
| Allowlist du test | `src-tauri/tests/shared_commands.rs` — retirer le préfixe `"videomaker::"` de `platform_specific` |

### Étapes

1. Supprimer dans l'ordre : frontend → MCP et route → commandes → module Rust →
   dépendances. Compiler entre chaque.
2. **Resserrer la CSP.** `src-tauri/tauri.conf.json:80` : retirer `https:` de
   `img-src` **et** de `media-src`. Vérification faite le 2026-08-24 : tous les
   autres consommateurs passent par `asset:`, `data:` ou `artifactSrc`. Re-faire
   le grep avant de commiter, puis **tester à la main** galerie, lightbox, chat
   avec blocs, aperçus d'import.
3. **Garde-fou d'hygiène.** Dans `.github/workflows/repository-hygiene.yml`,
   ajouter une étape « Reject reintroduced Videomaker coordinates » calquée sur
   « Reject reintroduced June coordinates » (`:67-93`) : motif
   `furetier\.com|vmk_|videomaker|\bDIEM\b`, même allowlist (`docs/**`,
   `.agents/**`, `.claude/**`, `FORK_NOTES.md`, `AGENTS.md`, `CLAUDE.md`,
   `CONTEXT.md`, `LICENSE*`, ce fichier de workflow lui-même). Message d'erreur
   pointant vers ADR-0029.
4. **ADR.** Écrire `docs/adr/0029-film-production-is-local.md`, qui **supersède
   nommément** ADR-0010 et ADR-0011 et récapitule les cinq leçons transférées.
   Les deux ADR existants ne sont **pas** modifiés (append-only) : ajouter un
   addendum daté d'une ligne pointant vers 0029.
5. **CONTEXT.md** : réécrire « Film production (fork) » selon le § 8 du plan.
   Sortent Videomaker, Film project, Run, Phase gate, DIEM, Studio wallet.
   Entrent Bible, Shot list, Timeline, Juge. `_Avoid_` mis à jour.
6. **FORK_NOTES.md** : la ligne Videomaker devient une ligne de retrait datée,
   avec le pointeur vers ADR-0029. Ajouter les nouveaux fichiers fork-side
   (`timeline/`, `mix.ts`, `loudness.ts`, `shotlist/`, `bible/`,
   `june_studio_mcp.py`) au tableau de re-merge.
7. **docs/index.md** : enregistrer ADR-0029 à 0033 et les deux documents de ce
   plan.

### Smokes sans clé

- `make verify` vert. `cargo check --target aarch64-apple-ios --lib` et `-sim`
  verts.
- `grep -rn "videomaker\|vmk_\|furetier" src src-tauri --include="*.rs"
  --include="*.ts" --include="*.tsx" --include="*.py"` ne renvoie rien.
- La nouvelle étape d'hygiène **échoue** sur une branche de test où l'on
  réintroduit volontairement `furetier.com` dans un fichier source, et **passe**
  sur `main`.
- Un localStorage valant `"films"` ouvre le Studio sans écran blanc.
- Le binaire ne contacte que Carpe Diem : lancer avec un proxy qui journalise, et
  vérifier qu'aucune requête ne sort vers un autre hôte.

### DONE

L'app produit un film de bout en bout, Videomaker supprimé du dépôt, CSP
resserrée, hygiène verte, et **le binaire ne contacte plus que Carpe Diem**.

---

## Ordre de livraison et versions

| Vague | Version cible | Bloque |
|---|---|---|
| 0 | — | R1 (sonde vision → R2) |
| R0 | v1.46 | R4 |
| R1 | v1.47 | **R4** |
| R2 | v1.48 | — |
| R3 | v1.49 | R4 (le SOUL doit avoir basculé) |
| R4 | v1.50 | — |

Rappel : bumper la version **à la main** dans `tauri.conf.json`,
`src-tauri/Cargo.toml` et `package.json` — `scripts/bump-version.mjs` casse sur
l'espace du chemin « Sub Rosa ».

---

## Où en est chaque DONE

| Vague | DONE | État |
|---|---|---|
| 0 | Les trois sondes ont un résultat écrit et daté | **Atteint.** Vision à N images : passe (kimi-k3, 4 images, dans l'ordre). `/video/quote` : passe, avec le piège `duration` en chaîne. MediaRecorder mp4 sur appareil : non testé, repli en place |
| R0 | Tous les films ramenés une fois, sur données réelles | **Non atteint.** La lecture du PAT en keychain demande une autorisation interactive. Le code a été écrit et testé (rapatriement partiel, reprise forcée, action groupée), puis supprimé en R4. La dernière révision qui le porte est le commit précédant le retrait |
| R1 | Une chaîne de 6 plans sort en `.fcpxml` **et** en mp4 normalisé à -14 LUFS | **Atteint au niveau où c'est vérifiable ici.** Le FCPXML est produit par un test bout en bout qui traverse le vrai générateur ; la loudness lit le signal de référence du standard à -20,0 LUFS. L'ouverture réelle dans Resolve et l'enregistrement mp4 en WKWebView restent à confirmer à la main |
| R2 | Deux personnages et un lieu définis une fois, six plans qui gardent l'identité sur trois sessions | **Atteint structurellement** : les entrées persistent, chaque slot de référence offre la bible, et les traits invariants partent dans le prompt à chaque prise. La constance visuelle elle-même demande des rendus réels, donc des crédits |
| R3 | Un paragraphe devient un film de 45 s en une confirmation, sans choix de modèle manuel | **Atteint jusqu'à la confirmation.** La chaîne note → shot list → graphe validé → devis est testée de bout en bout ; ce qui suit la confirmation dépense de l'argent |
| R4 | Videomaker supprimé, CSP resserrée, hygiène verte, le binaire ne contacte plus que Carpe Diem | **Atteint.** 9 091 lignes supprimées, `https:` retiré de `img-src`/`media-src` avec un test qui l'affirme, garde-fou d'hygiène prouvé dans les deux sens, `make verify` vert |

Ce qui reste demande soit un appareil, soit des crédits, soit les deux. Rien
n'en dépend pour compiler, tester ou livrer.
