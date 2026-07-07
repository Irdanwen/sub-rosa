# Demande à l'équipe Carpe Diem — composition multi-images (« combiner des images »)

> ✅ **RÉSOLU (2026-07-07).** L'équipe Carpe Diem a livré l'**Option A** :
> `POST /v1/image/multi-edit` (+ `/queue`, `/retrieve`, `/complete`) est exposé
> côté opérateur, en miroir de Venice. Body `{model, prompt, images:[dataURI,…]}`
> (1 à 3 images, min 256×256), même sémantique async que `/image/edit` (les
> modèles lourds renvoient `409 MODEL_REQUIRES_ASYNC` → passer par `/queue`).
> Le catalogue `/v1/models` liste désormais tous les edits Venice.
> Sub Rosa est branché : `composeImages()` dans `src/lib/studio/edit-image.ts`,
> utilisé par le mode Edit du Studio mac et mobile (1 image → `/image/edit`,
> 2-3 → `/image/multi-edit`). Le reste de ce document est conservé comme trace.

> À transmettre à l'équipe Carpe Diem. Objectif : permettre à Sub Rosa (et à tout
> client de l'opérateur) de **composer plusieurs images en une seule** (2 à 3
> photos → une image éditée), ce qui est aujourd'hui impossible via le proxy.

## Le besoin

Fusionner/composer plusieurs images sources avec un prompt (ex. « mets le produit
de l'image 1 dans le décor de l'image 2 », « habille la personne de l'image 1 avec
le vêtement de l'image 2 »). Les modèles d'édition récents que vous servez déjà
(`seedream-v4-edit`, `nano-banana-pro-edit`, `nano-banana-2-edit`,
`qwen-image-2-edit`, `qwen-image-2-pro-edit`, `flux-2-max-edit`…) savent le faire
nativement en amont chez Venice — mais le proxy opérateur n'expose pas ce chemin.

## Ce qui bloque aujourd'hui (vérifié le 2026-07-06)

Base : `https://carpe-diem.xyz/api/operator/v1`. Tests réels avec une clé `cdm_`
valide :

| Requête sur `/image/edit` | Résultat |
|---|---|
| `{model:"seedream-v4-edit", prompt, images:[img1,img2]}` | `400 {"error":"Missing image data","code":"BAD_REQUEST"}` |
| `{model:"seedream-v4-edit", prompt, image:[img1,img2]}` (array) | `500 "imageBase64.startsWith is not a function"` |
| `{…, image_urls:[…]}` / `{…, reference_images:[…]}` / `{…, input_images:[…]}` | `400 Missing image data` |
| Idem via `/image/edit/queue` (nano-banana-pro-edit, gpt-image-2-edit) | `400 Missing image data` |

Conclusions :

1. `/image/edit` et `/image/edit/queue` n'acceptent qu'un **unique** champ
   `image` (string, data URI). Tout tableau ou nom de champ alternatif est
   rejeté au niveau du proxy, avant le modèle, sur tous les modèles edit.
2. `/image/multi-edit` (l'endpoint Venice qui compose 1 à 3 images) **n'est pas
   exposé** côté opérateur.
3. Passer `image` en tableau provoque un 500 (`imageBase64.startsWith`) — le
   proxy suppose une string.

Il n'existe donc **aucun** moyen de composer plusieurs images via l'opérateur.

## Ce qu'on demande (une des deux options)

### Option A (préférée) — exposer `/image/multi-edit` en miroir de Venice

Ajouter `POST /v1/image/multi-edit` proxifiant l'endpoint Venice du même nom,
avec la même sémantique async que `/image/edit` pour les modèles lourds :

```
POST /v1/image/multi-edit            {model, prompt, images:[dataURI,…]}  → binary image  (ou 202 async)
POST /v1/image/multi-edit/queue      {model, prompt, images:[dataURI,…]}  → 202 {queue_id}
POST /v1/image/multi-edit/retrieve   {queue_id, model}                    → pending JSON | binary image
POST /v1/image/multi-edit/complete   {queue_id}
```

Contrat attendu :

- `images` : tableau de **1 à 3** data URIs (`data:image/png;base64,…`), même
  encodage que le `image` de `/image/edit`.
- `model` : un modèle `carpe_diem_type:"imageEdit"` capable de multi-image.
- `prompt` : requis.
- Facturation : au succès récupérable, comme `/image/edit`.
- Limite : ≤ 5 MB par image (cohérent avec `/image/edit`).

### Option B — accepter `images[]` sur `/image/edit` pour les modèles multi-capables

Si vous ne voulez pas d'un nouvel endpoint : faire accepter par `/image/edit`
(et `/image/edit/queue`) un champ **`images` (array de data URIs)** en plus du
`image` (string) existant, et le transmettre tel quel au modèle amont quand
celui-ci est multi-image. Rétro-compatible : `image` seul continue de marcher.

## Points de vérification pour vous

- Confirmer côté Venice quels de vos modèles edit acceptent plusieurs images
  (au minimum `seedream-v4-edit`, `nano-banana-pro-edit`, `nano-banana-2-edit`,
  `qwen-image-2-edit`).
- Garder l'asymétrie d'encodage documentée : `/image/edit*` = data URI,
  `/image/upscale` = base64 brut. Le multi-edit doit suivre la règle data URI.
- Renvoyer une erreur claire (`400`) si le modèle choisi n'est pas multi-capable,
  plutôt qu'un `500`.

## Remarque connexe — catalogue opérateur incomplet

Votre `/v1/models` opérateur est un **sous-ensemble** du catalogue Venice : des
modèles d'édition existants chez Venice n'y figurent pas, alors que le proxy les
**exécute quand même** si on passe leur `model` à `/image/edit`. Exemple vérifié
le 2026-07-06 : `qwen-edit-uncensored` (Venice `type:inpaint`) — absent de votre
`/v1/models`, mais `POST /image/edit` avec ce `model` renvoie une image `200`
(un id bidon renvoie `Invalid model id`). Idem probablement pour
`firered-image-edit`, `luma-uni-1-edit`, `luma-uni-1-max-edit`,
`nano-banana-2-lite-edit`.

Merci de **lister ces modèles dans `/v1/models`** (avec `carpe_diem_type`,
`tier`, `pricing`) pour que les clients les découvrent normalement au lieu de les
coder en dur. Question : servez-vous délibérément un sous-ensemble, ou est-ce un
oubli d'enrôlement ?

> Nuance de format : `qwen-edit-uncensored` répond en JSON `{"images":[b64]}`
> alors que la plupart des modèles edit répondent en binaire. Un format de
> réponse homogène par endpoint simplifierait les clients.

## Côté Sub Rosa (ce qu'on branchera dès que dispo)

`src/lib/studio/edit-image.ts` a déjà le pattern sync→queue. On ajoutera un
`composeImages(modelId, prompt, images[])` calqué dessus, et le Studio mobile
proposera un mode « Combine » multi-références (l'UI multi-photos existe déjà :
`ReferencePicker`). Rien d'autre ne manque côté client.
