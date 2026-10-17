# Workflows Sub Rosa : rattraper puis dépasser ComfyUI

## Contexte

Morgan trouve ComfyUI en avance sur les workflows du Studio, en particulier leur rendu
visuel. Il demande d'analyser leur dépôt en profondeur, d'en tirer un plan
d'amélioration, de le noter sur 10 (qualité de l'amélioration, intégration,
pertinence) puis de l'amener à 10/10. Carte blanche ; Sub Rosa ne doit être en retard
sur Comfy sur aucun point pertinent pour une app 100 % hébergée (pas de GPU local,
tout passe par Carpe Diem).

Méthode : trois analyses (le moteur `Comfy-Org/ComfyUI` lu dans le code, l'éditeur
`Comfy-Org/ComfyUI_frontend` lu par `gh api`, l'état du workflow Sub Rosa), un plan
v1 noté, un plan v2 noté puis **relu de façon adversariale contre le code** (33
défauts réels trouvés), et cette v3.

### Ce que Comfy fait mieux

- **Moteur** : cache par signature des entrées, un nœud inchangé ne repaie jamais
  (`comfy_execution/caching.py`) ; file de nœuds prêts qui lance les appels réseau en
  premier (`graph.py::ExecutionList`) ; exécution partielle
  (`partial_execution_targets`) ; aiguillage paresseux qui ne paie pas la branche non
  prise ; listes et expansion (une image par ligne, boucles) ; validation avec
  erreurs typées par nœud ; contournement et muet ; remplacement de nœuds versionné
  (`NodeReplace`) ; badges de prix évalués en direct ; polling qui sépare file et
  calcul avec estimation p50/p90 ; couche HTTP avec clé d'idempotence, budget 429 et
  `Retry-After` ; contrôle de la graine.
- **Éditeur** : prix sur chaque nœud et total près de Lancer, recherche au double-clic
  et au relâcher d'un lien (filtrée par type, nœud branché tout seul), barre de
  sélection (exécuter la sélection, contourner, cadre, ranger, convertir en
  sous-graphe), sous-graphes avec fil d'Ariane et blueprints, cadres, notes,
  minicarte par statut, ranger avec curseur d'écart, annuler et copier, raccourcis,
  liens colorés par type, nœuds compacts au dézoom, erreurs sur le nœud avec
  « localiser », historique avec ETA, onglets avec statut, modèles à vignettes
  animées, workflow embarqué dans les sorties, **mode appli**, assistant qui édite le
  graphe.

### État de Sub Rosa (vérifié)

- `WorkflowStudio.tsx` : 1 986 lignes pour un plafond de 2 000, sans test.
  `engine.ts` 1 436, `ProjectStudio.tsx` 1 927, `media.rs` 1 852, `lib.rs` 1 899,
  `repositories.rs` 5 349 pour une exception à 5 350.
- Moteur par niveaux (`topoLevels` + `Promise.all`), **aucun cache entre lancements**,
  pas d'exécution partielle sur le canevas, un nœud invalide bloque tout.
- Les rendus durables ne bénéficient jamais de la patience 402/503 et un 429 n'est
  jamais renvoyé (`workflow-run.ts:369-378`, `jobs.rs:263-293`).
- Canevas sans minicarte, barre de sélection, menus, reconnexion ; ajout par une
  liste non traduite ; ni annuler, ni copier, ni cadres, ni sous-graphes ; sorties
  effacées à la réouverture.
- Bugs : `aspect_ratio` au lieu de `aspectRatio` (`WorkflowStudio.tsx:633`),
  `Darkroom` au lieu de `Veil`, Supprimer sans confirmation, lancements annulés ni
  reprenables ni écartables (ils s'accumulent), juge non chiffré, docs qui parlent
  encore des Flows mobiles supprimés le 2026-09-22 (ADR-0030, `compile.ts`,
  `schema.ts`, CLAUDE.md).
- Téléphone : plus aucune surface de workflow. Synchro : workflows non synchronisés.
- Le MCP `june_studio` (`src-tauri/src/hermes/june_studio_mcp.py`, outils `bible` et
  `shots` via `studio_actions.rs`, partagé avec agent-lite) existe déjà.
- Numéros libres (origin/main bfc70ec08) : ADR 0114+, migration 079+.

---

## Plan v1 et sa note : 5,7/10

Liste de neuf chantiers copiés de Comfy : canevas (annuler, copier, raccourcis,
recherche, minicarte), cache et partiel et contournement, badges de prix,
cadres et sous-graphes, historique, mode appli, nouveaux nœuds, import Comfy,
workflow embarqué.

| Critère | Note | Pourquoi |
|---|---|---|
| Qualité | 6 | Copie sans adapter : cache dangereux sur des modèles payants et non déterministes, planificateur à barrière ignoré, aucune mesure de réussite. |
| Intégration | 4 | Ignore le plafond de 2 000 lignes, ADR-0018/0021/0075, les specs, les deux listes de commandes, la numérotation, les bugs existants. |
| Pertinence | 7 | Rate le téléphone, la synchro, l'ETA, l'assistant, les PNG Comfy ; pas de refus ni de matrice. |

## Plan v2 et sa note après relecture : 7/10

La v2 ajoutait un lot de fondations, les prises, l'aplatissement des blocs, le mode
appli sur téléphone, la synchro, l'assistant, une matrice de parité et un train de
releases. Elle se donnait 10/10 ; la relecture contre le code lui a trouvé 33
défauts, dont les plus graves :

- La migration prévue (`workflow_runs.workflow_id`) existe déjà depuis la 012, et
  stocker des `targets` aurait fait rejouer les nœuds hors cible à la reprise.
- L'exécution partielle arrivait avant le cache, donc rachetait l'amont.
- La file de nœuds prêts changeait la sémantique des gates et des échecs pour
  `ProjectStudio` sans le dire.
- Les éléments de liste en lignes durables auraient été perdus en silence
  (`set_workflow_run_node` ne fait qu'un `UPDATE`), la reprise aurait racheté.
- L'ETA se lisait dans `media_jobs`, dont les lignes sont supprimées dès qu'on les
  écarte.
- La signature citait le composeur de prompt alors qu'ADR-0074 l'interdit, et un
  cache global aurait cassé « Refaire » de `ProjectStudio`.
- La provenance « workflow » demandait du Rust (`image_refine.rs`) et trois chemins
  webview l'auraient écrasée.
- La synchro aurait laissé un appareil plus ancien effacer les blocs d'un plus récent
  (le store ne garde que `{nodes, edges}` et ignore `format_version`).
- Le mode appli supposait des surfaces de lancement sur téléphone qui n'existent plus.
- Lots trop gros pour une PR ; traductions limitées au français alors que six langues
  sont testées.

| Critère | Note |
|---|---|
| Qualité | 8 |
| Intégration | 5 |
| Pertinence | 8 |

---

## Plan v3 (10/10)

### Principes

- **Ne jamais repayer, ne jamais dépenser en silence.** Tout passe par le prix
  affiché, le cache, le plafond de dépense et `RunCostDialog`.
- Le canevas reste React Flow, le moteur reste dans la webview (ADR-0021), les rendus
  restent des `media_jobs` durables (ADR-0018). Blocs et listes sont **aplatis avant
  l'exécution**. Le moteur ne gagne jamais de sorties multiples : `sourcePort` ne vit
  que dans l'interface et `flatten.ts`.
- **Le cache est une option du lanceur, activée par le canevas seul.** `ProjectStudio`
  garde sa propre signature de prise (`projects.ts:260-298`) et son « Refaire ».
- Chaque emprunt à Comfy est adapté ou refusé ; `docs/comfy-parity.md` le prouve
  ligne par ligne. Jusqu'à la dernière PR, son test vérifie que chaque ligne a un
  statut et un lot ou un ADR ; la dernière PR exige zéro « à faire ».
- Chaque PR dans `.worktrees/<nom>` depuis `origin/main` fraîchement récupéré.
  Portes communes : `make verify` vert, ratchet et cliquet Biome, copy via `t()`
  dans les **six langues** (de, en, es, fr, it, pt-BR) et `tr!` côté Rust, sentence
  case, sans tiret typographique, icônes `central-icons`, tokens, modales via
  `useModalFocus`, nouvelles commandes Tauri dans **les deux** `generate_handler!`,
  nouveau Rust dans de nouveaux modules (jamais `repositories.rs`, `media.rs`,
  `lib.rs` au-delà du strict enregistrement). Captures clair/sombre et sondes DOM
  Playwright sur `workflow-preview.html`. Les lots qui touchent le moteur passent
  aussi `studio-project-production-ui.test.tsx` et `studio-projects.test.ts`.
- Vocabulaire : « prise » existe déjà dans CONTEXT.md (Take, ligne 715). On ajoute
  « signature d'étape », « étape réutilisée », « compteur de prise », « bloc »,
  « cadre », « appli » dans CONTEXT.md au lot qui les introduit.
- Réservations : ADR 0114 à 0120 ; migrations 079 (cache), 080 (journal des durées),
  081 (versions). Un numéro non utilisé est consigné dans `docs/index.md`.

### Phase A · Fondations (R1)

**A1 · Découpage, sans changement de comportement.**
`WorkflowStudio.tsx` → `src/components/studio/workflow/` (`WorkflowCanvas`,
`StudioNode`, `ParamField`, `NodeOutputView`, `WorkflowToolbar`, `RunBanners`,
`ImportReview`, `RunCostDialog` sorti en composant partagé pour le téléphone et
l'assistant). Le code par type de nœud de `engine.ts` part dans
`workflow/nodes/*.ts`. Premiers tests RTL du canevas, mock périmé de
`studio-view-tabs.test.tsx` corrigé. Porte : captures identiques avant/après.

**A2 · Bugs et garde-fous.** `aspectRatio`, `Veil`, commentaire orphelin,
confirmation de suppression, palette traduite, lancements annulés listés comme
écartables (jamais repris d'office), drapeau `paid` dans le schéma lu par
`engine.ts:1170` et `workflow-run.ts:689`, juge chiffré et soumis au garde, **plafond
de dépense** du canevas (terme « Spend ceiling » de CONTEXT.md) avec une marge pour
les nœuds mesurés (le garde de `project-production.ts:443` refuserait tout nœud
chat). Docs : addendum ADR-0030, FORK_NOTES 237-238, `compile.ts`, `schema.ts`,
CLAUDE.md ; statuts des lancements documentés dans `workflow_runs.rs` (modifier la
012 la ferait rejouer).

**A3 · Format v2 et migration des nœuds.** `workflow/migrate.ts` : version par nœud
et registre de remplacements à la `NodeReplace`, appliqué **à l'ouverture et à
l'import seulement** (un lancement gelé ne change jamais, ADR-0021).
`WORKFLOW_FILE_VERSION = 2` lit la v1. Le store fait l'aller-retour des champs
inconnus (cadres, blocs, appli) et **ouvre en lecture seule un workflow d'un format
plus récent**. Préalable à la synchro.

**A4 · Fiabilité des rendus (ADR-0114, partie 1).** `media_job_queue` renvoie le
statut et `retryAfterMs` ; sur un 402 ou 429 définitif (non facturé,
`jobs.rs:962-966`), nouvelle file avec un nouvel id de job après le délai. Sémaphore
**global au module** (plusieurs lancements vivent dans une webview), dimensionné
depuis `GET /v1/rate_limits`. Attente des jobs sur l'événement `june://media-job`
(`media-jobs-live.ts`) au lieu de lister toute la table toutes les 3 s par nœud. Pas
de nouvel essai d'un appel payant sur un 5xx dans un workflow. Demande à Carpe Diem
d'un en-tête `Idempotency-Key` et d'une étiquette par requête, consignée dans
`docs/carpe-diem-parity-requests.md`.

### Phase B · Ne jamais repayer (R1)

**B1 · Cache des étapes (ADR-0115, migration 079).**
- Deux signatures. **Statique** (arbre de Merkle des réglages, du type, de la version
  de schéma, du compteur de prise, de la graine, des signatures amont par port dans
  l'ordre des arêtes, sans id ni position) pour le badge « Réutilisé » et le prix à
  l'édition. **Réelle** = SHA-256 du corps final de la requête (chemin, modèle, corps),
  calculée juste avant `beforeNode` : c'est la clé du cache, elle capte les défauts
  du catalogue, les rôles de référence et l'attestation seedance. Les sources
  gratuites (asset, note, texte) entrent par le hachage de leur sortie.
- Table `workflow_node_cache` : clé réelle, type, référence d'artefact (jamais
  d'octets en ligne), lancement, dates. Seuls les nœuds payants et `assemble` sont
  cachés. Un artefact sorti de la galerie = raté et purge. La galerie est lue une
  fois par lancement, pas à chaque réutilisation.
- Prise : « Garder » (défaut) ou « Nouvelle à chaque lancement » ; « Refaire »
  incrémente le compteur. **Graine** envoyée là où le modèle en publie une, comprise
  dans la signature : un raté avec « Garder » reproduit alors le même résultat.
- Le prix exclut les étapes réutilisées (« 12 crédits, 3 étapes réutilisées »).
  Verdicts du juge cachés par la signature des candidats.
- Porte : test de propriété (ids et positions changés → même signature ; tout réglage
  ou entrée changé → autre ; artefact supprimé → raté) ; **essai réel : deux lancements
  identiques, `GET /v1/credits` avant et après, le second coûte 0.**

**B2 · Sorties et historique à la réouverture.** `workflow_id` existe déjà
(migration 012). Nouvelle commande de liste filtrée par workflow, sans définitions,
avec règle de rétention (deux listes de commandes). Les nœuds montrent les sorties du
dernier lancement ; panneau d'historique (statut, durée, coût, vignettes, erreur,
« Rouvrir ce lancement »).

**B3 · File de nœuds prêts, partiel, modes, erreurs sur les nœuds (ADR-0114,
partie 2).**
- File à la `ExecutionList` : un nœud part dès que ses entrées sont prêtes, priorité
  par type (vidéo et musique, puis image, puis chat).
- ADR-0114 fixe : ce qu'un gate en attente bloque (ses descendants seulement),
  quel statut l'emporte quand un lancement a à la fois des échecs et des attentes
  (`failed`, reprenable, gates approuvables), le comportement de la reprise stricte
  dans ce cas. **L'isolation des échecs est une option, désactivée pour
  `ProjectStudio`** tant qu'elle n'a pas été revue avec ses tests.
- Partiel : « Exécuter ce nœud », « jusqu'ici », « la sélection ». Le lancement gèle
  **le graphe élagué** comme définition (pas de colonne `targets`) ; l'amont vient du
  cache B1. La validation ne porte que sur ce qui tourne.
- Modes `always | bypass | mute` ; l'import Comfy traduit enfin les modes 2 et 4.
- `ValidationIssue` gagne `port` et `code` (il a déjà `nodeId`, `edgeId`) ; le moteur
  remonte toutes les erreurs, pas la première ; anneau rouge et panneau avec
  « Localiser ».

**B4 · Prix en direct.** Badge sur chaque nœud : forfait (`cost.ts`), vidéo par
`/video/quote` à l'édition **sans nouvel essai, une à deux requêtes à la fois,
mémorisé par signature statique**, familles non chiffrables (`ltx-*`, vidéo vers
vidéo, agrandissement) affichées « prix au lancement ». Mesuré en fourchette. Total
= nœuds ciblés non réutilisés ; survoler Lancer surligne ce qui va payer.

**B5 · Durée estimée (migration 080).** Journal des durées écrit par `jobs.rs` (mise
en file, début de calcul, fin) qui survit à l'écartement du job, avec les appels
image synchrones. Commande `media_job_durations` (p50/p90 par modèle). Sur le nœud :
« environ 1 min restante », « plus long que d'habitude », barre à 90 % au p50 quand le
fournisseur ne donne rien, temps en file séparé du calcul.

→ **Release R1** (A1 à B5) : le gain d'argent et de fiabilité.

### Phase C · Le canevas (R2)

- **C1** Annuler/rétablir (50 instantanés, égalité structurelle), presse-papiers JSON
  étiqueté (entre workflows, coller avec connexions, coller un extrait Comfy passe par
  l'importeur), registre `workflow/commands.ts` qui nourrit barre, menus, raccourcis
  **et la palette ⌘K existante** (`Sidebar.tsx:262`). Annuler, copier, coller passent
  par les événements DOM `copy/paste/cut` car le menu Édition natif les intercepte
  (`lib.rs` ~1608) ; vérifié dans la vraie app, pas seulement Chromium. ⌘W et ⌘, ne
  sont pas pris.
- **C2** Recherche de nœuds au double-clic ou `/` (score flou maison, catégories,
  carte d'aperçu), nœud placé au curseur ; **relâcher un lien dans le vide** ouvre la
  recherche filtrée par le genre et branche le nœud (`resolveInputPort`) ; lâcher sur
  le corps d'un nœud colle au bon port.
- **C3** Barre de sélection (`NodeToolbar`), reconnexion et suppression d'arête,
  couleur par genre (tokens `--kind-*`, contraste validé deux thèmes), arêtes animées
  seulement pendant un lancement, minicarte par statut, grille aimantée,
  aligner/distribuer.
- **C4** Ranger (couches maison depuis les dépendances, curseur d'écart en direct),
  nœud compact sous le zoom 0,5, réduire, épingler, couleur, nœud relais. Porte :
  graphe de 150 nœuds fluide.

### Phase D · Provenance et compatibilité Comfy (R2)

- **D1 Provenance** : `ArtifactOrigin` gagne `surface: "workflow"` (workflowId,
  runId, nodeId), envoyé en `client_context` à `media_job_queue`, accepté par
  `apply_landed_context` (`image_refine.rs:211`), passé par les trois chemins webview
  (`durableMediaRunner`, sauvetage de `dismissWorkflowRun`, `SaveMediaMeta`). La
  visionneuse propose « Ouvrir le workflow qui l'a fait » ; glisser un fichier de la
  galerie sur le canevas crée un nœud asset.
- **D2 Lecture des fichiers Comfy** : PNG (tEXt et iTXt via `DecompressionStream`),
  WebP, métadonnées vidéo, sans dépendance, plafond de 5 Mio respecté.
- **D3 Écriture à l'export** (desktop, nouveau module Rust, **activable**, car le
  fichier emporterait tous les prompts du graphe hors de l'appareil).

### Phase E · Organisation et nouveaux nœuds (R3)

- **E1 Cadres et notes** (addendum ADR-0075 : les notes d'un fichier deviennent des
  nœuds Note, plus seulement la description).
- **E2 Blocs (ADR-0116)** : `definitions.blocks[]`, créer depuis la sélection
  (⇧⌘E), dégrouper, fil d'Ariane, réglages promus ; `flatten.ts` avec ids
  `instance/interne` et table d'affichage (progression, prix, cache, erreurs remontent
  sur le bloc). Un lancement gèle **le graphe écrit, le graphe aplati et la table
  d'affichage**, pour que « Rouvrir ce lancement » montre le bloc. Blocs publiés =
  lignes `studio_workflows` d'origine `block` (sans migration, synchronisés avec les
  workflows).
- **E3** Les 8 blocs livrés (image vers vidéo avec dernière image, améliorer un
  prompt, deux plans enchaînés, voix plus musique plus mix, planche 3×3, détourer,
  agrandir, retouche de zone).
- **E4 Nœuds logiques** : gabarit de texte, aperçu, aiguillage paresseux **chiffré à
  sa branche la plus chère**, conversion d'un réglage en entrée **limitée aux réglages
  textuels et aux listes fermées chiffrées au plus cher** (le modèle et la durée
  pilotent ports et prix, ADR-0022).
- **E5 Nœuds média** réutilisant le Studio : agrandir, détourer, retouche de zone,
  planche du Composer, comparaison avant/après ; tous `paid`.
- **E6 Listes (ADR-0117, remplace l'addendum ADR-0021 sur les prises)** :
  `set_workflow_run_node` devient un upsert (nouveau module Rust, la clé TEXT accepte
  `#`) ; chaque élément `nœud#i` a sa ligne, son job, sa signature. Un nœud liste
  **déclare un maximum, chiffré au maximum, avec `beforeNode` par élément**. ADR-0117
  fixe la règle par port : un port multiple (clips d'assemblage, références) reçoit la
  liste étalée, un port simple fait répéter le nœud ; `productionCut` et les gates
  adressent les éléments.

### Phase F · Bibliothèque, synchro, appli, assistant (R3 puis R4)

- **F1 Versions (migration 081)** : ⌘S « Enregistrer une version », une version par
  lancement, résumé des différences, restauration.
- **F2 Synchro (ADR-0118)**, après A3, E2 et E6 pour que la forme soit finale :
  `studio_workflows` dans `sync_tables.rs` en genre `settings`, ids UUID à la création
  (les anciens sont réécrits une fois), refus au-delà de 1 Mio par révision,
  rattrapage explicite au premier inventaire (comme `saved_items`), autosave regroupé
  pour ne pas inonder l'outbox, rechargement du store sur `subrosa://sync-updated`.
  Le cache B1 reste local. Contrat et `account/README.md` mis à jour.
- **F3** Onglets de workflows avec statut en arrière-plan et vignette au survol.
- **F4 Modèles** : catégories, couverture qui se fond dans un vrai résultat au survol,
  puce Appli ou Graphe, fourchette de prix, couverture de « Try it on », modèles
  résolus dans le catalogue vivant, 7 → 15 modèles.
- **F5 Import Comfy v2** : sous-graphes → blocs, groupes → cadres, relais → relais,
  primitives → réglages en entrée, table des nœuds partenaires régénérée depuis
  `comfy_api_nodes/` (`scripts/comfy-partner-map.mjs`, liste figée) ; rapport
  d'import toujours obligatoire.
- **F6 Mode appli, desktop (ADR-0119)** : constructeur en trois temps (exposer,
  choisir les sorties, ordonner) stocké dans `workflow.app` ; vue formulaire générée
  par `ParamField` ; bascule Graphe/Appli.
- **F7 Surfaces de lancement sur téléphone** : bannière de reprise, approbation des
  gates, `RunCostDialog` partagé, vidéo et audio lus par le schéma `subrosa-media:` au
  lieu d'être chargés entiers en base64.
- **F8 Applis sur téléphone** : ADR-0119 place « Applis » dans le Studio mobile (un
  segment à côté d'image, vidéo, audio, galerie), jamais le canevas. L'écran dit que
  l'assemblage demande l'app ouverte (ADR-0021). Règles `mobile-native`, essai sur
  vrai iPhone et APK Android.
- **F9 Assistant (ADR-0120)** : un outil `workflows` dans `june_studio_mcp.py` et
  `studio_actions.rs` (donc aussi agent-lite) : lister, lire, proposer. Studio ouvert :
  la proposition s'affiche en fantôme, à accepter ou écarter (ADR-0038). Studio fermé :
  un nouveau brouillon d'origine `assistant`, jamais la modification d'un workflow
  existant. Lancer reste un geste humain passant par `RunCostDialog`. Docstring
  « Six tools » corrigée.
- **F10** Matrice de parité close : zéro ligne « à faire ».

### Refus explicites (dans la matrice, avec leur raison)

- Exécuter des graphes Comfy, nœuds Python, serveur local (ADR-0075).
- API d'extensions avec du JS tiers (CSP, ADR-0039).
- LiteGraph (Comfy lui-même passe aux nœuds DOM, « Nodes 2.0 »).
- « Lancer à chaque modification » et mode instantané : dépense continue.
- Liens masqués à pastilles, liens flottants, 3D, peinture de masque (la retouche de
  zone couvre le besoin), hub public, 14 langues.

### Train de releases

| Release | Contenu | Gain |
|---|---|---|
| R1 | A1 à B5 | Ne plus repayer, rendus fiables, partiel, prix et ETA |
| R2 | C1 à D3 | Canevas au niveau de Comfy, provenance, fichiers Comfy |
| R3 | E1 à F5 | Blocs, listes, nouveaux nœuds, versions, synchro, modèles |
| R4 | F6 à F10 | Appli desktop et téléphone, assistant, parité close |

Chaque release : bump manuel de `tauri.conf.json`, `src-tauri/Cargo.toml`,
`package.json`, tag, desktop, TestFlight (`-f ref=vX.Y.Z`), Android, téléchargements
du site.

### Vérification

- Par PR : portes communes ci-dessus, tests vitest et Rust du lot, captures.
- Essais réels contre Carpe Diem avec des modèles bon marché : cache (solde inchangé
  au second lancement), 429 renvoyé après `Retry-After`, liste de 3 images, devis
  vidéo comparé au badge, reprise après fermeture de l'app.
- Synchro : harnais deux appareils (ADR-0108/0109), dont un appareil à l'ancien
  format qui ne doit rien écraser.
- Téléphone : simulateur puis vrai iPhone, APK Android.
- Fin : `docs/comfy-parity.md` sans « à faire », test qui le garantit.

### Notation v3 : 10/10

| Critère | Note | Ce qui l'obtient |
|---|---|---|
| Qualité | 10 | Chaque idée Comfy est adaptée à des modèles payants et non déterministes (double signature, prise et graine, badge « Réutilisé », prix qui exclut le cache, aiguillage et listes chiffrés au maximum), avec des mesures de réussite (solde inchangé, 150 nœuds fluides) et des points où Sub Rosa dépasse Comfy (cache visible, reprise durable, ETA locale, assistant qui propose sans appliquer, applis sur téléphone). |
| Intégration | 10 | Les 33 défauts de la relecture sont corrigés : pas de migration inutile, partiel après le cache, sémantique des gates écrite et optionnelle pour `ProjectStudio`, upsert pour les listes, journal des durées qui survit, provenance par le Rust, synchro qui ne peut pas écraser, plafonds de fichiers respectés, six langues, numérotation vérifiée, PR de taille réaliste. |
| Pertinence | 10 | Couvre les 15 idées d'éditeur et les 10 idées de moteur retenues, plus téléphone, synchro, fiabilité 429 et import des fichiers Comfy ; refuse le reste avec sa raison ; la matrice testée rend « pas en retard sur Comfy » vérifiable. |
