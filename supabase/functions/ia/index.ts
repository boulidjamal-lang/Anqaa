// Askēsis — l'IA côté serveur (Edge Function Supabase « ia »).
//
// La clé Gemini vit ici, dans le secret GEMINI_API_KEY : jamais dans
// l'appli, où n'importe qui pourrait la lire. Chaque demande est comptée
// par compte et par mois (table usages_ia, voir le SQL « Askēsis Pro » dans
// Administration) :
//   - Pro (essai, payé, offert, fondateur) : pas de limite pratique, avec un
//     plafond de sécurité de 600 demandes par mois ;
//   - sans Pro : 3 essais par mois.
// GET renvoie où en est le compte (Pro, essais restants) ; POST transmet la
// demande à Gemini. Une demande qui échoue côté Gemini est rendue.
//
// Déploiement : voir PRO_mise_en_service.md (vérification du JWT activée).

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const ESSAIS_GRATUITS = 3;
const PLAFOND_PRO = 600;
// Le premier est celui de l'appli (GEMINI_MODEL dans index.html).
const MODELES = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const TAILLE_MAX = 6_000_000; // une photo compressée et le texte, largement

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(corps: unknown, status = 200) {
  return new Response(JSON.stringify(corps), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Abonnement = { statut: string; fin: string | null } | null;

function estPro(a: Abonnement) {
  return !!a && ['actif', 'essai', 'annule', 'impaye'].includes(a.statut) && (!a.fin || new Date(a.fin) > new Date());
}

function debutDuMois() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const jeton = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(jeton);
  const moi = auth && auth.user ? auth.user.id : null;
  if (!moi) return json({ erreur: "Connecte-toi pour utiliser l'IA." }, 401);

  const { data: abonnement } = await admin.from('abonnements').select('statut, fin').eq('utilisateur', moi).maybeSingle();
  const pro = estPro(abonnement as Abonnement);

  if (req.method === 'GET') {
    const { data: usage } = await admin.from('usages_ia').select('nombre').eq('utilisateur', moi).eq('mois', debutDuMois()).maybeSingle();
    const pris = usage ? usage.nombre : 0;
    return json({ pret: !!Deno.env.get('GEMINI_API_KEY'), pro, restant: pro ? null : Math.max(0, ESSAIS_GRATUITS - pris) });
  }
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);

  const cle = Deno.env.get('GEMINI_API_KEY');
  if (!cle) return json({ erreur: "L'IA n'est pas encore configurée sur le serveur." }, 503);

  const brut = await req.text();
  if (brut.length > TAILLE_MAX) return json({ erreur: 'Demande trop lourde (photo trop grande ?).' }, 413);
  let demande: { parts?: unknown[]; modele?: string };
  try { demande = JSON.parse(brut); } catch { return json({ erreur: 'Demande illisible.' }, 400); }
  if (!Array.isArray(demande.parts) || !demande.parts.length) return json({ erreur: 'Demande vide.' }, 400);
  const modele = MODELES.includes(String(demande.modele)) ? String(demande.modele) : MODELES[0];

  // Compté avant l'appel (deux demandes en même temps ne dépassent pas la limite).
  const { data: total, error } = await admin.rpc('compter_usage_ia', { p_utilisateur: moi, p_limite: pro ? PLAFOND_PRO : ESSAIS_GRATUITS });
  if (error) return json({ erreur: "Compteur d'essais indisponible : " + error.message }, 500);
  if (total == null) {
    return json(pro
      ? { erreur: 'Plafond de sécurité atteint pour ce mois. Réessaie le mois prochain.', code: 'plafond' }
      : { erreur: `Tes ${ESSAIS_GRATUITS} essais IA du mois sont utilisés. Passe à Pro pour continuer.`, code: 'pro_requis', restant: 0 }, 402);
  }

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle },
    body: JSON.stringify({ contents: [{ parts: demande.parts }] }),
  });
  const reponse = await r.json().catch(() => ({}));
  if (!r.ok) await admin.rpc('rendre_usage_ia', { p_utilisateur: moi });
  const pris = r.ok ? total : total - 1;
  return json({ ...reponse, pro, restant: pro ? null : Math.max(0, ESSAIS_GRATUITS - pris) }, r.status);
});
