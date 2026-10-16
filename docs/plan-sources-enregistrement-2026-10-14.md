# Plan : choisir ce qu'une note enregistre (micro, ordinateur, ou les deux)

> Conception. Date : 2026-10-14. **État : implémenté le 2026-10-14**, les
> cinq lots dans la même branche ; les décisions sont dans
> [ADR-0113](adr/0113-windows-captures-the-computers-sound-in-process.md).
> Premier jet noté 6/10, puis cible 10/10. Ce document reste le registre de la
> réflexion, pas la source de vérité. Reste à valider sur matériel réel
> (§ Vérification).

## Demande

Sur desktop, pouvoir choisir pour une note d'enregistrer le micro **ou** le son
de l'ordinateur, par exemple pendant un appel vidéo.

Arbitrages déjà rendus :

- macOS **et** Windows ;
- pas de filtre par application dans cette version (toute la sortie audio est
  captée) ;
- par défaut « Micro et ordinateur », puis le dernier choix est mémorisé.

## Ce qui existe déjà

- Le mode de source `MicrophonePlusSystem` existe sur macOS 14.2+, via le
  helper Swift hors processus ([ADR-0004](adr/0004-out-of-process-system-audio-helper.md)).
  Le tap CoreAudio couvre toute la sortie par défaut, pas une application.
- Un WAV par source (`microphone.wav`, `system.wav`), transcrits séparément,
  réentrelacés en turns ([ADR-0005](adr/0005-source-separated-audio-capture.md)).
  Le retrait de l'echo des haut-parleurs existe déjà.
- L'interface se résume à un interrupteur « Capture system audio », caché
  derrière un chevron à côté du bouton d'enregistrement
  (`src/components/note-editor/NoteEditor.tsx`).
- L'intention est un état React non persisté (`src/app/App.tsx`,
  `userWantsSystemAudio`), remis à vrai à chaque lancement.
- Quand l'ordinateur n'est pas prêt, le démarrage se replie **en silence** sur
  le micro seul (`effectiveMode` dans `App.tsx`).
- Le micro est **toujours** ouvert (`start_capture` dans
  `src-tauri/src/audio/capture.rs`) : aucun mode « ordinateur seul ».
- Windows n'a aucune capture du son de l'ordinateur : `system_audio_readiness`
  répond `unsupported` hors macOS et l'option est cachée.
- Pendant l'enregistrement, une seule waveform mélange les deux sources
  (`RecorderBar.tsx`, `combineSourceAudioLevels`).
- La transcription affiche « Microphone » / « System ».
- Un rappel de consentement apparaît déjà au démarrage d'un enregistrement.
- La détection de réunion (macOS seulement) démarre avec le mode courant.

## La note : 6/10 pour l'idée telle que formulée

Le besoin vaut 9/10 : l'appel vidéo est le cas central d'une app de notes de
réunion, et l'architecture (sources séparées, capture macOS, retrait de
l'echo) est prête. Ce qui coûte des points :

1. **« Micro *ou* ordinateur » est la mauvaise forme pour un appel.**
   L'application d'appel ne renvoie jamais sa propre voix à la personne qui
   parle : en « ordinateur seul », sa voix disparaît de la note. Un appel
   demande les deux. Le vrai choix porte sur trois situations, pas sur deux
   sources.
2. **La moitié existe, mais on ne peut pas s'y fier.** Option cachée, oubliée
   au relancement, repli silencieux. Le pire échec possible pour cette
   fonction est de découvrir *après* l'appel que les autres participants n'ont
   pas été enregistrés.
3. **Rien sur Windows**, alors que l'app y est publiée.
4. **Aucun retour pendant l'enregistrement** : impossible de voir que
   l'ordinateur est bien capté.
5. **Le micro reste ouvert pour une simple écoute** (webinaire) : bruit de la
   pièce, et l'indicateur micro du système reste allumé.
6. **Jargon** : « System audio » ne dit rien à qui n'est pas technicien.

## La version 10/10

1. **Trois situations, nommées par l'usage**, visibles dans le panneau
   d'enregistrement et dans Réglages › Audio :
   - **Micro et ordinateur** : pour un appel ;
   - **Micro seul** : pour une réunion dans la pièce ;
   - **Ordinateur seul** : pour un webinaire ou une vidéo, sans sa voix. Le
     micro n'est **jamais** ouvert.
2. **Mémorisé.** « Micro et ordinateur » au premier usage. Une réunion
   détectée (macOS) force toujours « Micro et ordinateur ».
3. **Jamais silencieux.**
   - Si l'ordinateur n'est pas disponible (permission refusée, macOS trop
     ancien, aucune sortie audio), le panneau le dit et propose l'action.
   - « Micro et ordinateur » se replie alors sur le micro seul **avec une
     notice visible**.
   - « Ordinateur seul » refuse de démarrer plutôt que d'ouvrir le micro.
4. **Parité Windows** par WASAPI loopback, sans permission à demander.
5. **Confiance pendant l'enregistrement.**
   - Deux niveaux, « Micro » et « Ordinateur ».
   - Un avertissement si l'ordinateur n'a **encore jamais** émis de son après
     20 s ; une fois du son capté, plus d'alerte (pas de faux positif pendant
     une présentation).
6. **Un enregistrement « ordinateur seul » muet échoue clairement** avant
   toute transcription payante, au lieu de produire une note « No speech
   detected ».
7. **Un vocabulaire cohérent** : la transcription et ses filtres disent
   « Micro » / « Ordinateur », comme le panneau.
8. **Une relance qui respecte le mode d'origine.** Bug existant :
   `retry_processing` force `MicrophonePlusSystem` dès qu'il y a plusieurs
   sources, et envoie une source unique à `process_saved_audio`, qui la
   suppose micro.

## Contraintes repérées

- `file-size-ratchet.json` bloque toute croissance de `src/app/App.tsx`,
  `src-tauri/src/commands.rs` et `src-tauri/src/domain/processing.rs`, déjà
  à leur plafond : le lot A libère de la place d'abord.
- Toute phrase nouvelle passe par `t()`, avec les catalogues fr, de, it, es et
  pt-BR remplis (`scripts/i18n/verify-catalogs.mjs`). `t("System")` sert
  aussi au thème : le libellé de source demande une chaîne nouvelle
  (« Computer »).
- Aucune commande Tauri nouvelle : les deux listes `generate_handler!` ne
  bougent pas.
- Pas de migration SQL : `source_mode` est un TEXT sans contrainte CHECK. Un
  client plus ancien lit `system_only` comme micro seul en mémoire mais
  conserve la chaîne.

## Lots

### Lot A : refactorisation sans changement de comportement

- Sortir la readiness des sources de `commands.rs` vers
  `src-tauri/src/audio/readiness.rs`, avec ses tests.
- Sortir `partition_silent_system_sources` et ses types de `processing.rs`
  vers `src-tauri/src/domain/silent_sources.rs`, réexporté.
- Façade `src-tauri/src/audio/system.rs` qui réexporte
  `SystemAudioCapture`, `system_audio_readiness` et `permission_check` selon
  la plateforme, avec un `SystemLaneStatus { level, max_level, bytes_written,
  last_error }`.
- `capture.rs` : extraire un `MicrophoneLane` (writer, stats, stall, aperçu,
  `cpal::Stream`, chemins) avec `open` / `play` / `snapshot` /
  `flush_for_recovery` / `finalize` / `discard`.
  `ActiveRecording.microphone` devient un `Option<MicrophoneLane>`, toujours
  `Some` à ce stade.
- `App.tsx` : sortir l'état et les effets de readiness vers
  `src/app/useRecordingSources.ts`, et `startingRecordingStatus` vers
  `src/lib/recording-status.ts`.
- `voice/mod.rs` : `pub(crate) mod resample;` pour réutiliser `to_mono` et
  `Resampler`.
- Abaisser les plafonds avec `node scripts/file-size-ratchet.mjs`.

### Lot B : « Ordinateur seul » côté Rust

- `domain/types.rs` : variante `SystemOnly` (db `system_only`, serde
  `systemOnly`), helpers `includes_microphone()`, `includes_system()`,
  `primary_source()` ; `required_sources(SystemOnly)` renvoie `[System]`.
- `capture.rs` : n'ouvrir la voie micro que si le mode l'inclut ; en
  `SystemOnly`, la voie principale (chemins, niveau, octets) est
  `system.*.wav` ; `source_statuses` et `started_sources` suivent le mode ; un
  `last_error` système verrouillé remonte dans `FinishedSource.capture_issue`.
- `audio/readiness.rs` : `required` selon le mode, sonde de permission dès que
  le mode inclut l'ordinateur.
- `commands.rs` : la garde mobile rejette tout mode incluant l'ordinateur ;
  `finish_recording_session` utilise `primary_source()` au lieu du micro ;
  `retry_processing` relit le mode stocké via une fonction de routage pure et
  testable.
- `domain/silent_sources.rs` : signaler `only_source_silent` ;
  `process_saved_source_audio` échoue alors avec `system_audio_silent`
  avant toute détection ou appel payant (checkpoint écrit, note en échec).
- Les libellés `Microphone:` / `System:` envoyés au modèle ne changent pas.

### Lot C : choix, mémorisation et repli visible

- `src/lib/tauri.ts` : `"systemOnly"` et les helpers
  `sourceModeIncludesSystem` / `sourceModeIncludesMicrophone`.
- `src/lib/recording-source-mode.ts`, sur le modèle de `theme.ts` : clé
  localStorage `os-june:recording-source-mode` validée, et résolveur pur
  `resolveRecordingStart(requested, readiness)` qui porte les règles de
  repli (y compris un nouvel essai en micro seul si `startRecording` échoue
  avec une erreur `system_audio_*`).
- `App.tsx` : contrôle du micro seulement si le mode l'inclut, notice
  `computerUnavailable`, chemin « réunion détectée » forcé à
  `microphonePlusSystem`.
- `src/components/recorder/SourceModeChoice.tsx` : groupe radio de trois
  lignes avec un indice chacune, lignes désactivées et explication quand
  l'ordinateur est indisponible (bouton « Autoriser », macOS 14.2, nouveau
  `recoveryAction: "checkSoundOutput"`).
- `NoteEditor.tsx` : le Switch devient `SourceModeChoice` ; visibilité selon
  `capabilities.systemAudio`, plus `isMacLikePlatform` ; notice « micro
  bloqué » seulement si le mode inclut le micro ; notice de repli ; libellés
  « Microphone » / « Computer ».
- Réglages › Audio : une ligne « Source d'enregistrement » avec le même
  composant, désactivée pendant un enregistrement.
- Faire passer par `t()` les textes qui le contournent aujourd'hui
  (`NoteFailureBanner.tsx`, Pause/Reprendre de `RecorderBar.tsx`, le message
  d'avertissement brut du dock).

### Lot D : deux niveaux et l'avertissement « ordinateur muet »

- Rust : `SourceWarningDto { source: System, code: "system_audio_silent" }`
  quand le temps actif atteint 20 s et que `max_level` reste sous
  `DEFAULT_SILENCE_THRESHOLD`.
- `src/lib/recording-warnings.ts` : chaque code d'avertissement vers un texte
  `t()`.
- `RecorderBar` : deux `Waveform` quand il y a deux sources
  (`scaleAudioLevel` + `SOURCE_VISUAL_GAIN`), icônes central-icons,
  `data-silent`. `GlobalRecorderPill` garde la waveform mélangée avec un
  point d'avertissement. Tokens de `tokens.css`.

### Lot E : capture Windows (WASAPI loopback dans le processus)

- `src-tauri/src/audio/system_windows.rs`, même surface que le backend
  macOS. Un thread dédié possède le `cpal::Stream` ouvert sur
  `default_output_device()` avec `default_output_config()`
  (`build_input_stream` sur une sortie ouvre le loopback dans cpal 0.15, à
  confirmer dans ses sources). Le callback ne fait qu'envoyer dans un
  `sync_channel` borné ; le worker convertit en mono, rééchantillonne à
  48 kHz et écrit un WAV 16 bits.
- **Alignement** : le loopback ne livre rien pendant un silence, donc le
  worker comble avec du silence selon l'horloge murale, comme le helper macOS
  (écart > 80 ms ; aucun paquet depuis > 200 ms ; avant pause et arrêt). Le
  writer est vidé chaque seconde pour l'aperçu en direct.
- **Changement de périphérique** : nom de la sortie par défaut vérifié chaque
  seconde, plus le callback d'erreur ; reconstruction du flux, format de
  fichier inchangé.
- **Niveau** : `min(1, rms*4)` sur 80 ms, l'échelle du helper macOS.
- Logique pure (comblement, horloge active) dans
  `audio/system_timeline.rs`, compilé `#[cfg(any(windows, test))]` pour être
  testé sur la CI Linux.
- Readiness `granted` si une sortie par défaut existe, sinon
  `checkSoundOutput`. Carte des capacités : `system_audio: true` sur Windows.
- **ADR-0113** « Windows capte le son de l'ordinateur dans le processus » :
  aucune permission à isoler, cpal déjà lié, pas de second binaire à signer
  dans le pipeline NSIS ; process loopback (par application) écarté pour
  l'instant ; seul le périphérique du rôle console est capté, le contenu DRM
  ou en mode exclusif arrive muet. Addendum daté à l'ADR-0004.

### Documentation

- `CONTEXT.md` : trois modes de source et leurs noms à l'écran ; entrée pour
  le loopback Windows ; « avoid: in-process capture » réservé au helper macOS.
- `docs/audio-pipeline.md`, `docs/release-windows.md`, `docs/index.md`.
- `specs/002-system-audio-source-mode/spec.md` : addendum qui remplace
  FR-002 par le défaut mémorisé « Micro et ordinateur » et pose la règle
  « jamais le micro en ordinateur seul ».
- `FORK_NOTES.md` : fichiers upstream modifiés et façon de les re-fusionner.

## Vérification

- **Rust** : statuts et sources de départ par mode ; avertissement
  seulement tant que l'ordinateur n'a jamais été entendu ; aller-retour
  db/serde de `system_only` ; `SystemOnly` n'exige pas le micro ;
  `only_source_silent` et la décision d'échec ; routage de la relance ;
  comblement et pause de `system_timeline`.
- **Vitest** : mémorisation et résolveur (jamais le micro en ordinateur
  seul) ; deux niveaux et texte d'avertissement ; mise à jour des tests de
  l'éditeur, des réglages, du démarrage sur réunion détectée, de la fiabilité
  des notes, de la readiness et du contrat Tauri ; vider la nouvelle clé
  dans `src/test/setup.ts`.
- **Portes** : `make verify`, `pnpm i18n:check`, `cargo check --target
  aarch64-apple-ios --lib` (et `-sim`), test du plafond de taille.
- **Sur du vrai matériel** :
  - macOS : en « Ordinateur seul », pas d'indicateur micro, seulement
    l'indicateur audio système ; permission refusée → notice de repli ;
    réunion détectée → « Micro et ordinateur » ; application d'appel réglée
    sur une sortie autre que celle par défaut → l'avertissement se déclenche.
  - Windows : applications de visio et vidéo dans le navigateur captées ;
    plusieurs minutes avec passages muets sans désordre des turns ;
    haut-parleurs → casque USB, débranchement, casque Bluetooth qui bascule en
    mains libres ; sorties 44,1 / 96 kHz et 5.1 ; veille et reprise ; CPU du
    worker.

## Hors périmètre (suivis possibles)

- Filtre par application (tap CoreAudio limité à des processus sur macOS,
  process loopback sur Windows).
- Détection de réunion sur Windows.
- Choix du micro utilisé pour les notes (aujourd'hui l'entrée par défaut).
- Nommer les sources « Vous » / « Participants » dans la note : pas de
  diarisation, et cela toucherait `june-api/`.
