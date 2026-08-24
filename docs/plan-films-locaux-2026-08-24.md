# Plan — la production de films devient locale (retrait de Videomaker)

> Conception. La spec exécutable par vagues est dans
> [IMPLEMENTATION-films-locaux-2026-08-24.md](IMPLEMENTATION-films-locaux-2026-08-24.md).
>
> Date : 2026-08-24. État : proposé, non commencé.

## Résumé

Sub Rosa produit aujourd'hui ses films via **Videomaker Studio**
([ADR-0010](adr/0010-videomaker-film-production.md)), un service distant qui
possède son propre wallet, sa propre authentification SIWE, son propre rail de
facturation DIEM et son propre run driver. Ce plan le retire, et fait produire
les films **par l'app, sur la machine de l'utilisateur, payés en crédits Carpe
Diem, à partir d'une note**.

Le retrait n'est pas un nettoyage : c'est l'achèvement de
[ADR-0017](adr/0017-product-autonomy-from-june.md). Une fois fait, **le binaire
ne contacte plus que Carpe Diem**.

Cinq livraisons, dans cet ordre, dont la dernière est la suppression :

| | Livraison | Pourquoi dans cet ordre |
|---|---|---|
| R0 | Gel et rapatriement | Seule fenêtre où le code Videomaker doit encore marcher |
| R1 | Finition locale (mix + export timeline) | **Bloquant** : sans elle, retirer Videomaker retire la seule façon d'obtenir un film mixé |
| R2 | La bible et les juges | Remplace l'asset pack serveur et la crew |
| R3 | Du script au film | Remplace le run driver, par compilation vers un moteur existant |
| R4 | Le retrait | Suppression, resserrement de la CSP, garde-fou d'hygiène, supersession d'ADR |

## 1. Pourquoi

[ADR-0017](adr/0017-product-autonomy-from-june.md) pose que l'autonomie produit
est **appliquée, pas seulement voulue** : OS Accounts supprimé, `june_api_url()`
sans repli distant, `repository-hygiene.yml` qui casse toute PR réintroduisant
les coordonnées amont.

Videomaker est la contradiction restante. Le binaire contacte
`studio.furetier.com`, avec une identité (wallet secp256k1, message SIWE, PAT
`vmk_`), une monnaie (DIEM) et un cycle de vie (runs, gates de phase, daemon par
slug) qui ne sont ni ceux de l'app ni ceux de Carpe Diem.

Trois faits achèvent l'argument.

**C'est gelé.** Le dernier travail fonctionnel sur la surface Films date de la
série v1.26 ; l'app est en v1.45. Depuis, `src-tauri/src/videomaker/` n'a été
touché qu'incidemment (numérotation des références, passage de la galerie).

**Ça coûte cher à héberger dans l'app.** Chiffres relevés le 2026-08-24 :

| Poste | Mesure |
|---|---|
| Rust | `src-tauri/src/videomaker/` ≈ 3 100 lignes sur 9 fichiers |
| MCP | `src-tauri/src/hermes/june_films_mcp.py`, 726 lignes |
| Frontend | `src/lib/films/` ≈ 640 lignes + 4 composants Studio + 1 panneau de réglages |
| Surface Tauri | **33 commandes** (`lib.rs:424-456`), toutes dans la liste desktop |
| Dépendances Rust | `hex`, `k256`, `sha3` (`Cargo.toml:87-92`), uniquement pour la signature SIWE |
| CSP | `img-src` et `media-src` élargis à `https:` (`tauri.conf.json:80`) pour les URLs signées de Videomaker |
| Prompt | Un paragraphe entier du SOUL Hermes (`hermes_bridge.rs:204`) sur les budgets DIEM et les gates serveur |

**Ça a coûté cher à maintenir.** Les modes de panne sont documentés et ont tous
été compensés côté app : 402 de rail qui flappe, 503 de capacité provider,
gateway redémarré qui tue un run en vol, wedge `_approve_storyboard`, 422 sur
`POST /model-prefs`, devis de production noyé dans l'enveloppe `detail` de
FastAPI, cycle de vie des runs invisible dans l'UI.

## 2. Ce qu'on perd, et ce qu'on en fait

| Apport de Videomaker | Après retrait |
|---|---|
| **Run autonome côté serveur** : on ferme l'app, le film se fait | **Perte partielle, bornée, assumée.** Les rendus — les minutes et l'argent — sont déjà des lignes `media_jobs` re-pilotées par Rust ([ADR-0018](adr/0018-ios-background-work-is-durable-rows.md)) : ils survivent à la fermeture, à la suspension iOS, au redémarrage. Ce qui exige une session au premier plan, c'est le **raccord** entre plans chaînés et la finition ([ADR-0021](adr/0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md)). Deux mitigations de conception : compiler le graphe pour que tous les rendus indépendants partent d'un coup, et faire de la finition une passe unique en fin de course. Un film de 30 plans à 5 chaînes demande environ 5 retours, pas 30 |
| **Assemblage ffmpeg côté serveur** (`final_mixed.mp4`) | **Remplacé, et par mieux** : mix pré-rendu en `OfflineAudioContext` (déterministe, reproductible, sans gigue temps réel) et export timeline NLE (sans perte). C'est R1, et le retrait en dépend |
| **La crew à 14 rôles** | **Remplacée par la boucle qui comptait.** Le plan qualité du 2026-07-16 avait déjà tranché : le P0 n'était pas le nombre de rôles, c'était la **boucle de feedback manquante** (juge holistique, juge esthétique, gate narratif). En local : gate jugé sur les panneaux **et** juge de film sur une planche-contact de frames échantillonnées depuis l'aperçu assemblé — `frames.ts` sait déjà extraire, scorer et garder la plus nette |
| **Rail DIEM et wallet** | **Simplification pure.** Un rail, une clé `cdm_`, plus de SIWE, plus de PAT, plus de plafond DIEM à négocier dans le prompt de l'agent |
| **Le mode réalisateur** (chat, gates, board, takes) | **À rapatrier, surtout pas à jeter** : c'est la meilleure UI du lot, et chaque pièce a déjà un équivalent local. Les gates sont le nœud `gate` ; les takes sont les branches de chaîne (`alternativeCount`, [ADR-0019](adr/0019-shot-chains-are-parent-links.md)) ; le board est la galerie filtrée par run ; le chat est l'agent avec le nouveau MCP Studio |

## 3. Les cinq leçons à transférer

Supprimer 3 100 lignes supprime aussi la connaissance achetée par les incidents.
Ces cinq points doivent migrer **explicitement** vers le run de workflow local,
sinon on rachètera les mêmes pannes.

1. **Un 402 de rail ou un 503 de capacité n'est pas un échec de nœud.**
   Le run driver de Videomaker a dû apprendre à temporiser (15 s → 120 s
   plafonné, ~20 essais) et à retenter la même phase plutôt que compter un
   stall. Le runner local doit faire pareil. Sans ça, le premier flap Carpe Diem
   détruit une production entière. Ne pas reclasser un 5xx en « occupé »
   ([ADR-0012](adr/0012-upstream-rate-limit-distinct-from-provider-failure.md)).
2. **La reprise est basée sur l'état et ne rachète jamais l'acquis.**
   Déjà vrai localement (ADR-0021 : cache `completed`, ré-attachement des jobs
   par id). À préserver sous peine de régression coûteuse.
3. **Un run en pause, échoué ou interrompu ne doit jamais avoir l'air inactif.**
   C'était l'un des trois P0 de l'audit du 2026-07-25 : `videomakerListRuns`
   n'était jamais appelé, et un projet bloqué ressemblait à un projet au repos.
   Le bandeau de run local existe ; vérifier qu'il couvre tous les états, pas
   seulement `interrupted`.
4. **Enveloppe de dépense dure.** L'idée du `budget_diem` : une enveloppe qui
   borne le *travail*, pas seulement l'enqueue. Un graphe compilé refuse de se
   compiler au-dessus du plafond et propose de réduire.
5. **Aucun chemin ne dépense sans avoir affiché un chiffre.** Le bug
   `flatten_quote` avait rendu le handshake de production muet pendant des
   semaines. Il n'y a plus d'enveloppe FastAPI en local, mais la règle survit.

## 4. Les livraisons

### R0 — Gel et rapatriement

La seule fenêtre où le code Videomaker doit encore fonctionner. Videomaker passe
en **lecture seule** (plus de création de projet, plus de nouveau run) et gagne
une action **« Ramener mes films »** qui télécharge masters, plans et références
dans la galerie, puis crée **une note par film** portant son brief et sa
transcription de production.

C'est la doctrine de [ADR-0026](adr/0026-imported-media-is-decoded-in-process.md)
appliquée telle quelle : *un film rapatrié est une note*. Donc il reste
cherchable, lisible par l'agent et éligible à l'extraction de mémoire une fois
Videomaker parti. Aucun nouveau nom de produit, aucune seconde surface.

### R1 — Finition locale (bloquant)

Deux morceaux, aucun ne requiert ffmpeg.

**L'export timeline NLE.** FCPXML 1.10 (plus sa variante Resolve), Premiere
xmeml v5, et un `.srt` compagnon qui remplace le burn-in de sous-titres. C'est de
la génération de texte au-dessus d'une cut list que `chainCuts` produit déjà, et
de durées mesurées par le décodeur du webview. Disposition des pistes : V1 pour
les plans (audio de segment coupé), A1 dialogue, A2 SFX, A3 musique.

Ça débloque le vrai plafond du produit : l'étalonnage, les transitions et le mix
fin partent dans Resolve. C'est aussi la réponse définitive à « il nous faudrait
ffmpeg ».

**Le mix multi-pistes hors-ligne.** `assemble.ts` mixe aujourd'hui l'audio des
plans plus une piste de fond à gain fixe. La v2 pré-rend **tout le mix** dans un
`OfflineAudioContext` — dialogue, SFX, musique, son des plans — en un seul
`AudioBuffer` déterministe, que MediaRecorder n'a plus qu'à porter avec la vidéo.
C'est strictement meilleur que la chaîne ffmpeg de référence : plus de gigue
temps réel sur l'audio, et un mix reproductible.

Dedans : automation de gain par points (`setValueAtTime` /
`linearRampToValueAtTime`), ducking déterministe piloté par les fenêtres de
dialogue mesurées plutôt que par un compresseur, mesure de loudness par
pondération K ITU-R BS.1770 (high-pass + high-shelf en Biquad) pour une
normalisation unique, fondus de 30 ms aux coupes, et ordonnancement global du
dialogue sans recouvrement à partir des durées TTS **mesurées**.

### R2 — La bible et les juges

**La bible** est l'ensemble des identités persistantes d'une production :
personnages, lieux, accessoires, look. Une entrée porte un nom, des traits
invariants, et des **références qui sont des artefacts de la galerie** —
[ADR-0020](adr/0020-the-gallery-is-the-studio-exchange-format.md) s'applique tel
quel, aucun nouveau stockage de média. Un personnage porte en plus une voix,
choisie par audition parmi quelques échantillons TTS, qui part ensuite en
`reference_audio_urls`.

C'est ce qui manque aujourd'hui : Sub Rosa sait attacher des références à un
rendu, mais rien ne les fait persister d'une session à l'autre.

**La discipline de prompt** vient avec, et c'est le gain le moins cher du plan :
prompts seedance sous 60 mots en structure Sujet / Action / Caméra / Style /
Contraintes, ordre canonique du stack de références (angle principal du
personnage, plan de blocking, lieu large puis moyen puis détail, personnages
secondaires), ré-énoncé des traits invariants à chaque plan, séparateur
« Lens switch. » pour grouper deux ou trois beats en une seule génération. La
bible sait produire tout ça toute seule.

**Les juges.** Le nœud `gate` gagne un mode : humain, jugé, ou jugé puis humain.
Un gate jugé appelle un modèle vision avec les panneaux, l'intention du plan et
les portraits de la bible, et rend une note plus une liste de plans faibles. Le
correctif d'un panneau est le nœud `imageEdit` existant, amorcé avec la note du
juge — et le multi-images est disponible depuis le 2026-07-07
(`composeImages()`, voir
[carpe-diem-multi-image-edit-request.md](carpe-diem-multi-image-edit-request.md)).

Au-dessus : le **juge de film**, qui regarde une planche-contact de frames
échantillonnées dans l'aperçu assemblé et propose des retakes ciblés. C'est lui
qui remplace la crew.

Tout cela est best-effort : un juge en échec dégrade en gate humain, jamais en
erreur.

### R3 — Du script au film

Le script est une note. La **shot list** est une ligne dérivée sur cette note,
sur le modèle exact des résumés long format
([ADR-0027](adr/0027-long-form-summaries-are-a-fork-side-map-reduce-over-turns.md)) :
prompt fork-side avec sa propre version, map-reduce par parties, reprise partie
par partie, annulation en supprimant la ligne. **Aucune route ajoutée à
`june-api/`** — chaque ligne y est une ligne que `upstream-sync.yml` re-fusionne
pour toujours.

**L'app tient l'horloge et le routage.** Le modèle rend une classe de mouvement
et une liste de personnages ; c'est l'app qui choisit le modèle vidéo, la durée,
le ratio, depuis `model-constraints.ts`
([ADR-0022](adr/0022-model-inputs-follow-published-constraints.md)). Un index
hors bornes est clampé, jamais cru.

Puis **la shot list compile en graphe workflow** : plans en nœuds `video`, plans
enchaînés en `lastFrame`, références de bible en nœuds `asset`, répliques en
`tts`, score en `music`, fin en `assemble` et `output`. À partir de là ce n'est
plus qu'un workflow : run durable, estimation de coût, gates, reprise,
notifications, et rendu mobile en Flows — **tout hérité, zéro runtime neuf**.

C'est le cœur du plan. On ne remplace pas le run driver de Videomaker par un
autre run driver : on compile vers un moteur qui existe, qui est durable, et qui
est déjà payé.

**La surface agent** change de nom en même temps : `june_studio` remplace
`june_films` dans le SOUL Hermes. Il est action-discriminé (`bible`, `script`,
`shots`, `render`, `cut`, `inspect`) plutôt que granulaire, ce qui tient la
surface autour de 700 tokens toujours chargés au lieu de plusieurs milliers ; le
savoir détaillé part dans un skill chargé à la demande. La bascule doit être
atomique : l'agent ne doit jamais se retrouver sans outil de film.

Le **mode réalisateur** est rapatrié sur le canvas à ce moment-là : gates, board,
takes, chat.

### R4 — Le retrait

Une livraison, pas un nettoyage de fin de sprint. Suppression du module Rust, du
MCP, de la route proxy, des composants, du panneau de réglages, des 33
commandes, des trois dépendances de signature.

Trois points la rendent *exécutoire* plutôt que simplement souhaitée :

**La CSP se resserre.** `https:` sort de `img-src` et `media-src`. Vérification
faite le 2026-08-24 : tous les autres consommateurs d'images et de médias passent
par `asset:`, `data:` ou `artifactSrc`. C'est un gain de sécurité concret et
testable.

**`repository-hygiene.yml` gagne un motif interdit.** Même mécanique que les
gardes June d'ADR-0017 : `furetier\.com|vmk_|videomaker|DIEM` hors allowlist fait
échouer la PR. Sans ce garde-fou, un sync amont ou un futur agent peut
réintroduire la dépendance par mégarde.

**Les ADR sont supersédés, pas réécrits.** ADR-0010 et ADR-0011 sont
append-only. On écrit un nouvel ADR qui les supersède nommément et récapitule les
cinq leçons transférées.

## 5. Ce qu'on prend au design de référence

`jordanurbs/venice-video-mcp` et son harness (MIT, dernier push 2026-08-05) sont
lus comme **un design de référence, pas une dépendance** : le harness est un CLI
Node qui exige ffmpeg et ffprobe sur le PATH et parle à Venice avec une clé
directe — incompatible avec ADR-0021 (pas de ffmpeg), ADR-0018 (pas de
sous-processus sur iOS) et ADR-0017 (une seule infrastructure).

Ce qu'on en retient, comme idées : la disposition des pistes à l'export NLE, la
discipline de prompt et l'ordre du stack de références, l'idée d'identités
verrouillées avec voix donneuse, le gate de QA vision avant la dépense vidéo,
l'ordonnancement global du dialogue sur durées mesurées, les fondus de 30 ms, et
la forme d'outil action-discriminée pour l'agent.

Aucun code n'est repris. Si le squelette FCPXML devait l'être, le crédit va dans
`FORK_NOTES.md`. Conformément aux conventions de PR du dépôt, les descriptions
restent génériques et ne nomment pas de produit tiers.

## 6. Non-objectifs

- **Pas de ffmpeg**, jamais. C'est re-tranché ici pour la troisième fois.
- **Pas de harness Node embarqué**, pas de sous-processus supplémentaire.
- **Pas de burn-in de sous-titres** : un `.srt` compagnon, gratuit.
- **Pas d'étalonnage, pas de filtres, pas de transitions rendues** : c'est
  précisément ce que l'export NLE délègue.
- **Pas de `finish` 4K par segments remuxés.**
- **Pas de pipeline autonome local** en doublon de ce qui est supprimé.
- **Pas de portage du serveur Videomaker** : il survit comme produit indépendant
  dans son propre dépôt, il cesse seulement d'être une dépendance de Sub Rosa.

## 7. ADR à écrire

Numérotation à partir de 0029 (plus haut existant : 0028).

| N° | Titre | Contenu |
|---|---|---|
| 0029 | La production de films est locale | Supersède ADR-0010 et ADR-0011. Pourquoi le retrait achève ADR-0017, ce qui est perdu, et les cinq leçons transférées |
| 0030 | Une production se compile en workflow | Pourquoi pas un troisième moteur d'exécution. La shot list est une entrée du moteur, pas un runtime |
| 0031 | L'export timeline est le chemin de finition | MediaRecorder devient un aperçu. Comment on obtient enfin une sortie sans perte sans ffmpeg |
| 0032 | La bible est locale, faite de lignes au-dessus d'artefacts galerie | Pourquoi pas une table de médias, et comment elle remplace l'asset pack serveur |
| 0033 | Le mix est rendu hors-ligne en Web Audio | Pourquoi c'est meilleur que ffmpeg ici, pas seulement moins cher |

Écrire 0029 et 0031 avant R1 ; 0032 avant R2 ; 0030 et 0033 avant R3 et R1
respectivement.

## 8. Vocabulaire (CONTEXT.md)

La section « Film production (fork) » est réécrite en R4.

**Sortent** : Videomaker, Film project, Run (au sens Videomaker), Phase gate,
DIEM, Studio wallet.

**Restent, rattachés aux chaînes** : Shot, Take.

**Entrent** :

- **Bible** — les identités persistantes d'une production. Une **entrée de
  bible** a un genre : `character`, `location`, `prop`, `look`.
- **Shot list** — la décomposition en plans dérivée d'une note de script. Ce
  n'est pas un scénario et ce n'est pas un graphe : c'est ce qui se compile en
  graphe.
- **Timeline** — le fichier d'échange NLE. Distinct de la **cut list** (la
  structure interne, qui existe déjà) et du **mix** (le rendu audio hors-ligne).
- **Juge** — une passe d'évaluation par modèle sur un panneau, un plan ou un
  film. Rend une note et des faiblesses, jamais un blocage.

**`_Avoid_`** : « Videomaker », « DIEM », « pack d'assets », « run serveur », et
« média » pour désigner un plan.

## 9. Résultats des sondes (vague 0, exécutée le 2026-08-24)

| Sonde | Résultat |
|---|---|
| Modèle vision acceptant N images en un tour | **PASS.** `kimi-k3` a lu 4 images en une requête et les a rendues dans l'ordre. 1 789 tokens de prompt pour 4 vignettes 64x64. Les juges de panneau et de film sont faisables |
| `/video/quote` | **PASS** sur les familles text-to-video de kling, seedance et wan. Réponse `{"quote": 0.69}`. **Piège** : `duration` est une chaîne (`"5s"`), un nombre renvoie un 400 `Invalid request parameters` |
| MediaRecorder mp4 en WKWebView réelle | **NON TESTÉ** — demande un build sur appareil et une vérification manuelle. Le repli est déjà en place : l'export timeline ne dépend pas du recorder |

**Contrainte budgétaire relevée le 2026-08-24** : le solde Carpe Diem est de
0,72 USDC disponible, contre 0,55 à 0,95 USDC **par plan de 5 s**. Aucun rendu
vidéo réel n'est possible pendant le développement. Toute la vérification passe
donc par les smokes sans clé, ce pour quoi la spec est conçue.

**Modèles vidéo au 2026-08-24** : `seedance-2-0` n'existe plus tel quel. Les ids
courants sont suffixés (`seedance-2-0-text-to-video-basic`,
`wan-2-7-text-to-video`, `kling-v3-standard-text-to-video`). Ne jamais coder un
id en dur : passer par le catalogue, comme le fait déjà `catalog.ts`.

## 10. Risques ouverts

**La production vraiment sans surveillance.** Si, après R3, les retours au
premier plan pour les raccords se révèlent pénibles à l'usage, l'escalade existe
et elle est nommée : un extracteur de frame côté Rust via les décodeurs de
plateforme (VideoToolbox sur Apple, Media Foundation sur Windows). Ça rouvre
l'option qu'ADR-0021 avait rejetée, mais sous une prémisse nouvelle puisque
Videomaker n'est plus là pour l'assumer. **Ne pas l'entreprendre par
anticipation** : c'est deux implémentations natives, et le besoin n'est pas
mesuré.

**L'export MediaRecorder en WKWebView réelle** reste non revalidé depuis le
2026-07-20 (mp4 attendu, jamais confirmé sur appareil). R1 doit le vérifier avant
de promettre l'export mobile. Repli : l'export timeline, qui n'en dépend pas.

**La qualité de la shot list.** Un map-reduce local est plus mince qu'une crew de
14 rôles. Le pari du plan est que la boucle de juges compte plus que le nombre de
rôles — c'est ce que disait déjà l'analyse du 2026-07-16, mais ça n'a jamais été
mesuré en local. Premier point à évaluer après R3.

**Des films encore sur le VPS au moment de R4.** R0 existe pour ça, mais elle
dépend d'un service qui doit être debout. Ne pas planifier R4 tant que R0 n'a pas
été exécutée avec succès au moins une fois sur des données réelles.
