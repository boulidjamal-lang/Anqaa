// Askēsis Pro — webhook Stripe (Edge Function Supabase « stripe-webhook »).
//
// Stripe prévient ici quand quelqu'un paie, renouvelle, résilie ou ne paie
// plus ; la fonction tient à jour la table « abonnements » (voir le SQL
// « Askēsis Pro » dans Administration), que l'appli lit pour savoir qui
// est Pro. Le lien de paiement porte l'identifiant du compte
// (client_reference_id) : c'est lui qui relie le paiement au compte.
//
// Secrets : STRIPE_SECRET_KEY (clé secrète, rk_ ou sk_) et
// STRIPE_WEBHOOK_SECRET (whsec_…, donné par Stripe à la création du
// webhook). Déploiement SANS vérification du JWT : c'est Stripe qui appelle,
// et la signature de chaque message est vérifiée ci-dessous.
// Voir PRO_mise_en_service.md.

import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { httpClient: Stripe.createFetchHttpClient() });
const crypto = Stripe.createSubtleCryptoProvider();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// L'état Stripe, traduit dans les mots de l'appli.
function statutDe(a: Stripe.Subscription) {
  if (a.status === 'trialing') return 'essai';
  if (a.status === 'active') return a.cancel_at_period_end ? 'annule' : 'actif';
  if (a.status === 'past_due') return 'impaye'; // Stripe réessaie : Pro gardé jusqu'à la fin de la période
  return 'expire'; // canceled, unpaid, incomplete, incomplete_expired, paused
}

async function enregistrer(utilisateur: string, a: Stripe.Subscription) {
  const element = a.items && a.items.data && a.items.data[0];
  // Selon la version de l'API Stripe, la fin de période est sur l'abonnement ou sur son élément.
  // deno-lint-ignore no-explicit-any
  const finSec = (a as any).current_period_end ?? (element as any)?.current_period_end ?? a.trial_end ?? null;
  const ligne = {
    utilisateur,
    formule: element && element.price && element.price.recurring && element.price.recurring.interval === 'year' ? 'an' : 'mois',
    statut: statutDe(a),
    fin: finSec ? new Date(finSec * 1000).toISOString() : null,
    client_stripe: typeof a.customer === 'string' ? a.customer : a.customer && a.customer.id,
    abonnement_stripe: a.id,
    maj: new Date().toISOString(),
  };
  const { data: existant } = await admin.from('abonnements').select('formule').eq('utilisateur', utilisateur).maybeSingle();
  if (existant && existant.formule === 'fondateur') {
    // Un membre fondateur garde son Pro à vie, même s'il paie (on note seulement le client Stripe).
    await admin.from('abonnements').update({ client_stripe: ligne.client_stripe, abonnement_stripe: ligne.abonnement_stripe, maj: ligne.maj }).eq('utilisateur', utilisateur);
    return;
  }
  const { error } = await admin.from('abonnements').upsert(ligne);
  if (error) throw new Error(error.message);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Méthode non autorisée', { status: 405 });
  const signature = req.headers.get('Stripe-Signature');
  const corps = await req.text();
  let evenement: Stripe.Event;
  try {
    evenement = await stripe.webhooks.constructEventAsync(corps, signature || '', Deno.env.get('STRIPE_WEBHOOK_SECRET')!, undefined, crypto);
  } catch (e) {
    return new Response('Signature invalide : ' + (e as Error).message, { status: 400 });
  }

  try {
    if (evenement.type === 'checkout.session.completed') {
      const session = evenement.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.client_reference_id && session.subscription) {
        const id = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        await enregistrer(session.client_reference_id, await stripe.subscriptions.retrieve(id));
      }
    } else if (evenement.type === 'customer.subscription.updated' || evenement.type === 'customer.subscription.deleted') {
      const a = evenement.data.object as Stripe.Subscription;
      const { data } = await admin.from('abonnements').select('utilisateur').eq('abonnement_stripe', a.id).maybeSingle();
      // Pas encore relié à un compte : le paiement (checkout.session.completed) le fera.
      if (data) await enregistrer(data.utilisateur, a);
    }
  } catch (e) {
    // 500 : Stripe renverra le message plus tard.
    return new Response('Erreur : ' + (e as Error).message, { status: 500 });
  }
  return new Response(JSON.stringify({ recu: true }), { headers: { 'Content-Type': 'application/json' } });
});
