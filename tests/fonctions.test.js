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
