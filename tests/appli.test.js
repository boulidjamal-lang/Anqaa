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
  assert.deepEqual(Object.keys(r).sort(), ['dos', 'epaules', 'pectoraux']);
  assert.deepEqual([r.pectoraux.lignes, r.epaules.lignes, r.dos.lignes], [3, 3, 2]);
  const toutes = Object.values(r).flatMap(g => g.alertes).join(' | ');
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
  assert.deepEqual(Object.values(r).flatMap(g => g.alertes), []);
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
  assert.deepEqual(r.ficheEstimee, ['Pectoraux Haut Milieu', 'Épaules Antérieur']);
  assert.ok(r.noteEstimee);
  assert.deepEqual(r.avant, ['2', '1', '0']);
  assert.deepEqual(r.apres, ['1', '1', '2']);
  assert.deepEqual(r.enregistre, { pectoraux: { pec_haut: 1, pec_milieu: 1, pec_bas: 2 } });
  assert.equal(r.retourAuto, null);
  assert.deepEqual(r.ficheChoisie, ['Pectoraux Haut Bas', 'Épaules Antérieur']);
  assert.ok(Math.abs(r.poids.pec_bas - 1 / 1.4) < 1e-9 && Math.abs(r.poids.pec_haut - 0.4 / 1.4) < 1e-9);
  assert.deepEqual(r.piege, { pec_milieu: 0.6, pec_haut: 0.2, pec_bas: 0.2 });
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

test("des données piégées venant d'autres comptes ne s'exécutent jamais (Administration, Gymbro)", () => avecAppli({}, async ({ page }) => {
  await installerFauxSupabase(page);
  const etapes = [
    () => { allerA('admin'); return chargerAdmin(); },
    () => chargerApercuAdmin(),
    () => ouvrirJournalAdmin(),
    () => chargerAlimentsAdmin(),
    () => chargerExercicesAdmin(),
    () => chargerRecettesAdmin(),
    () => chargerStatsMuscuAdmin('u1', 'Compte'),
    () => voirDetailHistorique(muscuContexteActuel.historique[0].id),
    () => voirDetailProgramme([...muscuGroupesProgrammesCourant.keys()][0]),
    () => ouvrirHistoriqueExercice(muscuContexteActuel.historique[0].exercices[0].exerciceId),
    () => comparerGymbro('abc')
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
