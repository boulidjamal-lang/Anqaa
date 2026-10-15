/* Tests de bout en bout d'Anqā : l'appli réelle (index.html) dans Chromium,
   pilotée comme un utilisateur ou par ses propres fonctions quand l'écran
   n'apporte rien (ex. : choisir un exercice dans la liste). Chaque test part
   d'une appli vierge (stockage local vide) et échoue si la page lève la
   moindre erreur JavaScript.
   Lancer : npm install, puis npm test. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lancerNavigateur, ouvrirAppli, RACINE } = require('./outils');
const { P, installerFauxSupabase, injectionsTrouvees } = require('./injection');

let navigateur;
before(async () => { navigateur = await lancerNavigateur(); });
after(async () => { if (navigateur) await navigateur.close(); });

async function avecAppli(options, corps) {
  const appli = await ouvrirAppli(navigateur, options);
  try {
    await corps(appli);
    assert.deepEqual(appli.erreurs, [], 'erreurs JavaScript dans la page');
  } finally {
    await appli.ctx.close();
  }
}

test('les versions des bibliothèques sont figées', () => {
  const html = fs.readFileSync(path.join(RACINE, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  for (const src of scripts) assert.match(src, /@\d+\.\d+\.\d+/, `version exacte manquante : ${src}`);
  const versionChart = JSON.parse(fs.readFileSync(path.join(RACINE, 'node_modules/chart.js/package.json'), 'utf8')).version;
  assert.ok(html.includes(`chart.js@${versionChart}/`), `les tests utilisent Chart.js ${versionChart}, l'appli une autre version`);
});

test('chaque script de la page se compile', () => {
  const html = fs.readFileSync(path.join(RACINE, 'index.html'), 'utf8');
  const blocs = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocs.length > 0);
  for (const b of blocs) new Function(b[1]);
});

test("l'appli se charge et chaque écran s'ouvre", () => avecAppli({}, async ({ page }) => {
  for (const ecran of ['repas', 'seance', 'stats', 'reglages', 'repas']) {
    await page.evaluate(e => allerA(e), ecran);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => ecranActif), ecran);
    assert.ok(await page.isVisible('#ecran-' + ecran));
  }
}));

test('ajouter un aliment met à jour le résumé du jour', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    activeMealId = 'lunch';
    document.getElementById('man-name').value = 'Riz test';
    document.getElementById('man-grams').value = '200';
    document.getElementById('man-kcal100').value = '130';
    document.getElementById('man-p100').value = '2.7';
    document.getElementById('man-c100').value = '28';
    document.getElementById('man-f100').value = '0.3';
    validerAjoutManuel();
  });
  const r = await page.evaluate(() => ({ items: getDay(todayStr()).meals.lunch.length, total: document.getElementById('total-kcals').textContent }));
  assert.equal(r.items, 1);
  assert.match(r.total, /260/);
}));

test('les pas remplissent la jauge et la dépense', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => allerA('repas'));
  assert.match(await page.textContent('#jauge-pas'), /Indique tes pas/);
  const avant = await page.evaluate(() => computeTargets(getDay(todayStr()), todayStr()).tdee);
  await page.fill('#daily-steps', '8500');
  await page.dispatchEvent('#daily-steps', 'change');
  assert.match(await page.textContent('#jauge-pas'), /Actif/);
  const r = await page.evaluate(() => ({ pas: getDay(todayStr()).steps, tdee: computeTargets(getDay(todayStr()), todayStr()).tdee }));
  assert.equal(r.pas, 8500);
  assert.ok(r.tdee > avant, 'les pas en plus doivent augmenter la dépense');
}));

test('une séance de musculation se fait et se termine', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    allerA('seance'); choisirModeSeance('muscu');
    demarrerSeanceLibre();
    ajouterExerciceASession(toutesLesExercices().find(e => e.groupe === 'pectoraux').id);
    document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    modifierSerieSession(0, 0, 'poids', '60');
    modifierSerieSession(0, 0, 'reps', '10');
    basculerSerieSession(0, 0);
  });
  assert.ok(await page.evaluate(() => musculationSessionActive.exercices[0].series[0].fait));
  await page.evaluate(() => terminerSeance());
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    enCours: !!musculationSessionActive,
    historique: musculationHistorique.length,
    seanceDuJour: getDay(todayStr()).workouts.filter(w => w.source === 'seance').length
  }));
  assert.deepEqual(r, { enCours: false, historique: 1, seanceDuJour: 1 });
}));

async function glisser(page, selecteur, dx) {
  const b = await page.locator(selecteur).first().boundingBox();
  const x = b.x + b.width / 2, y = b.y + Math.min(20, b.height / 2);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(x + dx * k / 10, y);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("éditeur de programme : glisser pour retirer ou remplacer, toucher le nom pour l'historique", () => avecAppli({}, async ({ page, dialogues }) => {
  await page.evaluate(() => {
    allerA('seance'); choisirModeSeance('muscu'); ouvrirCreationProgramme();
    const ids = toutesLesExercices().slice(0, 3).map(e => e.id);
    programmeEnEdition.exercices = ids.slice(0, 2).map(id => ({ exerciceId: id, series: [{ poids: 40, reps: 10 }, { poids: 40, reps: 10 }], tempo: '3010', plage: '8-12' }));
    window.__ids = ids;
    renderProgrammeExercicesEnEdition();
  });
  assert.equal(await page.locator('#programme-exercices-container .btn-delete').count(), 0, 'plus de bouton ✕');
  // Glisser à droite : remplacer
  await glisser(page, '#programme-exercices-container .exo-swipe:nth-child(1) .exo-en-programme-entete', 160);
  await page.waitForSelector('#picker-exercices-modal.show');
  await page.evaluate(() => choisirExercicePicker(window.__ids[2]));
  let r = await page.evaluate(() => programmeEnEdition.exercices.map(e => [e.exerciceId, e.series.length, e.tempo, e.plage]));
  assert.deepEqual(r[0], [await page.evaluate(() => window.__ids[2]), 2, '3010', '8-12']);
  // Glisser à gauche : retirer (avec confirmation)
  await glisser(page, '#programme-exercices-container .exo-swipe:nth-child(2) .exo-en-programme-entete', -160);
  r = await page.evaluate(() => programmeEnEdition.exercices.length);
  assert.equal(r, 1);
  assert.ok(dialogues.some(d => /Retirer/.test(d)), 'une confirmation est demandée');
  // Toucher le nom : fiche sur le résumé
  await page.click('#programme-exercices-container .exo-en-programme-nom');
  await page.waitForSelector('#fiche-exercice-modal.show');
  assert.equal(await page.evaluate(() => document.querySelector('#fiche-exercice-modal [aria-pressed="true"]')?.textContent.trim()), 'Résumé');
}));

test('éditeur de programme : appui long pour déplacer un exercice', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    allerA('seance'); choisirModeSeance('muscu'); ouvrirCreationProgramme();
    programmeEnEdition.exercices = toutesLesExercices().slice(0, 4).map(e => ({ exerciceId: e.id, series: [{ poids: 40, reps: 10 }] }));
    renderProgrammeExercicesEnEdition();
  });
  const avant = await page.evaluate(() => programmeEnEdition.exercices.map(e => e.exerciceId));
  const b = await page.locator('#programme-exercices-container .exo-en-programme-entete').first().boundingBox();
  const x = b.x + 60, y = b.y + 15;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.waitForTimeout(600);
  assert.ok(await page.evaluate(() => document.getElementById('programme-exercices-container').classList.contains('reordre')), 'les exercices se replient');
  for (let k = 1; k <= 10; k++) await page.mouse.move(x, y + k * 14);
  await page.mouse.up(); await page.waitForTimeout(300);
  const apres = await page.evaluate(() => programmeEnEdition.exercices.map(e => e.exerciceId));
  assert.deepEqual(apres, [avant[1], avant[2], avant[0], avant[3]]);
  assert.equal(await page.evaluate(() => !!document.querySelector('#fiche-exercice-modal.show')), false, "l'appui long n'ouvre pas la fiche");
  assert.equal(await page.locator('#programme-exercices-container .exo-en-programme-reordre').count(), 0, 'plus de flèches');
}));

test('remplacer un exercice propose des exercices similaires', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const squat = toutesLesExercices().find(e => /^squat avec barre$/i.test(e.nom)) || toutesLesExercices().find(e => /squat/i.test(e.nom));
    allerA('seance'); choisirModeSeance('muscu'); demarrerSeanceLibre(); ajouterExerciceASession(squat.id);
    document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    remplacerExerciceSession(0);
    const titres = [...document.querySelectorAll('#picker-liste-exercices .picker-titre-bloc')].map(x => x.textContent);
    const lignes = [...document.querySelectorAll('#picker-liste-exercices .exo-ligne')].slice(0, 6).map(x => x.querySelector('.exo-ligne-nom').textContent);
    return { squat: squat.nom, titres, lignes };
  });
  assert.deepEqual(r.titres, ['Exercices similaires', 'Toute la bibliothèque']);
  assert.ok(r.lignes.filter(n => /squat/i.test(n)).length >= 4, 'des squats sont proposés pour remplacer un squat : ' + r.lignes.join(', '));
  assert.ok(!r.lignes.includes(r.squat), "l'exercice remplacé n'est pas proposé");
}));

test('un programme se crée puis se supprime sans revenir', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    allerA('seance'); choisirModeSeance('muscu');
    ouvrirCreationProgramme();
    document.getElementById('programme-nom-input').value = 'Push test';
    ouvrirPickerExercices('programme');
    choisirExercicePicker(toutesLesExercices()[0].id);
    document.querySelectorAll('.modal.show, .feuille.show').forEach(m => m.classList.remove('show'));
    validerProgramme();
  });
  const id = await page.evaluate(() => (musculationProgrammes.find(p => p.nom === 'Push test') || {}).id);
  assert.ok(id, 'le programme doit être enregistré');
  assert.match(await page.textContent('#programmes-liste-container'), /Push test/);
  await page.evaluate(id => supprimerProgramme(id), id);
  const r = await page.evaluate(id => ({
    reste: musculationProgrammes.some(p => p.id === id),
    marque: !!(JSON.parse(localStorage.getItem(MUSCU_TOMBES_LS) || '{}').programmes_musculation || {})[id]
  }), id);
  assert.deepEqual(r, { reste: false, marque: true });
}));

test('le cardio : ajouter, modifier, supprimer une séance', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('cardio'); });
  const avant = await page.evaluate(() => computeTargets(getDay(todayStr()), todayStr()).tdee);
  await page.click('.cardio-ajouter');
  // ouvrirModal place le curseur dans le premier champ 60 ms après
  // l'ouverture : on l'attend, sinon la saisie suivante y atterrirait.
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'cardio-duree');
  await page.fill('#cardio-duree', '30');
  await page.fill('#cardio-distance', '5');
  assert.match(await page.textContent('#cardio-allure'), /6:00 \/km/);
  await page.click('#modal-cardio .btn-primary');
  let r = await page.evaluate(() => ({ nb: seancesCardio().length, w: seancesCardio()[0].w, tdee: computeTargets(getDay(todayStr()), todayStr()).tdee }));
  assert.equal(r.nb, 1);
  assert.deepEqual([r.w.type, r.w.time, r.w.distance, r.w.intensite], ['course', 30, 5, 2]);
  assert.ok(r.tdee > avant, 'la séance doit augmenter la dépense du jour');
  assert.match(await page.textContent('#seance-cardio .cardio-gros'), /^30/);
  // Modifier : passer en intense (compte double dans la jauge)
  await page.click('#seance-cardio .cardio-seance');
  await page.click('#cardio-intensites button:nth-child(3)');
  await page.click('#modal-cardio .btn-primary');
  assert.match(await page.textContent('#seance-cardio .cardio-gros'), /^60/);
  // Supprimer
  await page.click('#seance-cardio .cardio-seance');
  await page.click('#btn-suppr-cardio');
  r = await page.evaluate(() => seancesCardio().length);
  assert.equal(r, 0);
}));

test("historique d'un programme : toucher un exercice ouvre sa courbe", () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.groupe === 'epaules') || toutesLesExercices()[0];
    for (let k = 0; k < 4; k++) {
      const date = shiftDate(todayStr(), -7 * k);
      musculationHistorique.push({ id: 'h' + k, programmeId: 'p1', programmeNom: 'Épaules', date, debut: Date.now() - 3e6, fin: Date.now(), dureeMin: 50, maj: Date.now(),
        exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 20 + k, reps: 10, fait: true }, { poids: 22 + k, reps: 8, fait: true }] }] });
    }
    sauvegarderHistorique();
    allerA('stats'); choisirOngletStats('muscu'); choisirSousOngletMuscu('programmes');
  });
  await page.click('#muscu-stats-programmes [onclick^="voirDetailProgramme"]');
  await page.waitForSelector('#programme-detail-modal.show');
  await page.click('#programme-detail-container .detail-exo-titre');
  await page.waitForSelector('#fiche-exercice-modal.show');
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({ visible: !!document.querySelector('#fiche-exercice-modal.show'), courbe: !!document.querySelector('#fiche-resume-courbe canvas, #fiche-resume-courbe svg') }));
  assert.deepEqual(r, { visible: true, courbe: true });
}));

test('la bibliothèque s\'ouvre vite et ne lance que quelques vidéos', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const t0 = performance.now(); ouvrirBibliotheque(); const duree = performance.now() - t0;
    return { duree, lignes: document.querySelectorAll('#picker-liste-exercices .exo-ligne').length, total: toutesLesExercices().length };
  });
  assert.ok(r.total > 200);
  assert.ok(r.lignes <= 60, `rendu progressif attendu, ${r.lignes} lignes d'un coup`);
  assert.ok(r.duree < 200, `ouverture trop lente : ${Math.round(r.duree)} ms`);
  for (let k = 0; k < 15; k++) { await page.evaluate(() => { document.querySelector('#picker-exercices-modal .modal-content').scrollTop += 1200; }); await page.waitForTimeout(50); }
  await page.waitForTimeout(700);
  const apres = await page.evaluate(() => ({ lignes: document.querySelectorAll('#picker-liste-exercices .exo-ligne').length, videos: document.querySelectorAll('#picker-liste-exercices video').length }));
  assert.ok(apres.lignes > r.lignes, 'la suite se charge en défilant');
  assert.ok(apres.videos <= 4, `${apres.videos} vidéos à la fois`);
  // Liste immobile : plus aucune vidéo créée ni retirée (pas de clignotement)
  const remous = await page.evaluate(() => new Promise(ok => {
    let n = 0;
    const obs = new MutationObserver(ms => ms.forEach(m => [...m.addedNodes, ...m.removedNodes].forEach(x => { if (x.tagName === 'VIDEO' || x.tagName === 'IMG') n++; })));
    obs.observe(document.getElementById('picker-liste-exercices'), { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); ok(n); }, 2500);
  }));
  assert.equal(remous, 0, `${remous} vignettes remplacées alors que la liste ne bouge pas`);
  // La recherche filtre toujours toute la base
  await page.fill('#picker-recherche', 'développé couché');
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.querySelectorAll('#picker-liste-exercices .exo-ligne').length) > 0);
}));

test("un lien d'image SmartWorkout collé comme vidéo est remplacé par la vraie vidéo", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const IMG_AB_COASTER = 'https://api.smartworkout.app/asset/image/4e939dab-2978-4d2f-82f0-74cafb543e9a';
    const connu = videoExercice({ id: 'x', video: IMG_AB_COASTER });
    const inconnu = videoExercice({ id: 'y', video: 'https://exemple.fr/photo.jpg' });
    const vraieVideo = videoExercice({ id: 'z', video: 'https://exemple.fr/demo.mp4' });
    // Vignette et fiche d'un exercice dont l'image est inconnue : une photo, pas un carré noir
    const vignette = medaillonExercice({ id: 'y', nom: 'Test', groupe: 'abdominaux', materiel: 'poids_corps', video: 'https://exemple.fr/photo.jpg' });
    return { connu, inconnu, vraieVideo, vignetteImg: /^<img/.test(vignette) };
  });
  assert.equal(r.connu.video, 'https://api.smartworkout.app/asset/video/1e4902a0-05fc-4ab0-8fcd-5e745eb096af.mp4');
  assert.equal(r.inconnu.video, null);
  assert.equal(r.inconnu.poster, 'https://exemple.fr/photo.jpg');
  assert.equal(r.vraieVideo.video, 'https://exemple.fr/demo.mp4');
  assert.ok(r.vignetteImg, 'une image inconnue s\'affiche comme photo');
}));

test('stats muscu : détail par faisceau et déséquilibres (pecs, épaules, dos)', () => avecAppli({}, async ({ page }) => {
  const lire = () => page.evaluate(() => {
    renderZonesMuscu('muscu-zones-container');
    const res = {};
    document.querySelectorAll('#muscu-zones-container details.faisceaux').forEach(d => {
      res[d.dataset.groupe] = {
        lignes: d.querySelectorAll('.faisceau-ligne').length,
        alertes: [...d.querySelectorAll('.alerte-volume-seance')].map(a => a.textContent.trim())
      };
    });
    return res;
  });
  // Semaine déséquilibrée : développé couché, développé militaire et tractions seulement.
  await page.evaluate(() => {
    allerA('stats'); choisirOngletStats('muscu');
    const id = nom => { const e = toutesLesExercices().find(x => x.nom === nom); if (!e) throw new Error('exercice introuvable : ' + nom); return e.id; };
    const series = n => Array.from({ length: n }, () => ({ poids: 50, reps: 8, fait: true, rir: 1 }));
    window.ajouterSeanceTest = noms => {
      musculationHistorique.unshift({ id: 'test-' + musculationHistorique.length, date: todayStr(), exercices: noms.map(nom => ({ exerciceId: id(nom), series: series(6) })) });
    };
    ajouterSeanceTest(['Développé couché avec barre', 'Développé épaules avec haltères', 'Tractions prise large']);
  });
  let r = await lire();
  assert.deepEqual(Object.keys(r).sort(), ['biceps', 'dos', 'epaules', 'pectoraux', 'triceps']);
  assert.deepEqual([r.pectoraux.lignes, r.epaules.lignes, r.dos.lignes], [3, 3, 2]);
  const toutes = ['pectoraux', 'epaules', 'dos'].flatMap(g => r[g].alertes).join(' | ');
  for (const motif of [/postérieur/, /latéral/, /haut des pectoraux/i, /rowing/i]) assert.match(toutes, motif);
  // La somme des faisceaux retombe sur le total du groupe.
  const ecart = await page.evaluate(() => {
    const f = {};
    const s = seriesSemaine(lundiDeLaSemaine(todayStr()), false, null, f);
    return Object.keys(FAISCEAUX).map(g => Math.abs(FAISCEAUX[g].reduce((t, [c]) => t + (f[c] || 0), 0) - (s[g] || 0)));
  });
  assert.ok(ecart.every(e => e < 1e-9), 'faisceaux ≠ total du groupe : ' + ecart);
  // Compléter : incliné, rowing, oiseau, élévations latérales → plus d'alerte.
  await page.evaluate(() => ajouterSeanceTest(['Développé incliné avec haltères', 'Rowing barre buste penché', 'Reverse fly à la poulie', 'Élévation latérale avec haltères']));
  r = await lire();
  assert.deepEqual(['pectoraux', 'epaules', 'dos'].flatMap(g => r[g].alertes), []);
}));

test('faisceaux : affichés sur la fiche, réglables dans Administration, données piégées ignorées', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.nom === 'Développé incliné avec haltères');
    const res = {};
    // Fiche : estimation (haut principal, milieu un peu ; antérieur pour les épaules).
    afficherFicheExerciceBiblio(exo.id);
    const lire = () => [...document.querySelectorAll('#fiche-exercice-container .fiche-faisceaux')].map(l => [...l.children].map(x => x.textContent.trim()).join(' '));
    res.ficheEstimee = lire();
    res.noteEstimee = /Estimés/.test(document.querySelector('#fiche-exercice-container .fiche-faisceaux-bloc').textContent);
    fermerModal('fiche-exercice-modal');
    // Administration : toucher « Bas » (non sollicité → principal), « Haut » (principal → un peu).
    editerExerciceAdmin({ ...exo, estBase: true });
    const puce = cle => document.querySelector(`#edit-exo-faisceaux [data-groupe="pectoraux"] [data-faisceau="${cle}"]`);
    res.avant = ['pec_haut', 'pec_milieu', 'pec_bas'].map(c => puce(c).dataset.niveau);
    puce('pec_bas').click(); puce('pec_haut').click();
    res.apres = ['pec_haut', 'pec_milieu', 'pec_bas'].map(c => puce(c).dataset.niveau);
    res.enregistre = faisceauxAEnregistrer(document.getElementById('edit-exo-groupe').value);
    document.querySelector('#edit-exo-faisceaux [data-groupe="pectoraux"] .admin-faisceaux-tete button').click();
    res.retourAuto = faisceauxAEnregistrer('pectoraux');
    fermerModal('modal-edit-exercice-admin');
    // Choix enregistré : il passe avant l'estimation, sur la fiche et dans les stats.
    exo.faisceaux = { pectoraux: { pec_bas: 2, pec_haut: 1 } };
    afficherFicheExerciceBiblio(exo.id);
    res.ficheChoisie = lire();
    res.poids = repartitionFaisceaux(exo, 'pectoraux');
    // Données piégées (exercice partagé par un autre compte) : ignorées.
    res.piege = repartitionFaisceaux({ nom: 'Développé couché', groupe: 'pectoraux', faisceaux: { pectoraux: { '<img src=x onerror=alert(1)>': 2, pec_haut: 7, constructor: 2 } } }, 'pectoraux');
    delete exo.faisceaux;
    return res;
  });
  assert.deepEqual(r.ficheEstimee, ['Pectoraux Haut Milieu', 'Épaules Antérieur', 'Triceps Longue portion Vaste latéral Vaste médial']);
  assert.ok(r.noteEstimee);
  assert.deepEqual(r.avant, ['2', '1', '0']);
  assert.deepEqual(r.apres, ['1', '1', '2']);
  assert.deepEqual(r.enregistre, { pectoraux: { pec_haut: 1, pec_milieu: 1, pec_bas: 2 } });
  assert.equal(r.retourAuto, null);
  assert.deepEqual(r.ficheChoisie, ['Pectoraux Haut Bas', 'Épaules Antérieur', 'Triceps Longue portion Vaste latéral Vaste médial']);
  assert.ok(Math.abs(r.poids.pec_bas - 1 / 1.4) < 1e-9 && Math.abs(r.poids.pec_haut - 0.4 / 1.4) < 1e-9);
  assert.deepEqual(r.piege, { pec_milieu: 0.6, pec_haut: 0.2, pec_bas: 0.2 });
}));

test('faisceaux des jambes : règles, alertes et mannequin (fiche et statistiques)', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = nom => { const e = toutesLesExercices().find(x => x.nom === nom); if (!e) throw new Error('exercice introuvable : ' + nom); return e; };
    const res = {};
    res.legExt = repartitionFaisceaux(exo('Extension des jambes'), 'quadriceps');
    res.squat = niveauxDepuisPoids(repartitionFaisceaux(exo('Squat avec barre'), 'quadriceps'));
    res.mollAssis = repartitionFaisceaux(exo('Élévation des mollets assis'), 'mollets');
    res.abduction = repartitionFaisceaux(exo('Abduction de la hanche à la poulie'), 'fessiers');
    res.curl = repartitionFaisceaux(exo('Curl des ischio-jambiers en position couchée'), 'ischios');
    // Semaine : squats (sans les mollets en secondaire), leg curl et mollets debout seulement.
    const series = n => Array.from({ length: n }, () => ({ poids: 50, reps: 8, fait: true, rir: 1 }));
    musculationHistorique.unshift({ id: 'jambes', date: todayStr(), exercices: ['Squat avec haltères', 'Curl des ischio-jambiers en position couchée', 'Élévation des Mollets Debout'].map(n => ({ exerciceId: exo(n).id, series: series(6) })) });
    allerA('stats'); choisirOngletStats('muscu');
    renderZonesMuscu('muscu-zones-container');
    res.alertes = {};
    document.querySelectorAll('#muscu-zones-container details.faisceaux').forEach(d => {
      res.alertes[d.dataset.groupe] = [...d.querySelectorAll('.alerte-volume-seance')].map(a => a.textContent.trim());
      if (!d.querySelector('svg.figure-faisceaux')) res.sansFigure = (res.sansFigure || []).concat(d.dataset.groupe);
    });
    // Fiche : le mannequin montre les faisceaux, de face et de dos pour un squat.
    afficherFicheExerciceBiblio(exo('Squat avec barre').id);
    res.figuresFiche = [...document.querySelectorAll('#fiche-exercice-container .fiche-faisceaux-bloc figcaption')].map(f => f.textContent);
    res.colores = document.querySelectorAll('#fiche-exercice-container .fiche-faisceaux-bloc svg path[style*="--fx-fiche"]').length;
    return res;
  });
  assert.equal(r.legExt.quad_droit, 0.5);
  assert.deepEqual(r.squat, { quad_ext: 2, quad_int: 2, quad_droit: 1 });
  assert.ok(r.mollAssis.mol_soleaire > r.mollAssis.mol_gastro);
  assert.ok(r.abduction.fes_moyen > r.abduction.fes_grand);
  assert.ok(r.curl.isch_semi > r.curl.isch_biceps);
  assert.match(r.alertes.quadriceps.join(' '), /leg extension/);
  assert.match(r.alertes.ischios.join(' '), /mouvement de hanche/);
  assert.match(r.alertes.mollets.join(' '), /mollets assis/);
  assert.equal(r.sansFigure, undefined, 'chaque détail par faisceau a son mannequin');
  assert.deepEqual(r.figuresFiche, ['Face', 'Dos']);
  assert.ok(r.colores > 4);
}));

test('faisceaux du biceps et du triceps : règles et alertes', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = nom => { const e = toutesLesExercices().find(x => x.nom === nom); if (!e) throw new Error('exercice introuvable : ' + nom); return e; };
    const principal = (nom, g) => Object.entries(niveauxDepuisPoids(repartitionFaisceaux(exo(nom), g))).filter(([, n]) => n === 2).map(([k]) => k).sort();
    const res = {
      incline: principal('Curl incliné assis pour biceps', 'biceps'),
      pupitre: principal('Curl au pupitre avec barre', 'biceps'),
      marteau: principal('Curl prise marteau', 'biceps'),
      overhead: principal('Extension triceps unilatérale au-dessus de la tête', 'triceps'),
      pushdown: principal('Extension des triceps à la corde', 'triceps'),
      serre: principal('Développé couché prise serrée', 'triceps')
    };
    // Semaine : curls au pupitre et pushdowns seulement.
    const series = n => Array.from({ length: n }, () => ({ poids: 30, reps: 10, fait: true, rir: 1 }));
    musculationHistorique.unshift({ id: 'bras', date: todayStr(), exercices: ['Curl au pupitre avec barre', 'Extension des triceps à la corde'].map(n => ({ exerciceId: exo(n).id, series: series(6) })) });
    allerA('stats'); choisirOngletStats('muscu');
    renderZonesMuscu('muscu-zones-container');
    res.alertes = {};
    document.querySelectorAll('#muscu-zones-container details.faisceaux').forEach(d => { res.alertes[d.dataset.groupe] = [...d.querySelectorAll('.alerte-volume-seance')].map(a => a.textContent.trim()).join(' | '); });
    res.figures = ['biceps', 'triceps'].map(g => document.querySelectorAll(`#muscu-zones-container details.faisceaux[data-groupe="${g}"] svg.figure-faisceaux`).length);
    return res;
  });
  assert.deepEqual(r.incline, ['bic_long']);
  assert.deepEqual(r.pupitre, ['bic_court']);
  assert.deepEqual(r.marteau, ['bic_brachial']);
  assert.deepEqual(r.overhead, ['tri_long']);
  assert.deepEqual(r.pushdown, ['tri_lat']);
  assert.deepEqual(r.serre, ['tri_lat']);
  assert.match(r.alertes.biceps, /curl incliné/);
  assert.match(r.alertes.biceps, /marteau/);
  assert.match(r.alertes.triceps, /au-dessus de la tête/);
  assert.deepEqual(r.figures, [1, 2], 'biceps de face, triceps de face et de dos');
}));

test('en-tête : ma photo et mon nom d\'utilisateur ouvrent le profil, plus de bouton Profil dans le menu', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const lire = () => ({ nom: document.getElementById('moi-entete-nom').textContent, img: !!document.querySelector('#moi-entete-avatar img') });
    const res = {};
    sessionUtilisateur = null; monPseudo = null; monProfil = null; majEnteteMoi();
    res.deconnecte = lire();
    sessionUtilisateur = { id: 'moi', email: 'jamal@x.fr' }; majEnteteMoi();
    res.sansPseudo = lire();
    monPseudo = { pseudo: 'jamal', partage_seances: true }; monProfil = { bio: '', avatar: 'data:image/jpeg;base64,/9j/4AAQ==' }; majEnteteMoi();
    res.complet = lire();
    sessionUtilisateur = null; majEnteteMoi();
    res.apresDeconnexion = lire();
    allerA('repas');
    document.getElementById('moi-entete').click();
    res.ecran = ecranActif;
    res.boutonProfil = !!document.getElementById('nav-reglages');
    res.position = getComputedStyle(document.querySelector('.app-bar')).position;
    // Halo de synchronisation autour de la photo (synchro configurée : puce visible).
    const puce = document.getElementById('puce-sync');
    puce.classList.remove('hidden');
    res.halo = ['ok', 'erreur', 'sync'].map(e => { majEtatSync(e); return document.getElementById('moi-entete').dataset.sync; });
    res.label = document.getElementById('moi-entete').getAttribute('aria-label');
    res.puceVisible = getComputedStyle(puce).display;
    res.compte = document.getElementById('reglages-puce-sync-txt').textContent;
    puce.classList.add('hidden'); majEtatSync('attente');
    res.sansSynchro = document.getElementById('moi-entete').dataset.sync || null;
    const barre = document.querySelector('.app-bar-inner').getBoundingClientRect();
    res.aDroite = Math.round(barre.right - document.getElementById('moi-entete').getBoundingClientRect().right) < 4;
    const logo = document.querySelector('.app-bar .logo-anqa').getBoundingClientRect();
    res.logoAGauche = logo.width > 0 && logo.left - barre.left < 4;
    // Le halo (anneau 2 px + lueur ~9 px) doit tenir dans la barre, sans déborder en haut.
    const photo = document.getElementById('moi-entete-avatar').getBoundingClientRect();
    res.margeHaut = Math.round(photo.top - document.querySelector('.app-bar').getBoundingClientRect().top);
    return res;
  });
  assert.deepEqual(r.deconnecte, { nom: 'Se connecter', img: false });
  assert.deepEqual(r.sansPseudo, { nom: 'jamal', img: false });
  assert.deepEqual(r.complet, { nom: 'jamal', img: true });
  assert.equal(r.apresDeconnexion.img, false, 'jamais la photo du compte précédent');
  assert.equal(r.ecran, 'reglages');
  assert.equal(r.boutonProfil, false);
  assert.equal(r.position, 'relative', 'la barre défile avec la page, comme avant');
  assert.deepEqual(r.halo, ['ok', 'erreur', 'sync']);
  assert.equal(r.label, 'Mon profil — synchronisation : Envoi…');
  assert.equal(r.puceVisible, 'none', 'plus de voyant texte dans la barre');
  assert.equal(r.compte, 'Synchronisation : Envoi…');
  assert.equal(r.sansSynchro, null, 'pas de halo sans synchronisation configurée');
  assert.ok(r.aDroite, 'photo et nom calés à droite');
  assert.ok(r.logoAGauche, 'logo Anqā visible à gauche');
  assert.ok(r.margeHaut >= 11, 'place pour le halo au-dessus de la photo : ' + r.margeHaut + ' px');
}));

test('les statistiques s\'affichent sur chaque onglet et chaque période', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const t = todayStr();
    for (let k = 0; k < 30; k += 3) {
      const d = getDay(shiftDate(t, -k));
      d.steps = 6000 + k * 100; d.weight = 80 - k * 0.05;
      d.workouts.push({ type: 'course', time: 30, distance: 5 + (k % 2), intensite: 2 });
      saveData(shiftDate(t, -k));
    }
    allerA('stats');
  });
  for (const onglet of ['poids', 'nutrition', 'activite', 'muscu']) {
    for (const periode of await page.evaluate(() => PERIODES_STATS.map(p => p[0]).filter(p => p !== 'perso'))) {
      await page.evaluate(([o, p]) => { choisirOngletStats(o); choisirPeriodeStats(p); }, [onglet, periode]);
    }
  }
  const r = await page.evaluate(() => ({ semaines: !!cardioSemainesChartInstance, allure: !!cardioAllureChartInstance, records: document.querySelectorAll('#cardio-records .cardio-record').length }));
  assert.deepEqual(r, { semaines: true, allure: true, records: 3 });
}));

test('après le questionnaire : « Par où commencer ? » puis la carte « Premiers pas »', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    document.getElementById('onb-age').value = 30;
    document.getElementById('onb-taille').value = 180;
    document.getElementById('onb-poids').value = 80;
    Object.assign(onbReponses, { gender: 'm', goal: 'maintien', pasHabituels: 6000 });
    onbTerminer();
  });
  await page.waitForSelector('#modal-interets.show');
  await page.click('#modal-interets .interet[data-interet="nutrition"]');
  await page.click('#modal-interets .interet[data-interet="cardio"]');
  await page.click('#btn-interets-ok');
  // Seule la musculation reste choisie : on démarre sur l'écran Activité.
  assert.deepEqual(await page.evaluate(() => [userProfile.premiersPas.interets, ecranActif, modeSeance]), [['muscu'], 'seance', 'muscu']);
  await page.evaluate(() => allerA('repas'));
  assert.match(await page.textContent('#premiers-pas'), /1\/2/);
  // L'étape se coche toute seule une fois faite
  await page.evaluate(() => { musculationProgrammes.push({ id: 'p1', nom: 'Test', exercices: [] }); renderPremiersPas(); });
  assert.match(await page.textContent('#premiers-pas'), /Bravo/);
  await page.click('.pp-masquer');
  assert.equal(await page.evaluate(() => document.getElementById('premiers-pas').innerHTML), '');
}));

for (const visite of ['generale', 'muscu']) {
  test(`la visite guidée « ${visite} » se déroule jusqu'au bout`, () => avecAppli({}, async ({ page }) => {
    await page.evaluate(v => demarrerTourGuide(v === 'muscu' ? 'muscu' : undefined), visite);
    const nb = await page.evaluate(() => tourListe.length);
    for (let k = 0; k < nb; k++) {
      await page.evaluate(k => { tourEtape = k; afficherEtapeTour(); }, k);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => fermerTourGuide());
  }));
}

test('Administration : le pseudo de chaque compte est affiché et sert à la recherche', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const comptes = [{ utilisateur: 'a1', email: 'alice@x.fr', maj: Date.now() }, { utilisateur: 'b2', email: 'bob@x.fr', maj: Date.now() - 1000 }];
    const pseudos = [{ utilisateur: 'a1', pseudo: 'alice.fit' }];
    const reponse = data => ({ then: ok => Promise.resolve({ data, error: null }).then(ok) });
    supa = {
      rpc: nom => reponse(nom === 'admin_liste_comptes' ? comptes : []),
      from: table => ({ select: () => reponse(table === 'pseudos' ? pseudos : []) })
    };
    sessionUtilisateur = { id: 'admin', email: ADMIN_EMAIL };
    allerA('admin');
    await chargerAdmin();
    const options = () => [...document.getElementById('admin-user-select').options].slice(1).map(o => o.textContent);
    const res = { toutes: options() };
    document.getElementById('admin-recherche').value = '@alice';
    rafraichirListeComptes();
    res.recherche = options();
    const sel = document.getElementById('admin-user-select');
    sel.value = 'a1'; afficherFeuillUtilisateur();
    res.titre = document.getElementById('admin-user-email').textContent;
    remplirFicheCompteAdmin(adminComptes.a1);
    res.fiche = document.getElementById('admin-stats-fiche').textContent;
    return res;
  });
  assert.deepEqual(r.toutes, ['alice@x.fr · @alice.fit', 'bob@x.fr']);
  assert.deepEqual(r.recherche, ['alice@x.fr · @alice.fit']);
  assert.equal(r.titre, 'alice@x.fr · @alice.fit');
  assert.match(r.fiche, /Pseudo@alice\.fit/);
}));

test('Gymbro : demande, pastille, acceptation, comparaison réservée aux gymbros acceptés', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const appels = [];
    let liens = [
      { pseudo: 'alice', sens: 'recue', statut: 'attente' },
      { pseudo: 'bob', sens: 'envoyee', statut: 'attente' },
      { pseudo: 'carl', sens: 'envoyee', statut: 'acceptee' }
    ];
    const reponse = data => ({ then: ok => Promise.resolve({ data, error: null }).then(ok) });
    supa = {
      rpc: (nom, args) => {
        appels.push([nom, args]);
        if (nom === 'gymbro_mes_liens') return reponse(liens);
        if (nom === 'gymbro_repondre') { liens = liens.map(l => l.pseudo === args.p_pseudo ? { ...l, statut: 'acceptee' } : l); return reponse('acceptee'); }
        if (nom === 'gymbro_demander') { liens.push({ pseudo: args.p_pseudo, sens: 'envoyee', statut: 'attente' }); return reponse('attente'); }
        return reponse([]);
      },
      from: () => ({ select: () => reponse(null) })
    };
    sessionUtilisateur = { id: 'moi', email: 'moi@x.fr' };
    const res = {};
    await chargerLiensGymbro();
    res.pastille = document.querySelector('#nav-seance .pastille-gymbro')?.textContent;
    ouvrirGymbro();
    await new Promise(ok => setTimeout(ok, 50));
    res.sections = [...document.querySelectorAll('#gymbro-favoris > p')].map(p => p.textContent);
    document.querySelector('#gymbro-favoris .gymbro-accepter').click();
    await new Promise(ok => setTimeout(ok, 50));
    res.reponse = appels.find(a => a[0] === 'gymbro_repondre');
    res.pastilleApres = document.querySelectorAll('.pastille-gymbro').length;
    res.seancesAlice = appels.some(a => a[0] === 'gymbro_seances' && a[1].p_pseudo === 'alice');
    // Pas encore gymbro : pas de séances demandées, une invitation à la place.
    const avant = appels.length;
    await comparerGymbro('dave');
    res.invitation = document.querySelector('#gymbro-comparaison .gymbro-invitation').textContent.includes('Envoyer une demande');
    res.seancesDave = appels.slice(avant).some(a => a[0] === 'gymbro_seances');
    document.querySelector('#gymbro-comparaison .gymbro-invitation .btn-primary').click();
    await new Promise(ok => setTimeout(ok, 50));
    res.demande = appels.find(a => a[0] === 'gymbro_demander');
    res.apresDemande = document.querySelector('#gymbro-comparaison .gymbro-invitation').textContent.includes('Annuler la demande');
    return res;
  });
  assert.equal(r.pastille, '1');
  assert.deepEqual(r.sections, ['Demandes reçues', 'Mes gymbros', 'Demandes envoyées']);
  assert.deepEqual(r.reponse, ['gymbro_repondre', { p_pseudo: 'alice', p_accepter: true }]);
  assert.equal(r.pastilleApres, 0);
  assert.ok(r.seancesAlice, 'une fois acceptée, la comparaison charge les séances');
  assert.ok(r.invitation);
  assert.equal(r.seancesDave, false);
  assert.deepEqual(r.demande, ['gymbro_demander', { p_pseudo: 'dave' }]);
  assert.ok(r.apresDemande);
}));

test("fil des gymbros dans l'onglet Activité : cartes, respect, respects reçus", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const appels = [];
    const jour = todayStr();
    const exo = toutesLesExercices().find(e => e.nom === 'Développé couché avec barre');
    const seance = (id, date, programmeNom) => ({ id, date, programmeNom, dureeMin: 52, exercices: [{ exerciceId: exo.id, series: [
      { poids: 100, reps: 5, fait: true }, { poids: 90, reps: 8, fait: true }, { poids: 120, reps: 1, fait: false }] }] });
    const reponse = data => ({ then: ok => Promise.resolve({ data, error: null }).then(ok) });
    supa = {
      rpc: (nom, args) => {
        appels.push([nom, args]);
        if (nom === 'gymbro_fil') return reponse([
          { pseudo: 'carl', seance_id: 's1', donnees: seance('s1', jour, 'Push'), respects: 2, mon_respect: false },
          { pseudo: 'alice', seance_id: 's2', donnees: seance('s2', decalerJours(jour, -1)), respects: 0, mon_respect: true },
          { pseudo: 'pirate', seance_id: 's3', donnees: { date: 'pas une date', exercices: [] } }
        ]);
        if (nom === 'gymbro_respects_recus') return reponse([{ pseudo: 'carl', seance_id: 'm1', seance_date: jour, cree_le: new Date().toISOString() }]);
        if (nom === 'gymbro_respect') return reponse(3);
        if (nom === 'gymbro_mes_liens') return reponse([{ pseudo: 'carl', sens: 'envoyee', statut: 'acceptee' }]);
        return reponse([]);
      },
      from: () => ({ select: () => reponse(null) })
    };
    sessionUtilisateur = { id: 'moi', email: 'moi@x.fr' };
    userProfile.respectsVus = 0;
    const res = {};
    await chargerFilGymbros(true);
    res.pastille = document.querySelector('#nav-seance .pastille-gymbro')?.textContent;
    allerA('seance');
    await new Promise(ok => setTimeout(ok, 50));
    renderFilGymbros();
    const cartes = [...document.querySelectorAll('#fil-gymbros .fil-carte')];
    res.cartes = cartes.map(c => [...c.querySelector('.fil-qui').children].map(x => x.textContent.trim()).join(' '));
    res.stats = [...cartes[0].querySelector('.fil-stats').children].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    res.meilleure = cartes[0].textContent.includes('100 kg × 5');
    res.respects = document.querySelector('#fil-gymbros .fil-respects').textContent;
    res.pastilleApres = document.querySelectorAll('#nav-seance .pastille-gymbro').length;
    cartes[0].querySelector('.fil-respect').click();
    await new Promise(ok => setTimeout(ok, 50));
    res.appelRespect = appels.find(a => a[0] === 'gymbro_respect');
    res.bouton = document.querySelector('#fil-gymbros .fil-carte .fil-respect').textContent.trim();
    res.presse = document.querySelector('#fil-gymbros .fil-carte .fil-respect').getAttribute('aria-pressed');
    return res;
  });
  assert.equal(r.pastille, '1', 'un nouveau respect reçu');
  assert.deepEqual(r.cartes, ["@carl Aujourd'hui · Push", '@alice Hier · Séance libre'], 'la séance à la date invalide est écartée');
  assert.equal(r.stats, '52 min | 2 séries | 1 220 kg');
  assert.ok(r.meilleure);
  assert.match(r.respects, /1 respect reçu .*@carl/);
  assert.equal(r.pastilleApres, 0, 'les respects sont vus une fois le fil affiché');
  assert.deepEqual(r.appelRespect, ['gymbro_respect', { p_pseudo: 'carl', p_seance: 's1', p_actif: true }]);
  assert.equal(r.bouton, '💪 Respect · 3');
  assert.equal(r.presse, 'true');
}));

test('profil : photo et bio, page profil d\'un gymbro, contenus piégés refusés', () => avecAppli({}, async ({ page, dialogues }) => {
  const r = await page.evaluate(async () => {
    const res = {};
    res.avatars = [
      estAvatarValide('data:image/jpeg;base64,/9j/4AAQ=='),
      estAvatarValide('data:image/svg+xml;base64,PHN2Zz4='),
      estAvatarValide('javascript:alert(1)'),
      estAvatarValide('data:image/jpeg;base64,AA" onerror="x')
    ];
    res.html = avatarHTML('bob', 'javascript:alert(1)');
    res.bios = ['Team prise de masse, 4 séances par semaine', 'je fais du support', 'constant et unique', 'fils de pute', 'Sale merde'].map(texteInterdit);
    // Enregistrement : la bio passe par profils (upsert), une bio insultante est bloquée avant l'envoi.
    const envois = [];
    const reponse = data => ({ then: ok => Promise.resolve({ data, error: null }).then(ok) });
    supa = { from: table => ({ upsert: ligne => { envois.push([table, ligne]); return reponse(null); }, select: () => ({ eq: () => ({ maybeSingle: () => reponse({ bio: 'ancienne', avatar: null }) }) }) }), rpc: () => reponse([]) };
    sessionUtilisateur = { id: 'moi', email: 'moi@x.fr' };
    await chargerMonProfil();
    res.blocVisible = !document.getElementById('profil-perso').classList.contains('hidden');
    res.bioAffichee = document.getElementById('profil-bio').value;
    res.ok = await enregistrerProfil({ bio: '  Objectif : 100 kg au développé  ' });
    res.refuse = await enregistrerProfil({ bio: 'bande de connards' });
    res.envois = envois.map(([t, l]) => [t, l.utilisateur, l.bio]);
    // Page profil d'un gymbro : photo, bio, chiffres.
    profilsGymbros = { carl: { bio: 'Powerlifter <b>du dimanche</b>', avatar: 'data:image/jpeg;base64,/9j/4AAQ==', membreDepuis: Date.parse('2026-03-02') } };
    const jour = todayStr();
    const html = profilGymbroHTML('carl', [{ date: jour }, { date: decalerJours(jour, -7) }, { date: decalerJours(jour, -14) }, { date: decalerJours(jour, -35) }]);
    const div = document.createElement('div'); div.innerHTML = html;
    res.profil = { img: !!div.querySelector('img.avatar'), bio: div.querySelector('p').textContent, gras: !!div.querySelector('p b'), chiffres: [...div.querySelectorAll('.profil-gymbro-chiffres b')].map(b => b.textContent), depuis: div.querySelector('small').textContent };
    return res;
  });
  assert.deepEqual(r.avatars, [true, false, false, false]);
  assert.match(r.html, /^<span class="avatar"/);
  assert.deepEqual(r.bios, [false, false, false, true, true]);
  assert.ok(r.blocVisible);
  assert.equal(r.bioAffichee, 'ancienne');
  assert.equal(r.ok, true);
  assert.equal(r.refuse, false);
  assert.deepEqual(r.envois, [['profils', 'moi', 'Objectif : 100 kg au développé']]);
  assert.ok(dialogues.some(d => /mot non autorisé/.test(d)));
  assert.equal(r.profil.img, true);
  assert.equal(r.profil.bio, 'Powerlifter <b>du dimanche</b>');
  assert.equal(r.profil.gras, false);
  assert.equal(r.profil.chiffres[1], '3', '3 semaines d\'affilée');
  assert.equal(r.profil.depuis, 'Membre depuis mars 2026');
}));

test('Administration : pastilles quand des aliments sont à valider (admin seulement)', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const requetes = [];
    let restants = 3;
    const chaine = () => {
      const q = { filtres: [] };
      const o = {
        select: (cols, opts) => { q.select = [cols, opts]; return o; },
        eq: (c, v) => { q.filtres.push(['eq', c, v]); return o; },
        or: f => { q.filtres.push(['or', f]); return o; },
        then: ok => { requetes.push(q); return Promise.resolve({ count: restants, error: null }).then(ok); }
      };
      return o;
    };
    supa = { from: table => { requetes.push(table); return chaine(); }, rpc: () => ({ then: ok => Promise.resolve({ data: [], error: null }).then(ok) }) };
    const lire = () => ['nav-admin', 'fab'].map(id => document.querySelector('#' + id + ' > .pastille-gymbro')?.textContent || null)
      .concat(document.querySelector('[onclick="afficherFeuillAlimentsPersonalises()"] > .pastille-gymbro')?.textContent || null);
    const res = {};
    // Compte ordinaire : rien n'est demandé, aucune pastille admin.
    sessionUtilisateur = { id: 'u', email: 'quelquun@x.fr' };
    await compterAValiderAdmin();
    res.nonAdmin = { requetes: requetes.length, pastilles: lire() };
    // Admin : 3 aliments à valider.
    sessionUtilisateur = { id: 'admin', email: ADMIN_EMAIL };
    await compterAValiderAdmin();
    res.admin = lire();
    ouvrirFab(); res.fabOuvert = lire()[1]; fermerFab(); res.fabFerme = lire()[1];
    res.requete = requetes.slice(-2);
    // Tout est validé : les pastilles disparaissent.
    restants = 0;
    await compterAValiderAdmin();
    res.apres = lire();
    return res;
  });
  assert.deepEqual(r.nonAdmin, { requetes: 0, pastilles: [null, null, null] });
  assert.deepEqual(r.admin, ['3', '3', '3']);
  assert.equal(r.fabOuvert, null, 'menu ouvert : chaque entrée a sa pastille');
  assert.equal(r.fabFerme, '3', 'la pastille revient sur le bouton une fois le menu refermé');
  assert.equal(r.requete[0], 'aliments_partages');
  assert.deepEqual(r.requete[1].filtres, [['eq', 'valide', false], ['or', 'supprime.is.null,supprime.eq.false']]);
  assert.deepEqual(r.requete[1].select[1], { count: 'exact', head: true });
  assert.deepEqual(r.apres, [null, null, null]);
}));

test("des données piégées venant d'autres comptes ne s'exécutent jamais (Administration, Gymbro)", () => avecAppli({}, async ({ page }) => {
  await installerFauxSupabase(page);
  const etapes = [
    () => { allerA('admin'); return chargerAdmin(); },
    () => { const sel = document.getElementById('admin-user-select'); sel.value = sel.options[1].value; afficherFeuillUtilisateur(); },
    () => chargerApercuAdmin(),
    () => ouvrirJournalAdmin(),
    () => chargerAlimentsAdmin(),
    () => chargerExercicesAdmin(),
    () => chargerRecettesAdmin(),
    () => chargerStatsMuscuAdmin('u1', 'Compte'),
    () => voirDetailHistorique(muscuContexteActuel.historique[0].id),
    () => voirDetailProgramme([...muscuGroupesProgrammesCourant.keys()][0]),
    () => ouvrirHistoriqueExercice(muscuContexteActuel.historique[0].exercices[0].exerciceId),
    () => comparerGymbro('abc'),
    () => chargerLiensGymbro().then(() => ouvrirGymbro()),
    () => { const P = __seancePiegee(1).notes; filGymbrosDernier = Date.now(); filGymbros = [nettoyerSeanceFil({ pseudo: P, seance_id: 'x' + P, donnees: Object.assign(__seancePiegee(1), { programmeNom: P }), respects: 2 })]; respectsRecus = [{ pseudo: P, quand: 1 }]; renderFilGymbros(); },
    () => comparerGymbro(document.querySelector('#gymbro-favoris .gymbro-puces button').textContent.replace(/^.?@/, '').replace(/ en attente$/, '')),
    () => { const P = __seancePiegee(1).notes; gymbroLiens = [{ pseudo: P, sens: 'envoyee', statut: 'acceptee' }]; profilsGymbros[P.toLowerCase()] = { bio: P, avatar: P, membreDepuis: Date.now() }; return comparerGymbro(P); },
    () => { const P = __seancePiegee(1).notes; monProfil = { bio: P, avatar: 'data:image/jpeg;base64,AA" onerror="window.__xss=1' }; majUIProfilPerso(); }
  ];
  for (const etape of etapes) {
    await page.evaluate(`(${etape.toString()})()`);
    await page.waitForTimeout(250);
    assert.equal(await injectionsTrouvees(page), 0, 'code injecté exécuté après : ' + etape.toString());
  }
}));

test("des données piégées dans ses propres données ne s'exécutent jamais", () => avecAppli({}, async ({ page }) => {
  await page.evaluate(P => {
    const t = todayStr(), d = getDay(t);
    d.meals.lunch.push({ name: P, grams: 100, kcal: 100, p: 1, c: 1, f: 1, code: P });
    d.workouts.push({ type: 'course', time: 30, distance: 5, intensite: 2, note: P });
    saveData(t);
    musculationProgrammes.push({ id: 'p' + P, nom: P, exercices: [{ exerciceId: 'x' + P, nom: P, tempo: P, plage: P, series: [{ poids: P, reps: P }] }], maj: Date.now() });
    musculationHistorique.unshift({ id: 'h' + P, programmeId: 'p' + P, programmeNom: P, date: t, debut: Date.now() - 3e6, fin: Date.now(), dureeMin: 50, notes: P, maj: Date.now(),
      exercices: [{ exerciceId: toutesLesExercices()[0].id, nom: P, notes: P, tempo: P, series: [{ poids: 80, reps: 8, fait: true, technique: P, rir: P }] }] });
  }, P);
  const etapes = [
    () => { allerA('repas'); renderApp(); },
    () => { allerA('seance'); choisirModeSeance('muscu'); renderSeance(); },
    () => choisirModeSeance('cardio'),
    () => { allerA('stats'); ['poids', 'nutrition', 'activite', 'muscu'].forEach(o => choisirOngletStats(o)); },
    () => voirDetailHistorique(musculationHistorique[0].id),
    () => ouvrirEditionProgramme(musculationProgrammes[0].id),
    () => { document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); allerA('seance'); demarrerSeance(musculationProgrammes[0].id); renderSessionModal(); }
  ];
  for (const etape of etapes) {
    await page.evaluate(`(${etape.toString()})()`);
    await page.waitForTimeout(200);
    assert.equal(await injectionsTrouvees(page), 0, 'code injecté exécuté après : ' + etape.toString());
  }
}));

test('le thème sombre ne casse aucun écran', () => avecAppli({ theme: 'dark' }, async ({ page }) => {
  for (const ecran of ['repas', 'seance', 'stats', 'reglages']) {
    await page.evaluate(e => allerA(e), ecran);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('cardio'); ouvrirCardio(); });
  assert.ok(await page.isVisible('#modal-cardio'));
}));
