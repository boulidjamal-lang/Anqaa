/* Tests des Edge Functions Supabase du Pro (supabase/functions), exécutées
   sous Node avec des doubles de Supabase, Stripe et Gemini : on vérifie la
   logique (essais gratuits, Pro, remboursement, signature Stripe, états
   d'abonnement, membres fondateurs) sans rien déployer.
   Lancer : node --test --experimental-strip-types --import ./tests/fonctions/chargeur.mjs tests/fonctions.test.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Une base Supabase en mémoire : tables et fonctions SQL utilisées par les fonctions.
function fausseBase() {
  const tables = { abonnements: [], usages_ia: [] };
  const comptes = { 'jeton-libre': 'u-libre', 'jeton-pro': 'u-pro', 'jeton-fondateur': 'u-fondateur' };
  const client = {
    tables,
    auth: { getUser: async jeton => ({ data: { user: comptes[jeton] ? { id: comptes[jeton] } : null } }) },
    from(nom) {
      const filtres = [];
      const lignes = () => tables[nom].filter(l => filtres.every(([c, v]) => l[c] === v));
      const requete = {
        select() { return requete; },
        eq(c, v) { filtres.push([c, v]); return requete; },
        maybeSingle: async () => ({ data: lignes()[0] || null, error: null }),
        upsert: async ligne => {
          const i = tables[nom].findIndex(l => l.utilisateur === ligne.utilisateur);
          if (i >= 0) tables[nom][i] = { ...tables[nom][i], ...ligne }; else tables[nom].push({ ...ligne });
          return { error: null };
        },
        update(valeurs) {
          return { eq: async (c, v) => { tables[nom].filter(l => l[c] === v).forEach(l => Object.assign(l, valeurs)); return { error: null }; } };
        }
      };
      return requete;
    },
    async rpc(nom, a) {
      const mois = new Date().toISOString().slice(0, 7) + '-01';
      let u = tables.usages_ia.find(l => l.utilisateur === a.p_utilisateur && l.mois === mois);
      if (nom === 'compter_usage_ia') {
        if (!u) { u = { utilisateur: a.p_utilisateur, mois, nombre: 0 }; tables.usages_ia.push(u); }
        if (u.nombre >= a.p_limite) return { data: null, error: null };
        u.nombre += 1;
        return { data: u.nombre, error: null };
      }
      if (nom === 'rendre_usage_ia') { if (u) u.nombre = Math.max(0, u.nombre - 1); return { data: null, error: null }; }
      throw new Error('rpc inconnue ' + nom);
    }
  };
  return client;
}

async function chargerFonction(nom, env, base, stripe) {
  let gestionnaire = null;
  globalThis.Deno = { env: { get: k => env[k] }, serve: h => { gestionnaire = h; } };
  globalThis.__doubles = { createClient: () => base, Stripe: stripe };
  const url = pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', nom, 'index.ts')).href + '?' + Math.random();
  await import(url);
  return gestionnaire;
}

const envIA = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', GEMINI_API_KEY: 'cle-secrete' };
const appelIA = (h, jeton, methode = 'POST', corps = { parts: [{ text: 'Bonjour' }], modele: 'gemini-3.5-flash' }) =>
  h(new Request('https://x.supabase.co/functions/v1/ia', { method: methode, headers: { Authorization: 'Bearer ' + jeton }, body: methode === 'POST' ? JSON.stringify(corps) : undefined }))
    .then(async r => ({ status: r.status, corps: await r.json() }));

test('fonction « ia » : 3 essais par mois sans Pro, puis Pro requis ; la clé Gemini ne quitte pas le serveur', async () => {
  const base = fausseBase();
  const appels = [];
  globalThis.fetch = async (url, o) => { appels.push({ url, cle: o.headers['x-goog-api-key'] }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 }); };
  const h = await chargerFonction('ia', envIA, base);
  assert.deepEqual((await appelIA(h, 'jeton-libre', 'GET')).corps, { pret: true, pro: false, restant: 3 });
  const reponses = [];
  for (let i = 0; i < 4; i++) reponses.push(await appelIA(h, 'jeton-libre'));
  assert.deepEqual(reponses.map(r => [r.status, r.corps.restant]), [[200, 2], [200, 1], [200, 0], [402, 0]]);
  assert.equal(reponses[3].corps.code, 'pro_requis');
  assert.equal(appels.length, 3, 'le 4e essai ne part pas chez Gemini');
  assert.match(appels[0].url, /models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(appels[0].cle, 'cle-secrete');
  // Sans connexion : refusé.
  assert.equal((await appelIA(h, 'jeton-inconnu')).status, 401);
});

test('fonction « ia » : Pro sans limite pratique ; un échec de Gemini rend l\'essai ; abonnement expiré = plus Pro', async () => {
  const base = fausseBase();
  const fin = new Date(Date.now() + 86400e3).toISOString();
  base.tables.abonnements.push({ utilisateur: 'u-pro', formule: 'an', statut: 'actif', fin });
  base.tables.abonnements.push({ utilisateur: 'u-libre', formule: 'mois', statut: 'actif', fin: new Date(Date.now() - 1000).toISOString() });
  let reponseGemini = 200;
  globalThis.fetch = async () => new Response(JSON.stringify(reponseGemini === 200 ? { candidates: [] } : { error: { message: 'surchargé' } }), { status: reponseGemini });
  const h = await chargerFonction('ia', envIA, base);
  for (let i = 0; i < 5; i++) assert.equal((await appelIA(h, 'jeton-pro')).status, 200);
  assert.deepEqual((await appelIA(h, 'jeton-pro', 'GET')).corps, { pret: true, pro: true, restant: null });
  // L'abonnement de « u-libre » est fini : 3 essais comme tout le monde, et un échec ne compte pas.
  reponseGemini = 503;
  const echec = await appelIA(h, 'jeton-libre');
  assert.deepEqual([echec.status, echec.corps.restant], [503, 3]);
  reponseGemini = 200;
  assert.equal((await appelIA(h, 'jeton-libre')).corps.restant, 2);
  // Modèle inconnu : celui de l'appli. Demande vide : refusée.
  assert.equal((await appelIA(h, 'jeton-pro', 'POST', { parts: [] })).status, 400);
});

test('fonction « ia » : sans clé Gemini sur le serveur, rien n\'est compté', async () => {
  const base = fausseBase();
  const h = await chargerFonction('ia', { ...envIA, GEMINI_API_KEY: '' }, base);
  assert.equal((await appelIA(h, 'jeton-libre', 'GET')).corps.pret, false);
  assert.equal((await appelIA(h, 'jeton-libre')).status, 503);
  assert.equal(base.tables.usages_ia.length, 0);
});

// Un double de Stripe : signature « bonne » acceptée, abonnements gardés en mémoire.
function fauxStripe(abonnements) {
  class Stripe {
    constructor() {
      this.webhooks = { constructEventAsync: async (corps, signature) => { if (signature !== 'bonne') throw new Error('mauvaise signature'); return JSON.parse(corps); } };
      this.subscriptions = { retrieve: async id => abonnements[id] };
    }
    static createFetchHttpClient() { return {}; }
    static createSubtleCryptoProvider() { return {}; }
  }
  return Stripe;
}
const envStripe = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec' };
const evenement = (h, type, objet, signature = 'bonne') => h(new Request('https://x.supabase.co/functions/v1/stripe-webhook', {
  method: 'POST', headers: { 'Stripe-Signature': signature }, body: JSON.stringify({ type, data: { object: objet } })
})).then(r => r.status);

test('webhook Stripe : essai, paiement, résiliation, fin ; signature vérifiée ; un fondateur le reste', async () => {
  const base = fausseBase();
  base.tables.abonnements.push({ utilisateur: 'u-fondateur', formule: 'fondateur', statut: 'actif', fin: null });
  const dans14j = Math.floor(Date.now() / 1000) + 14 * 86400;
  const abonnements = {
    sub_1: { id: 'sub_1', status: 'trialing', cancel_at_period_end: false, customer: 'cus_1', trial_end: dans14j,
      items: { data: [{ price: { recurring: { interval: 'year' } }, current_period_end: dans14j }] } },
    sub_2: { id: 'sub_2', status: 'active', cancel_at_period_end: false, customer: 'cus_2', current_period_end: dans14j,
      items: { data: [{ price: { recurring: { interval: 'month' } } }] } }
  };
  const h = await chargerFonction('stripe-webhook', envStripe, base, fauxStripe(abonnements));
  const ligne = u => base.tables.abonnements.find(l => l.utilisateur === u);

  assert.equal(await evenement(h, 'checkout.session.completed', { mode: 'subscription', client_reference_id: 'u-libre', subscription: 'sub_1' }, 'fausse'), 400);
  assert.equal(ligne('u-libre'), undefined);

  assert.equal(await evenement(h, 'checkout.session.completed', { mode: 'subscription', client_reference_id: 'u-libre', subscription: 'sub_1' }), 200);
  assert.deepEqual([ligne('u-libre').formule, ligne('u-libre').statut, ligne('u-libre').client_stripe, ligne('u-libre').fin], ['an', 'essai', 'cus_1', new Date(dans14j * 1000).toISOString()]);

  // Fin de l'essai : payé ; puis résilié (Pro jusqu'à la fin de la période) ; puis terminé.
  await evenement(h, 'customer.subscription.updated', { ...abonnements.sub_1, status: 'active' });
  assert.equal(ligne('u-libre').statut, 'actif');
  await evenement(h, 'customer.subscription.updated', { ...abonnements.sub_1, status: 'active', cancel_at_period_end: true });
  assert.equal(ligne('u-libre').statut, 'annule');
  await evenement(h, 'customer.subscription.updated', { ...abonnements.sub_1, status: 'past_due' });
  assert.equal(ligne('u-libre').statut, 'impaye');
  await evenement(h, 'customer.subscription.deleted', { ...abonnements.sub_1, status: 'canceled' });
  assert.equal(ligne('u-libre').statut, 'expire');

  // Abonnement pas encore relié à un compte : ignoré.
  assert.equal(await evenement(h, 'customer.subscription.updated', { ...abonnements.sub_2 }), 200);
  assert.equal(base.tables.abonnements.length, 2);

  // Un fondateur qui paie quand même : toujours fondateur, sans fin.
  await evenement(h, 'checkout.session.completed', { mode: 'subscription', client_reference_id: 'u-fondateur', subscription: 'sub_2' });
  assert.deepEqual([ligne('u-fondateur').formule, ligne('u-fondateur').statut, ligne('u-fondateur').fin, ligne('u-fondateur').client_stripe], ['fondateur', 'actif', null, 'cus_2']);
});

// Apple : une vraie clé ES256 de test et une fausse App Store Server API
// (production, puis bac à sable), qui renvoie des JWS lisibles.
const { generateKeyPairSync, verify: verifierSignature } = require('crypto');
function cleAppleTest() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}
const jws = contenu => ['e30', Buffer.from(JSON.stringify(contenu)).toString('base64url'), 'signature'].join('.');
function fausseApiApple(abonnements, journal) {
  return async (url, o) => {
    journal.push({ url: String(url), auth: o && o.headers && o.headers.Authorization });
    const m = String(url).match(/^https:\/\/api\.storekit(-sandbox)?\.itunes\.apple\.com\/inApps\/v1\/subscriptions\/(\d+)$/);
    const a = m && abonnements[m[2]];
    if (!a || a.env !== (m[1] ? 'Sandbox' : 'Production')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ bundleId: a.bundleId || 'com.jambou.askesis', data: [{ lastTransactions: [{
      status: a.status, signedTransactionInfo: jws(a.transaction), signedRenewalInfo: jws(a.renouvellement || { autoRenewStatus: 1 }) }] }] }), { status: 200 });
  };
}
const envApple = cle => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', APPLE_IAP_KEY_ID: 'KEY123',
  APPLE_IAP_ISSUER_ID: 'issuer-1', APPLE_IAP_PRIVATE_KEY: cle.pem, APPLE_BUNDLE_ID: 'com.jambou.askesis' });
const achatApple = (h, jeton, corps) => h(new Request('https://x.supabase.co/functions/v1/achats-apple', {
  method: 'POST', headers: jeton ? { Authorization: 'Bearer ' + jeton } : {}, body: JSON.stringify(corps)
})).then(async r => ({ status: r.status, corps: await r.json() }));

test('achats Apple : achat vérifié chez Apple et relié au compte ; jeton ES256 valide ; transaction d\'un autre compte refusée', async () => {
  const base = fausseBase();
  const cle = cleAppleTest(), journal = [];
  const dans1an = Date.now() + 365 * 86400e3;
  globalThis.fetch = fausseApiApple({
    1000: { env: 'Production', status: 1, transaction: { transactionId: '1000', originalTransactionId: '900', productId: 'askesis.pro.an', expiresDate: dans1an, appAccountToken: 'U-LIBRE' } },
    2000: { env: 'Sandbox', status: 1, transaction: { transactionId: '2000', originalTransactionId: '1900', productId: 'askesis.pro.mois', expiresDate: dans1an, appAccountToken: 'u-pro', offerType: 1, offerDiscountType: 'FREE_TRIAL' } }
  }, journal);
  const h = await chargerFonction('achats-apple', envApple(cle), base);
  const r = await achatApple(h, 'jeton-libre', { transactionId: '1000' });
  assert.deepEqual([r.status, r.corps.pro, r.corps.statut], [200, true, 'actif']);
  const ligne = base.tables.abonnements.find(l => l.utilisateur === 'u-libre');
  assert.deepEqual([ligne.formule, ligne.source, ligne.transaction_apple], ['an', 'apple', '900']);
  // Le jeton envoyé à Apple : un JWT ES256 que la clé publique vérifie.
  const [e, c, s] = journal[0].auth.replace('Bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(e, 'base64url')), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  const charge = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual([charge.iss, charge.aud, charge.bid], ['issuer-1', 'appstoreconnect-v1', 'com.jambou.askesis']);
  assert.ok(charge.exp - charge.iat <= 3600);
  assert.ok(verifierSignature('sha256', Buffer.from(e + '.' + c), { key: cle.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  // Bac à sable (TestFlight) après un 404 en production ; essai gratuit.
  const r2 = await achatApple(h, 'jeton-pro', { transactionId: '2000' });
  assert.deepEqual([r2.status, r2.corps.statut], [200, 'essai']);
  assert.ok(journal.some(j => /storekit-sandbox/.test(j.url)));
  // La transaction de quelqu'un d'autre : refusée, rien d'écrit.
  const avant = JSON.stringify(base.tables.abonnements);
  assert.equal((await achatApple(h, 'jeton-pro', { transactionId: '1000' })).status, 403);
  assert.equal(JSON.stringify(base.tables.abonnements), avant);
  // Sans connexion, transaction farfelue, transaction inconnue chez Apple.
  assert.equal((await achatApple(h, null, { transactionId: '1000' })).status, 401);
  assert.equal((await achatApple(h, 'jeton-libre', { transactionId: 'abc' })).status, 400);
  assert.equal((await achatApple(h, 'jeton-libre', { transactionId: '555' })).status, 404);
});

test('achats Apple : notifications d\'Apple (résiliation, expiration) ; un fondateur le reste ; serveur non configuré', async () => {
  const base = fausseBase();
  const cle = cleAppleTest(), journal = [];
  base.tables.abonnements.push({ utilisateur: 'u-fondateur', formule: 'fondateur', statut: 'actif', fin: null });
  const abonnements = { 1000: { env: 'Production', status: 1, renouvellement: { autoRenewStatus: 0 },
    transaction: { transactionId: '1000', originalTransactionId: '900', productId: 'askesis.pro.mois', expiresDate: Date.now() + 20 * 86400e3, appAccountToken: 'u-libre' } } };
  globalThis.fetch = fausseApiApple(abonnements, journal);
  const h = await chargerFonction('achats-apple', envApple(cle), base);
  const notifier = id => h(new Request('https://x.supabase.co/functions/v1/achats-apple', { method: 'POST',
    body: JSON.stringify({ signedPayload: jws({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', data: { signedTransactionInfo: jws({ transactionId: id }) } }) }) })).then(r => r.status);
  const statut = u => base.tables.abonnements.find(l => l.utilisateur === u).statut;
  assert.equal(await notifier('1000'), 200);
  assert.equal(statut('u-libre'), 'annule'); // renouvellement coupé : Pro jusqu'à la fin de la période
  abonnements[1000].status = 2;
  assert.equal(await notifier('1000'), 200);
  assert.equal(statut('u-libre'), 'expire');
  // Un fondateur qui s'abonne quand même via Apple reste fondateur.
  abonnements[3000] = { env: 'Production', status: 1, transaction: { transactionId: '3000', originalTransactionId: '2900', productId: 'askesis.pro.an', expiresDate: Date.now() + 86400e3, appAccountToken: 'u-fondateur' } };
  assert.equal((await achatApple(h, 'jeton-fondateur', { transactionId: '3000' })).status, 200);
  const f = base.tables.abonnements.find(l => l.utilisateur === 'u-fondateur');
  assert.deepEqual([f.formule, f.transaction_apple], ['fondateur', '2900']);
  // Clé Apple pas encore posée sur le serveur : 503, Apple n'est pas appelé.
  const h2 = await chargerFonction('achats-apple', { ...envApple(cle), APPLE_IAP_PRIVATE_KEY: '' }, base);
  const n = journal.length;
  assert.equal((await achatApple(h2, 'jeton-libre', { transactionId: '1000' })).status, 503);
  assert.equal(journal.length, n);
});
