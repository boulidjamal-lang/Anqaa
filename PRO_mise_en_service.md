# Askēsis Pro — mise en service

Tout le code est prêt : la fenêtre « Askēsis Pro », les verrous, l'IA passée
par le serveur, le webhook Stripe et le bouton « Offrir Pro » de
l'Administration. **Tant que les étapes ci-dessous ne sont pas faites,
l'appli fonctionne exactement comme avant : rien n'est verrouillé.** Chaque
étape s'active toute seule, sans nouvelle mise à jour de l'appli, sauf
l'étape 4 (les liens de paiement à mettre dans `index.html`).

Ce qui est réservé à Pro :

- l'IA au-delà de **3 essais par mois** (photo d'un repas, programme sur
  mesure, analyse de la journée et de la période) ;
- les analyses avancées de Progrès : maintenance réelle, « Ce qui a bougé »,
  prévision du poids, constats repas, séries par muscle semaine par semaine,
  niveau de force, périodes de plus de 3 mois ;
- les photos de progression ;
- la balance Withings.

Prix prévus : **3,99 € / mois** ou **29,99 € / an**, avec **14 jours
d'essai**. Les comptes qui existent au moment de l'étape 1 deviennent
**membres fondateurs** : Pro à vie.

---

## Étape 1 — Le SQL (2 minutes)

1. Dans l'appli, avec ton compte admin : **Administration › Réglages
   techniques**, ouvre « SQL : Askēsis Pro » et touche **Copier le SQL**.
2. Supabase › **SQL Editor** › colle › **Run**.

Effet immédiat :

- tous les comptes existants sont membres fondateurs (Pro à vie) ;
- les nouveaux comptes sont gratuits, avec les verrous ;
- dans Administration, la fiche d'un compte montre son état Pro et un
  bouton **Offrir Pro** / **Retirer** (pour tes amis, tes testeurs) ;
- le SQL peut être relancé sans risque (il ne refait pas de fondateurs).

Pour tout rouvrir d'un coup : `drop table public.abonnements;` (l'appli
redevient comme avant, sans verrous).

## Étape 2 — L'IA côté serveur (5 minutes)

Aujourd'hui, la clé Gemini est liée à un compte et part du téléphone : elle
est lisible par la personne qui l'utilise. Avec cette étape, la clé reste
sur le serveur, et l'IA s'ouvre à tous les comptes connectés (3 essais par
mois sans Pro, sans limite pratique avec Pro, 600 demandes par mois au plus).

1. Une clé Gemini : [Google AI Studio](https://aistudio.google.com) › Get
   API key (celle d'aujourd'hui convient).
2. Supabase › **Edge Functions** › **Deploy a new function** › **Via
   Editor**. Nom : **`ia`** (exactement). Colle le contenu de
   `supabase/functions/ia/index.ts`, puis **Deploy**. Laisse **Verify JWT**
   activé.
3. Supabase › Edge Functions › **Secrets** › ajoute `GEMINI_API_KEY` = ta clé.

L'appli détecte la fonction toute seule à la connexion. Tant qu'elle n'est
pas déployée, l'ancienne clé liée au compte reste utilisée.

> `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont fournis automatiquement
> aux fonctions : rien à faire.

## Étape 3 — Stripe (20 à 30 minutes)

Prérequis : un statut pour encaisser (la micro-entreprise se déclare
gratuitement sur [formalites.entreprises.gouv.fr](https://formalites.entreprises.gouv.fr))
et un compte bancaire. Les pages légales doivent être complétées et en
ligne (étape 5) : Stripe les demande.

**Commence en mode test** (interrupteur « Mode test » de Stripe, carte
`4242 4242 4242 4242`), puis refais les mêmes réglages en mode réel.

1. Crée ton compte sur [stripe.com](https://stripe.com) et active les
   paiements (identité, IBAN).
2. Si ton compte le propose, active **Managed Payments** : Stripe devient le
   vendeur officiel et gère la TVA de chaque pays et les factures. Sinon,
   vois avec un comptable (en franchise de TVA, pas de TVA à facturer sous
   les seuils).
3. **Catalogue de produits** › produit « Askēsis Pro » avec deux prix
   récurrents : **3,99 € par mois** et **29,99 € par an**.
4. Deux **liens de paiement** (Payment Links), un par prix :
   - essai gratuit : **14 jours** ;
   - après le paiement : **rediriger** vers `https://anqa.netlify.app/?pro=merci`
     (ou l'adresse où l'appli est en ligne) ;
   - adresse email : demandée (elle est préremplie par l'appli).
5. **Paramètres › Facturation › Portail client** : active-le (résilier,
   changer de formule, changer de carte) et copie le **lien de connexion au
   portail**.
6. Le webhook :
   - Supabase › Edge Functions › nouvelle fonction **`stripe-webhook`** avec
     le contenu de `supabase/functions/stripe-webhook/index.ts` ;
     **désactive Verify JWT** pour celle-ci (c'est Stripe qui l'appelle ; la
     signature de chaque message est vérifiée par le code) ;
   - Stripe › **Développeurs › Webhooks** › Ajouter un endpoint :
     `https://nhbvmqubwbzrddndisfr.supabase.co/functions/v1/stripe-webhook`,
     événements `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted` ;
   - copie le **secret de signature** (`whsec_…`).
7. Supabase › Edge Functions › Secrets :
   - `STRIPE_SECRET_KEY` : une clé restreinte (`rk_…`) avec la lecture des
     abonnements suffit (sinon la clé secrète `sk_…`) ;
   - `STRIPE_WEBHOOK_SECRET` : le `whsec_…`.

**Ne m'envoie jamais ces clés ni le `whsec_…`** : elles ne vont que dans les
secrets Supabase.

## Étape 4 — Les liens dans l'appli

Envoie-moi les trois liens publics (ce ne sont pas des secrets) :

- le lien de paiement **annuel** (`https://buy.stripe.com/…`) ;
- le lien de paiement **mensuel** ;
- le lien du **portail client** (`https://billing.stripe.com/p/login/…`).

Je les mets dans `PRO_LIENS` (`index.html`) et je pousse. Avant ça, la
fenêtre Pro affiche « Paiement bientôt disponible ».

## Étape 5 — Les pages légales

`mentions-legales.html`, `cgv.html` et `confidentialite.html` sont des
brouillons : complète les passages surlignés (nom, SIRET, adresse, email,
région Supabase, médiateur de la consommation, mention de TVA, date) et
fais-les relire si possible. Elles sont liées depuis la fenêtre Pro et en
bas des Réglages.

À prévoir aussi, Pro ou pas : une case de consentement à la création du
compte pour les données de santé (poids, repas, mensurations).

---

## Comment ça marche

- **Payer** : « Essayer 14 jours gratuitement » ouvre la page Stripe avec
  l'identifiant du compte (`client_reference_id`) et son email. Stripe
  prévient la fonction `stripe-webhook`, qui écrit l'abonnement dans la
  table `abonnements`. L'appli le relit dès qu'on revient dedans : Pro est
  actif en quelques secondes.
- **États** : `essai`, `actif`, `annule` (résilié, Pro jusqu'à la fin de la
  période payée), `impaye` (Stripe réessaie, Pro gardé jusqu'à la fin de la
  période), `expire`.
- **Hors ligne** : l'état est gardé sur le téléphone jusqu'à la date de fin.
- **Résilier, rembourser** : l'utilisateur résilie depuis Réglages › Askēsis
  Pro › Gérer (portail Stripe) ; les remboursements se font dans le tableau
  de bord Stripe.
- **Supprimer un compte** : ses lignes Pro partent avec lui ; pense à
  résilier son abonnement Stripe s'il en avait un.

## Tests

`npm test` lance aussi les tests des deux fonctions serveur (sous Node, avec
de faux Supabase, Stripe et Gemini) : essais gratuits, Pro, remboursement
d'un essai raté, signature Stripe, états d'abonnement, fondateurs.
