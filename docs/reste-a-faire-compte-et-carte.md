# Reste à faire : compte par email, clé Carpe Diem et crédits par carte

*État au 1er octobre 2026 au soir. Côté Sub Rosa, tout est livré. Ce qui reste dépend de Stripe, d'une relecture juridique, puis de Carpe Diem, **dans cet ordre**.*

## Où on en est

- **Apps** : **1.79.2** publiée (1er octobre) sur desktop (macOS arm64 et Intel, Windows ; l'updater l'annonce), TestFlight et Android (build 213031634). Elle contient les correctifs de l'audit : aucun lien d'achat là où la boutique l'interdit.
- **Service de comptes** (`subrosa.furetier.com`) en production :
  - migration 0009 appliquée, clé de partenaire armée ;
  - la route d'assertion répond 401 sans session ;
  - le `bootstrap.py` corrigé est en place sur le VPS.
- **Sites** redéployés avec les téléchargements 1.79.2, onglet Recharger en USDC.
- **Pour les utilisateurs, rien ne change** tant que Carpe Diem n'a pas tout armé. L'app masque les nouveaux parcours, et Carpe Diem refuse d'émettre des clés tant que la carte n'est pas ouverte : impossible de distribuer des comptes coincés à zéro crédit.

## Ordre des étapes (et pourquoi)

1. **Stripe en test**, pour un vrai achat de bout en bout.
2. **Juridique et trésorerie**, avant toute vente réelle.
3. **Stripe en live.** Les identifiants de prix live sont nécessaires à la configuration de Carpe Diem.
4. **Déploiement de Carpe Diem** avec tous les secrets d'un coup. L'émission de clés ne s'ouvre qu'avec la carte.
5. **Côté Sub Rosa** : vider la file des révocations, activer la carte sur le site.
6. **Essai avec de vrais utilisateurs.**

---

## 1. Stripe en mode test

**Qui :** l'entité Carpe Diem, ou toi pour l'essai.

- [ ] Créer dans Stripe, en mode test, les 4 prix en USD : 5, 10, 25 et 50 $, un paiement unique chacun.
- [ ] Créer les deux clés restreintes de test :

  | Clé | Pour qui | Permissions |
  |---|---|---|
  | `STRIPE_RESTRICTED_KEY` | opérateur Carpe Diem (TEE) | **lecture** : Checkout Sessions, PaymentIntents, Charges, Refunds, Disputes |
  | `STRIPE_SECRET_KEY` | service de paiement (frontend) | Checkout Sessions écriture et lecture, PaymentIntents lecture, **Charges lecture**, Refunds écriture et lecture |

- [ ] Enregistrer le webhook `https://<hôte>/api/pay/webhook` avec ces 5 événements :
  - `checkout.session.completed` ;
  - `checkout.session.async_payment_succeeded` ;
  - `charge.refunded` ;
  - `charge.refund.updated` ;
  - `charge.dispute.created`.

  Noter son `whsec_…`.
- [ ] Sur un environnement de préproduction de Carpe Diem : acheter avec la carte `4242 4242 4242 4242`, puis faire un remboursement partiel depuis le tableau de bord Stripe, puis un litige de test (carte `4000 0000 0000 0259`). Vérifier les crédits à chaque étape.

> Le même scénario a déjà été joué en local avec un faux Stripe : 26 contrôles sur 26. Ce qui manque, c'est l'épreuve du vrai Stripe.

## 2. Juridique et trésorerie

**Qui :** toi et l'entité Carpe Diem. Avant toute vente réelle.

- [ ] Faire relire le brouillon `docs/terms-of-use-draft-email-and-card.md` (dépôt Carpe Diem) : compte sans wallet, paiement par carte, qui est le marchand et dans quel pays, régime de TVA des crédits (bon à usage unique ou multiple). Les CGU publiées n'ont **pas** été modifiées.
- [ ] Définir la procédure d'**adossement de trésorerie** : qui dépose en USDC dans l'escrow l'équivalent des crédits vendus par carte, et à quel rythme. Aujourd'hui, l'opérateur ne fait qu'émettre une alerte.

## 3. Stripe en live

- [ ] Vérification d'identité (KYC) de l'entité Carpe Diem, et **Stripe Tax** activé.
- [ ] Les 4 prix en live, en notant chaque `price_…`.
- [ ] Les deux clés restreintes live, avec les mêmes permissions qu'à l'étape 1.
- [ ] Le webhook live sur `https://carpe-diem.xyz/api/pay/webhook`, avec les 5 événements.

## 4. Déployer Carpe Diem

**Qui :** Geolours, car le déploiement Phala lui revient.

- [ ] Relire et fusionner **Lumen-labs-ch/Carpe-diem-#397** (opérateur), puis **#398** (paiement et pages). #398 est empilée sur #397 : sa CI ne tournera qu'une fois reciblée sur `main`.
- [ ] Sealed env de l'opérateur, posé **en une seule mise à jour complète** (jamais un `-e` partiel, cf. l'incident du 14 mai) :

  | Variable | Valeur |
  |---|---|
  | `PARTNERS_JSON` | `[` + contenu de `~/.subrosa-accounts/prod/carpe-diem-partner.public.json` + `]` (à transmettre ; partie publique uniquement, avec `name: "Sub Rosa"`, kid `sr-eQvPaeyZV9pBLrdZ`) |
  | `OPERATOR_PUBLIC_URL` | `https://carpe-diem.xyz/api/operator` |
  | `APP_BASE_URL` | `https://carpe-diem.xyz` |
  | `RESEND_API_KEY` | obligatoire, et domaine de `EMAIL_FROM` (par défaut `login@carpe-diem.xyz`) validé chez Resend |
  | `FIAT_GRANT_SECRET` | secret HMAC aléatoire, **le même** que pour le service de paiement |
  | `STRIPE_RESTRICTED_KEY` | la clé live de l'opérateur (étape 3) |
  | `FIAT_TIERS_JSON` | voir ci-dessous |

  ```json
  [{"id":"usd_5","usdCents":500,"micros":"5000000","stripePriceId":"price_…"},
   {"id":"usd_10","usdCents":1000,"micros":"10000000","stripePriceId":"price_…"},
   {"id":"usd_25","usdCents":2500,"micros":"25000000","stripePriceId":"price_…"},
   {"id":"usd_50","usdCents":5000,"micros":"50000000","stripePriceId":"price_…"}]
  ```

  1 $ = 100 crédits. Un `price_…` doit être composé de lettres et de chiffres après `price_`, sinon le palier est ignoré.

- [ ] Variables du service de paiement (frontend, hors TEE, **jamais** préfixées `NEXT_PUBLIC_`) :
  - `STRIPE_SECRET_KEY` (clé live du service), `STRIPE_WEBHOOK_SECRET` (le `whsec_…` live), `STRIPE_TAX_ENABLED=true` ;
  - `FIAT_GRANT_SECRET` (le même), `APP_BASE_URL=https://carpe-diem.xyz` ;
  - `OPERATOR_INTERNAL_URL` (adresse directe de l'opérateur, sinon `https://carpe-diem.xyz/api/operator` par défaut).
- [ ] Router les lignes de log `[ALERT]` (opérateur et service de paiement) vers le canal d'astreinte.

**Contrôle après déploiement :**

```sh
curl -s https://carpe-diem.xyz/api/operator/partner/capabilities
# attendu : {"keyIssuance":true,"fiat":true,"blockedCountries":["BY","CU","IR","KP","MM","RU","SD","SS","SY","US"]}
curl -s -o /dev/null -w "%{http_code}\n" https://carpe-diem.xyz/pay   # attendu : 200
```

Si `keyIssuance` reste à `false`, c'est voulu tant qu'il manque le mailer, la carte (secret, clé Stripe, un prix sur chaque palier) ou `PARTNERS_JSON`.

## 5. Côté Sub Rosa, juste après Carpe Diem

**Qui :** moi.

- [ ] **Vider la file des révocations.** Les révocations qui attendaient (appareils révoqués ou déconnectés depuis le 30 septembre) sont relancées avec une reprise progressive qui monte jusqu'à **6 h**. Au 10 octobre, 15 révocations (2 comptes, depuis le 4 octobre) échouaient toutes en `http 404` : l'opérateur répond `NOT_FOUND` tant que `PARTNERS_JSON` ne contient pas l'entrée `subrosa` (`prod/carpe-diem-partner.public.json`, `kid` `sr-eQvPaeyZV9pBLrdZ`). C'est le même réglage qui tient `keyIssuance` à `false`. La file se vide d'elle-même une fois l'entrée déployée ; `curl -s http://127.0.0.1:18088/readyz` sur le VPS montre `partner_revocations.pending`. Pour les envoyer tout de suite :

  ```sh
  ssh -i ~/.ssh/id_ed25519 root@178.104.103.33 \
    "docker exec subrosa-accounts-postgres-1 psql -U postgres -d subrosa -c \
     \"UPDATE partner_revocations SET next_attempt_at = now() WHERE done_at IS NULL\""
  ```

  puis vérifier au bout de 2 minutes (attendu : `0`) :

  ```sh
  ssh -i ~/.ssh/id_ed25519 root@178.104.103.33 \
    "docker exec subrosa-accounts-postgres-1 psql -U postgres -d subrosa -tAc \
     \"SELECT count(*) FROM partner_revocations WHERE done_at IS NULL\""
  ```

- [ ] **Activer la carte sur le site du compte** une fois que `https://carpe-diem.xyz/pay` répond 200 : `VITE_CARD_TOPUP=1 pnpm build:website` (sans autre variable), puis bascule atomique de `/srv/subrosa-account/www/current` avec les contrôles habituels. Le site public ne change pas.

## 6. Essai avec de vrais utilisateurs

**Qui :** toi, avec mon aide.

- [ ] **Ordinateur :**
  - « Je commence », créer un compte avec une vraie adresse et vérifier le mail ;
  - contrôler que la clé est créée toute seule et que la feuille « Ajouter des crédits » s'ouvre ;
  - payer 5 $ et contrôler que le solde arrive en moins de 2 minutes ;
  - contrôler que le mail « Nouvelle clé Carpe Diem pour Sub Rosa » indique la page de paiement.
- [ ] **iPhone :**
  - se connecter et contrôler qu'il reçoit **sa propre** clé, avec le même solde ;
  - contrôler qu'**aucun** lien d'achat n'apparaît, ni dans l'accueil, ni dans les réglages, ni dans la feuille ;
  - contrôler la lecture de la vitrine StoreKit (jamais testée sur un appareil réel).
- [ ] **Révocation :** révoquer l'iPhone depuis l'ordinateur ; sa clé doit cesser de fonctionner en environ une minute.
- [ ] **Adresse déjà connue de Carpe Diem :** avec une adresse qui a déjà un compte Carpe Diem, contrôler que le code à 6 caractères est demandé et que la page `/link` l'accepte.

## Plus tard (non bloquant)

- **iPhone sans achat** : à revoir si Carpe Diem vend un jour aux États-Unis (lien autorisé par Apple), ou en demandant à Apple le droit à un lien de paiement externe dans l'UE.
- **Rotation de la clé de partenaire** : procédure dans `docs/vps-account-stack.md` ; faire épingler les deux `kid` avant de retirer l'ancien.
- **Liste d'autorisation de sortie réseau** du serveur de comptes : si elle est un jour mise en place, y inclure `carpe-diem.xyz`.
- **Nettoyage** une fois Carpe Diem fusionné :
  - les worktrees `Sub Rosa/.worktrees/{cloud-partner,app-account-key,migration-race,release-1.79.0,site-verify,store-policy}` et `CarpeDiem/.worktrees/{partner-keys,pay-frontend}` ;
  - les copies `~/.subrosa-accounts/prod.stale-*` et `prod.bak-carpe-diem-*` sur le VPS.

## Références

- **Décision et limites de sécurité** : ADR-0069 (`docs/adr/0069-the-account-gives-birth-to-a-carpe-diem-device-key.md`).
- **Contrat réseau** : `docs/carpe-diem-partner-contract.md` (Sub Rosa) = `docs/partner-integration.md` (Carpe Diem).
- **Exploitation Carpe Diem** : `docs/payments.md`, dont la section « Order of arming ».
- **Exploitation du serveur de comptes** : `docs/vps-account-stack.md`, section « Clé de partenaire Carpe Diem ».
- **Tests live croisés** : `src-tauri/src/carpe_diem/issued_live_tests.rs` (recette en tête de fichier).
- **PR** :
  - Sub Rosa : #226 à #229, #235 (fusionnées), #231 et #237 (releases 1.79.0 et 1.79.2), #232 et #239 (téléchargements), #236 (cette note) ;
  - Carpe Diem : #397 et #398 (ouvertes).
