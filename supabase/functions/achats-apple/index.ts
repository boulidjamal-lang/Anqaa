// Askēsis Pro — achats Apple (Edge Function Supabase « achats-apple »).
//
// Deux appelants :
// - l'app iOS, juste après un achat ou une restauration : { transactionId },
//   avec le jeton de la personne connectée ;
// - Apple (App Store Server Notifications, version 2) à chaque renouvellement,
//   résiliation, remboursement : { signedPayload }.
// Dans les deux cas, rien n'est cru sur parole : la fonction redemande l'état
// de l'abonnement à Apple (App Store Server API, authentifiée par notre clé)
// et tient à jour la table « abonnements », comme le webhook Stripe. Le lien
// avec le compte est l'appAccountToken posé par l'app au moment de l'achat
// (l'identifiant du compte Askēsis), relu chez Apple.
//
// Secrets : APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY
// (le fichier .p8 de la clé « In-App Purchase » d'App Store Connect, tel
// quel), APPLE_BUNDLE_ID (com.jambou.askesis). Déploiement SANS vérification
// du JWT : Apple appelle sans compte ; l'app, elle, est vérifiée ci-dessous.
// Voir ios-app/GUIDE_iOS.md (dépôt Anqa).

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const API = { Production: 'https://api.storekit.itunes.apple.com', Sandbox: 'https://api.storekit-sandbox.itunes.apple.com' };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(corps: unknown, status = 200) {
  return new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const b64url = (octets: Uint8Array) => btoa(String.fromCharCode(...octets)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const texteB64url = (t: string) => b64url(new TextEncoder().encode(t));
// La partie centrale d'un JWS, en clair (Apple signe ; la réponse vient d'Apple en HTTPS).
// deno-lint-ignore no-explicit-any
function contenuJws(jws: string): any {
  const morceau = String(jws || '').split('.')[1] || '';
  const b64 = morceau.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - morceau.length % 4) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
}

// Jeton de l'App Store Server API : ES256, signé par la clé In-App Purchase, 20 minutes.
async function jetonApple() {
  const pem = (Deno.env.get('APPLE_IAP_PRIVATE_KEY') || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const cle = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = texteB64url(JSON.stringify({ alg: 'ES256', kid: Deno.env.get('APPLE_IAP_KEY_ID'), typ: 'JWT' }));
  const corps = texteB64url(JSON.stringify({ iss: Deno.env.get('APPLE_IAP_ISSUER_ID'), iat: maintenant, exp: maintenant + 1200,
    aud: 'appstoreconnect-v1', bid: Deno.env.get('APPLE_BUNDLE_ID') }));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cle, new TextEncoder().encode(entete + '.' + corps));
  return entete + '.' + corps + '.' + b64url(new Uint8Array(signature));
}

// État de l'abonnement chez Apple : la production d'abord, puis le bac à
// sable (achats de TestFlight et des comptes de test).
async function etatApple(transactionId: string) {
  const jeton = await jetonApple();
  for (const env of ['Production', 'Sandbox'] as const) {
    const r = await fetch(`${API[env]}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, { headers: { Authorization: 'Bearer ' + jeton } });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`Apple a répondu ${r.status}`);
    const corps = await r.json();
    const derniers = (corps.data || []).flatMap((g: { lastTransactions?: unknown[] }) => g.lastTransactions || []);
    // deno-lint-ignore no-explicit-any
    return { bundleId: corps.bundleId, derniers: derniers.map((t: any) => ({ status: t.status, transaction: contenuJws(t.signedTransactionInfo), renouvellement: t.signedRenewalInfo ? contenuJws(t.signedRenewalInfo) : {} })) };
  }
  return null;
}

// L'état Apple, traduit dans les mots de l'appli (comme pour Stripe).
// deno-lint-ignore no-explicit-any
function statutDe(status: number, transaction: any, renouvellement: any) {
  if (status === 1) {
    if (transaction.offerType === 1 && transaction.offerDiscountType === 'FREE_TRIAL') return 'essai';
    return renouvellement.autoRenewStatus === 0 ? 'annule' : 'actif'; // annule : Pro jusqu'à la fin de la période
  }
  if (status === 4) return 'actif'; // délai de grâce : Apple réessaie le paiement
  if (status === 3) return 'impaye';
  return 'expire'; // 2 expiré, 5 remboursé ou révoqué
}

async function enregistrer(etat: NonNullable<Awaited<ReturnType<typeof etatApple>>>, utilisateurAttendu: string | null) {
  if (etat.bundleId && etat.bundleId !== Deno.env.get('APPLE_BUNDLE_ID')) return { code: 'autre_app', status: 400 };
  // Le plus récent des abonnements de la famille (une seule formule active à la fois).
  const e = etat.derniers.sort((a, b) => (b.transaction.expiresDate || 0) - (a.transaction.expiresDate || 0))[0];
  if (!e) return { code: 'inconnu', status: 404 };
  const utilisateur = String(e.transaction.appAccountToken || '').toLowerCase();
  if (!utilisateur) return { code: 'compte_non_lie', status: 409 };
  if (utilisateurAttendu && utilisateur !== utilisateurAttendu.toLowerCase()) return { code: 'autre_compte', status: 403 };
  const fin = e.renouvellement.gracePeriodExpiresDate || e.transaction.expiresDate;
  const ligne = {
    utilisateur,
    formule: /an|year|annuel/i.test(String(e.transaction.productId)) ? 'an' : 'mois',
    statut: statutDe(e.status, e.transaction, e.renouvellement),
    fin: fin ? new Date(fin).toISOString() : null,
    source: 'apple',
    transaction_apple: String(e.transaction.originalTransactionId),
    maj: new Date().toISOString(),
  };
  const { data: existant } = await admin.from('abonnements').select('formule').eq('utilisateur', utilisateur).maybeSingle();
  if (existant && (existant.formule === 'fondateur' || existant.formule === 'offert')) {
    // Pro à vie ou offert : on garde, on note seulement la transaction Apple.
    await admin.from('abonnements').update({ source: 'apple', transaction_apple: ligne.transaction_apple, maj: ligne.maj }).eq('utilisateur', utilisateur);
    return { code: 'ok', status: 200, pro: true, statut: 'actif' };
  }
  const { error } = await admin.from('abonnements').upsert(ligne);
  if (error) throw new Error(error.message);
  const pro = ['actif', 'essai', 'annule', 'impaye'].includes(ligne.statut) && !!ligne.fin && new Date(ligne.fin) > new Date();
  return { code: 'ok', status: 200, pro, statut: ligne.statut, fin: ligne.fin };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  if (!Deno.env.get('APPLE_IAP_PRIVATE_KEY')) return json({ erreur: "Les achats Apple ne sont pas encore configurés sur le serveur." }, 503);
  // deno-lint-ignore no-explicit-any
  let corps: any;
  try { corps = await req.json(); } catch (e) { return json({ erreur: 'Requête illisible' }, 400); }

  try {
    // Apple : la notification dit seulement quelle transaction revoir.
    if (corps && corps.signedPayload) {
      const notification = contenuJws(corps.signedPayload);
      const signee = notification.data && notification.data.signedTransactionInfo;
      const id = signee && contenuJws(signee).transactionId;
      if (!id) return json({ recu: true }); // test d'Apple ou notification sans transaction
      const etat = await etatApple(String(id));
      if (etat) await enregistrer(etat, null);
      return json({ recu: true });
    }

    // L'app : la personne connectée, et sa transaction.
    const jeton = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data } = await admin.auth.getUser(jeton);
    const utilisateur = data && data.user && data.user.id;
    if (!utilisateur) return json({ erreur: 'Connecte-toi pour activer Pro.' }, 401);
    const transactionId = corps && String(corps.transactionId || '');
    if (!/^\d{1,30}$/.test(transactionId)) return json({ erreur: 'Transaction invalide' }, 400);
    const etat = await etatApple(transactionId);
    if (!etat) return json({ erreur: 'Transaction inconnue chez Apple.' }, 404);
    const r = await enregistrer(etat, utilisateur);
    if (r.code === 'autre_compte') return json({ erreur: 'Cet abonnement Apple est lié à un autre compte Askēsis.', code: r.code }, r.status);
    if (r.code !== 'ok') return json({ erreur: "Cet achat ne peut pas être relié à ton compte.", code: r.code }, r.status);
    return json({ pro: r.pro, statut: r.statut, fin: r.fin ?? null });
  } catch (e) {
    // 500 : Apple renverra la notification plus tard ; l'app peut réessayer.
    return json({ erreur: 'Erreur : ' + (e as Error).message }, 500);
  }
});
