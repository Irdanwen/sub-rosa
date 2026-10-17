# Demandes à l'équipe Carpe Diem — parité média (fond transparent + quote vidéo)

> À transmettre à l'équipe Carpe Diem. Ces deux points sont sortis d'une passe de
> parité de Sub Rosa avec le studio de Venice (2026-07-20). Tous les tests
> ci-dessous ont été faits en réel avec une clé `cdm_` valide sur
> `https://carpe-diem.xyz/api/operator/v1`.

## 1. Exposer la suppression d'arrière-plan (`/image/background-remove`)

### Le besoin

Produire un détourage : une image en entrée → un PNG à fond transparent (canal
alpha). Venice l'expose nativement via `POST /image/background-remove` ; le studio
de Venice en fait un mode à part entière (« Supprimer l'arrière-plan »). Sub Rosa
veut le même bouton, mais le proxy opérateur ne l'expose pas.

### Ce qui bloque aujourd'hui (vérifié le 2026-07-20)

Le modèle `bria-bg-remover` **figure dans votre catalogue** `/v1/models`
(`carpe_diem_type:"image"`), mais **aucune route ne l'accepte** :

| Requête | Résultat |
|---|---|
| `POST /image/background-remove {image:"data:…"}` | `404 {"error":"Not Found","message":"Route POST:/v1/image/background-remove not found"}` |
| `POST /image/background-remove/queue` | `404` |
| `POST /image/edit {model:"bria-bg-remover", prompt, image}` | `400 {"error":"Invalid model id","code":"VENICE_ERROR"}` |
| `POST /image/edit/queue {model:"bria-bg-remover", …}` | `202 {queue_id}` puis `retrieve` → `400 "Invalid model id"` |
| `POST /image/generate {model:"bria-bg-remover", image, prompt}` | `400 {"error":"Image generation failed","code":"VENICE_ERROR"}` |

Conclusion : `bria-bg-remover` est **listé mais non routable**. Il n'existe aucun
moyen de détourer une image via l'opérateur.

### Ce qu'on demande (une des deux options)

#### Option A (préférée) — exposer `/image/background-remove` en miroir de Venice

```
POST /v1/image/background-remove   {image:"data:image/…;base64,…"}   → binary image/png (alpha)
```

Contrat attendu (identique à Venice) :

- `image` : **soit** un data URI / base64 (comme `/image/edit`), **soit**
  `image_url` (https), mais pas les deux.
- Réponse : PNG binaire avec canal alpha.
- Facturation : au succès, comme les autres opérations image.

C'est exactement le schéma que vous avez déjà appliqué pour `/image/multi-edit`
(demandé en juillet, livré en miroir de Venice) — même approche ici.

#### Option B — router `bria-bg-remover` sur une route existante

Si vous préférez ne pas ajouter d'endpoint : faire accepter `bria-bg-remover`
comme `model` sur `/image/edit` (ou `/image/generate`) avec l'image en entrée et
sans prompt, et le transmettre au modèle Bria amont. Moins propre (le détourage
n'est pas une édition pilotée par prompt), mais évite un nouvel endpoint.

### Point de vérification pour vous

- Soit exposer une route qui accepte `bria-bg-remover`, **soit** le retirer de
  `/v1/models` : aujourd'hui il est annoncé aux clients mais provoque une erreur
  quel que soit le chemin, ce qui est trompeur.

### Côté Sub Rosa (déjà prêt)

`removeBackground()` dans `src/lib/studio/edit-image.ts` appelle déjà
`/image/background-remove`. Le mode « Cutout » (desktop + mobile + action dans la
lightbox) est en place mais **gaté sur le backend Venice** via
`supportsBackgroundRemoval()`. Il s'allumera tout seul sur Carpe Diem dès que la
route répondra — rien d'autre à faire côté client.

## 2. `/video/quote` refuse les familles video-to-video et upscale vidéo

### Le comportement observé (vérifié le 2026-07-20)

`POST /video/quote` renvoie bien un devis pour text-to-video, image-to-video et
reference-to-video (y compris avec `negative_prompt`, `reference_image_urls[]`,
`image_url` + `end_image_url`). Mais il **échoue systématiquement** sur les
familles qui prennent une vidéo en entrée, même avec un payload valide :

| Requête sur `/video/quote` | Résultat |
|---|---|
| `{model:"wan-2-7-video-to-video", prompt, duration:"5s"}` | `{"error":"Video quote failed","code":"VENICE_ERROR"}` |
| `{…, video_url:"data:video/mp4;base64,…"}` (v2v) | idem `Video quote failed` |
| `{model:"happyhorse-1-0-video-to-video", …}` | idem |
| `{model:"topaz-video-upscale", video_url, upscale_factor:2, duration:"Auto"}` | idem |

C'est le même symptôme que les modèles `ltx-*`, pour lesquels le quote a toujours
400. Ces familles sont pourtant bien au catalogue (`carpe_diem_type` `video`).

### Ce qu'on demande

- Soit faire fonctionner `/video/quote` pour les familles `*-video-to-video` et
  `*-video-upscale` (idéalement en acceptant un `video_url` court, voire une
  estimation sans la vidéo).
- Soit **documenter** que le quote n'est pas disponible pour ces familles (comme
  pour `ltx-*`), pour qu'on puisse les exclure proprement côté client sans
  deviner. Aujourd'hui on le déduit d'un message d'erreur générique.

### Question annexe — contrat exact du video-to-video

La doc Venice décrit `video_url` (data URL, MP4/MOV/WebM) pour l'entrée v2v et
`upscale_factor` (1/2/4) + `duration:"Auto"` pour l'upscale. Pouvez-vous
**confirmer que le proxy opérateur transmet bien ces champs** à
`/video/queue` pour `wan-2-7-video-to-video`, `happyhorse-*-video-to-video` et
`topaz-video-upscale` ? On n'a pas encore lancé de rendu réel (0,4 à 10 $/job) et
on aimerait valider le contrat avant.

### Côté Sub Rosa (déjà prêt)

Le studio vidéo desktop a maintenant quatre directions dont « From video » (v2v +
upscale Topaz) : `src/components/studio/VideoStudio.tsx`, contrat construit dans
`bodyForModel()`. `supportsVideoQuote()` (dans `src/lib/studio/paths.ts`) exclut
déjà ces familles du quote pour éviter le message d'erreur. On lèvera cette
exclusion dès que le quote répondra.

## 3. Une clé d'idempotence sur les requêtes payantes (2026-10-17)

### Le besoin

Quand une soumission payante (`POST /video/queue`, `/audio/music/queue`,
`/image/*/queue`) reçoit une 5xx ou une coupure réseau, Sub Rosa ne sait pas si
le travail a été accepté et facturé. Il ne réessaie donc jamais, et la personne
doit vérifier son historique. Les refus définitifs (402, 429) sont, eux,
désormais resoumis automatiquement (ADR-0114).

### Ce qu'on demande

- Accepter un en-tête `Idempotency-Key: <uuid>` sur toutes les routes payantes :
  une seconde requête avec la même clé renvoie la réponse de la première au lieu
  de lancer (et facturer) un second travail. Un `409` explicite si la première
  est encore en cours.
- Renvoyer, sur la réponse et dans le relevé d'usage, une étiquette par requête
  (l'identifiant fourni par le client, ou celui du travail), pour que l'app
  puisse rapprocher le prix estimé du prix facturé.

### Côté Sub Rosa (prêt à brancher)

L'identifiant local du job (`media_jobs.id`) est déjà unique par soumission et
écrit avant l'envoi : il deviendrait la clé.

## Rappel de contexte

Le catalogue opérateur reste un **sous-ensemble** de Venice, mais les modèles
absents restent souvent exécutables en passthrough (cf.
[`carpe-diem-multi-image-edit-request.md`](carpe-diem-multi-image-edit-request.md),
résolu). Les deux points ci-dessus sont différents : `bria-bg-remover` est listé
mais **jamais** routable, et le quote v2v/upscale échoue sur des modèles pourtant
au catalogue. Merci d'avance.
