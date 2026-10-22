/* Faux serveur Supabase en mémoire, partagé entre plusieurs pages (plusieurs
   « appareils » d'un même compte) : tables, filtres eq / gt, upsert sur
   conflit. Comme jsonb, il ne rend pas les clés dans l'ordre d'écriture. */
function creerServeur() {
  const tables = new Map();
  const journal = [];
  const cleDe = (ligne, onConflict) => (onConflict || 'id').split(',').map(c => ligne[c.trim()]).join('|');
  const desordre = v => {
    if (Array.isArray(v)) return v.map(desordre);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().reverse().map(k => [k, desordre(v[k])]));
    return v;
  };
  const valeur = (ligne, col) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (ligne[m[1]] || {})[m[2]] : ligne[col];
  };
  async function traiter(req) {
    journal.push(req);
    if (!tables.has(req.table)) tables.set(req.table, new Map());
    const t = tables.get(req.table);
    if (req.op === 'upsert') {
      (req.lignes || []).forEach(l => t.set(cleDe(l, req.onConflict), JSON.parse(JSON.stringify(l))));
      return { data: null, error: null };
    }
    if (req.op !== 'select') return { data: null, error: null };
    let lignes = [...t.values()];
    (req.filtres || []).forEach(([op, col, val]) => {
      lignes = lignes.filter(l => {
        const v = valeur(l, col);
        if (op === 'eq') return String(v) === String(val);
        if (op === 'gt') return Number(v) > Number(val);
        if (op === 'in') return (val || []).map(String).includes(String(v));
        return true;
      });
    });
    lignes = lignes.map(desordre);
    return { data: req.single ? (lignes[0] || null) : lignes, error: null };
  }
  return { tables, journal, traiter };
}

/* Branche le client Supabase de la page sur le faux serveur, connecte
   l'utilisateur et coupe la synchro automatique (on la lance à la main). */
async function brancherServeur(page, serveur, utilisateur) {
  await page.exposeFunction('__serveur', req => serveur.traiter(req));
  await page.evaluate(uid => {
    const requete = table => {
      const q = { table, op: 'select', filtres: [] };
      const api = {
        select() { if (q.op !== 'upsert') q.op = 'select'; return api; },
        eq(c, v) { q.filtres.push(['eq', c, v]); return api; },
        gt(c, v) { q.filtres.push(['gt', c, v]); return api; },
        in(c, v) { q.filtres.push(['in', c, v]); return api; },
        order() { return api; }, limit() { return api; }, range() { return api; }, not() { return api; }, is() { return api; },
        maybeSingle() { q.single = true; return api; }, single() { q.single = true; return api; },
        upsert(lignes, o) { q.op = 'upsert'; q.lignes = Array.isArray(lignes) ? lignes : [lignes]; q.onConflict = o && o.onConflict; return api; },
        insert(lignes) { q.op = 'upsert'; q.lignes = Array.isArray(lignes) ? lignes : [lignes]; return api; },
        update() { q.op = 'update'; return api; }, delete() { q.op = 'delete'; return api; },
        then(ok, ko) { return window.__serveur(JSON.parse(JSON.stringify(q))).then(ok, ko); }
      };
      return api;
    };
    supa = { from: requete, rpc: () => ({ then: ok => Promise.resolve({ data: [], error: null }).then(ok) }),
      storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) },
      auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } };
    sessionUtilisateur = { id: uid, email: uid + '@test.fr' };
    planifierSync = () => {};
    userProfile.onboarding = userProfile.onboarding || new Date().toISOString();
  }, utilisateur);
}

module.exports = { creerServeur, brancherServeur };
