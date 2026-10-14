/* Données piégées pour les tests d'injection : chaque texte contient une
   balise <img> qui, si elle était insérée telle quelle dans la page,
   s'exécuterait (onerror) et laisserait une trace [data-xss]. */
const P = `"'><img src=x data-xss onerror=window.__xss=(window.__xss||0)+1>`;

/* Faux client Supabase : chaque requête renvoie des lignes dont tous les
   textes sont piégés, quelle que soit la table ou la fonction appelée. */
function installerFauxSupabase(page) {
  return page.evaluate(P => {
    const jour = todayStr();
    const seance = k => ({
      id: 'h' + k + P, programmeId: 'p' + P, programmeNom: 'Prog ' + P, date: jour, debut: Date.now() - 3600e3, fin: Date.now(),
      dureeMin: 60, notes: P, maj: Date.now(),
      exercices: [
        { exerciceId: toutesLesExercices()[0].id, nom: P, notes: P, tempo: P, plage: P, series: [{ poids: 80, reps: 8, fait: true, technique: P, rir: P }] },
        { exerciceId: 'x' + P, nom: P, series: [{ poids: 50, reps: 10, fait: true }] }
      ]
    });
    const journee = { weight: 80, steps: 7000, goal: 'maintien', maj: Date.now(),
      meals: { lunch: [{ name: P, grams: 100, kcal: 100, p: 10, c: 10, f: 1, code: P }] },
      workouts: [{ type: 'course', time: 30, distance: 5, intensite: 2, note: P }, { type: P, time: 20 }] };
    const ligne = k => ({
      utilisateur: 'u' + k + P, id: 'id' + k + P, email: P + '@x.fr', pseudo: P, nom: P, name: P, jour,
      createur_id: 'u' + P, createur_email: P, valide: k % 2 === 0, supprime: false, kcal100: 100, p100: 10, c100: 10, f100: 1, code_barre: P,
      partage_seances: true, type: 'suspendu', action: P, details: P, cree_le: new Date().toISOString(), date: jour, maj: Date.now(),
      derniere_connexion: new Date().toISOString(), created_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(),
      donnees: Object.assign({ id: 'd' + k + P, nom: P, notes: P, groupe: 'pectoraux', materiel: 'barre', image: P, video: P,
        ingredients: [{ nom: P, grammes: 100, kcal: 100 }], partagee: true, pseudo: P, geminiKey: P }, seance(k), journee)
    });
    const reponse = { data: [ligne(1), ligne(2)], error: null, count: 2 };
    const chaine = () => new Proxy(function () {}, {
      get: (t, nom) => nom === 'then' ? (ok => Promise.resolve(reponse).then(ok)) : chaine,
      apply: () => chaine()
    });
    supa = { from: () => chaine(), rpc: () => chaine(), storage: { from: () => chaine() },
      auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } };
    sessionUtilisateur = { id: 'admin', email: ADMIN_EMAIL };
    window.__seancePiegee = seance;
  }, P);
}

async function injectionsTrouvees(page) {
  return page.evaluate(() => {
    const n = document.querySelectorAll('[data-xss]').length + (window.__xss || 0);
    document.querySelectorAll('[data-xss]').forEach(e => e.remove());
    window.__xss = 0;
    return n;
  });
}

module.exports = { P, installerFauxSupabase, injectionsTrouvees };
