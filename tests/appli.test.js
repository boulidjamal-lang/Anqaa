/* Tests de bout en bout d'Askēsis : l'appli réelle (index.html) dans Chromium,
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
const { creerServeur, brancherServeur } = require('./serveur');

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
  // Seuls les scripts venus d'un CDN ont une version à figer (assets/donnees.js est à nous).
  const scripts = [...html.matchAll(/<script[^>]*src="(https?:[^"]+)"/g)].map(m => m[1]);
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

test('les pas se notent depuis Repas du jour et comptent dans la dépense', () => avecAppli({}, async ({ page }) => {
  // Plus de carte des pas dans Activité : la puce « Pas » de Repas du jour suffit.
  await page.evaluate(() => allerA('seance'));
  assert.equal(await page.isVisible('#carte-pas-seances'), false);
  await page.evaluate(() => allerA('repas'));
  const avant = await page.evaluate(() => computeTargets(getDay(todayStr()), todayStr()).tdee);
  await page.click('#ecran-repas .heros-puce-modif');
  await page.fill('#saisie-rapide-champ', '8500');
  await page.evaluate(() => validerSaisieRapide());
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
  // Au milieu de l'écran, comme un utilisateur qui fait défiler : pas sous la barre d'onglets.
  await page.locator(selecteur).first().evaluate(el => el.scrollIntoView({ block: 'center' }));
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
  // Glisser à gauche : retirer tout de suite, avec « Annuler » pendant quelques secondes
  await glisser(page, '#programme-exercices-container .exo-swipe:nth-child(2) .exo-en-programme-entete', -160);
  r = await page.evaluate(() => programmeEnEdition.exercices.length);
  assert.equal(r, 1);
  assert.equal(dialogues.length, 0, 'plus de confirmation');
  assert.match(await page.textContent('#toast-annuler'), /retiré/);
  await page.click('#toast-annuler button');
  assert.equal(await page.evaluate(() => programmeEnEdition.exercices.length), 2, 'Annuler le remet');
  await glisser(page, '#programme-exercices-container .exo-swipe:nth-child(2) .exo-en-programme-entete', -160);
  await page.evaluate(() => document.getElementById('toast-annuler').classList.remove('visible'));
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
  await page.locator('#programme-exercices-container .exo-en-programme-entete').first().evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -120));
  const b = await page.locator('#programme-exercices-container .exo-en-programme-entete').first().boundingBox();
  const x = b.x + 60, y = b.y + 15;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.waitForTimeout(600);
  assert.ok(await page.evaluate(() => document.getElementById('programme-exercices-container').classList.contains('reordre')), 'les exercices se replient');
  // Deux cartes repliées plus bas : la hauteur d'une carte repliée, mesurée.
  const pas = await page.evaluate(() => { const z = document.querySelectorAll('#programme-exercices-container .exo-swipe'); return z[1].getBoundingClientRect().top - z[0].getBoundingClientRect().top; });
  for (let k = 1; k <= 10; k++) await page.mouse.move(x, y + k * pas * 0.25);
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
    musculationHistorique.unshift({ id: 'jambes', date: todayStr(), exercices: ['Squat avec haltères', 'Curl des ischio-jambiers en position couchée', 'Élévation des mollets debout'].map(n => ({ exerciceId: exo(n).id, series: series(6) })) });
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
    // L'en-tête (salutation, photo) n'existe que sur Repas du jour.
    res.enteteSurProfil = getComputedStyle(document.querySelector('.app-bar')).display;
    allerA('repas');
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
  assert.ok(r.logoAGauche, 'logo Askēsis (colonne) visible à gauche');
  assert.equal(r.enteteSurProfil, 'none');
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

test("barre d'onglets : Repas, Activité, +, Progrès, Profil ; plus de bouton flottant", () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => allerA('repas'));
  let r = await page.evaluate(() => {
    const n = document.getElementById('onglets'), b = n.getBoundingClientRect();
    return { pos: getComputedStyle(n).position, dansEcran: b.top >= 0 && b.bottom <= innerHeight, boutons: n.querySelectorAll('button').length,
      actif: document.querySelector('#onglets .onglet.actif').id, fab: document.getElementById('fab-zone'), ajout: document.getElementById('ajout-rapide') };
  });
  assert.deepEqual(r, { pos: 'fixed', dansEcran: true, boutons: 5, actif: 'onglet-repas', fab: null, ajout: null });
  // Chaque onglet mène à son écran et devient l'onglet actif.
  for (const [id, ecran] of [['onglet-seance', 'seance'], ['onglet-profil', 'reglages'], ['onglet-progres', 'stats'], ['onglet-repas', 'repas']]) {
    await page.click('#' + id);
    r = await page.evaluate(() => [ecranActif, document.querySelector('#onglets .onglet.actif').id]);
    assert.deepEqual(r, [ecran, 'onglet-' + (ecran === 'reglages' ? 'profil' : ecran === 'stats' ? 'progres' : ecran)]);
  }
  // Progrès s'ouvre sur le Résumé ; les cinq onglets restent toujours visibles.
  await page.click('#onglet-progres');
  r = await page.evaluate(() => ({ actif: categorieStatsActive(), onglets: [...document.querySelectorAll('#stats-onglets-nav button')].map(b => b.textContent.trim()),
    titre: document.getElementById('stats-titre').textContent }));
  assert.deepEqual(r, { actif: 'resume', onglets: ['Résumé', 'Corps', 'Repas', 'Cardio', 'Muscu'], titre: 'Progrès' });
  await page.evaluate(() => ouvrirStats('nutrition'));
  assert.equal(await page.evaluate(() => document.getElementById('stats-onglets-nav').offsetHeight > 0), true);
  // « + » : ajouter au repas du moment ; la barre s'efface derrière la feuille.
  await page.evaluate(() => allerA('repas'));
  await page.click('#onglet-plus');
  r = await page.evaluate(() => ({ feuille: document.getElementById('feuille-repas').classList.contains('show'), cache: document.body.classList.contains('couche-ouverte'), titre: document.getElementById('feuille-repas-titre').textContent }));
  assert.equal(r.feuille, true); assert.equal(r.cache, true); assert.match(r.titre, /^Ajouter à : /);
}));

test('Repas du jour : toucher une macro ouvre sa courbe face à son objectif', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const t = todayStr();
    for (let k = 0; k < 10; k++) { const d = shiftDate(t, -k); getDay(d).meals[MEALS[0]].push({ name: 'Test', kcal: 1800, p: 120 + k, c: 200, f: 60 }); saveData(d); }
    allerA('repas'); renderApp();
  });
  await page.click('#ecran-repas .macro-item:nth-child(1)');
  // La macro ouvre Progrès › Repas sur sa courbe (sélecteur réglé dessus).
  assert.equal(await page.evaluate(() => document.getElementById('bloc-depense').classList.contains('macro-stat--vise')), false);
  assert.equal(await page.evaluate(() => serieNutrition + '|' + document.querySelector('#nutri-series-nav [aria-pressed="true"]').textContent), 'p|Prot.');
  await page.waitForFunction(() => Object.keys(macroChartsInstances).length === 3);
  // Défilement doux jusqu'à la courbe (le bilan du jour est au-dessus).
  await page.waitForFunction(() => { const b = document.getElementById('macro-stat-p').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }, null, { timeout: 3000 });
  await page.waitForFunction(() => document.getElementById('macro-stat-p').classList.contains('macro-stat--vise'), null, { timeout: 2000 });
  const r = await page.evaluate(() => {
    const c = macroChartsInstances.p, b = document.getElementById('macro-stat-p').getBoundingClientRect();
    const cible = computeTargets(getDay(todayStr()), todayStr()).protein;
    return { ecran: ecranActif, titre: document.getElementById('stats-titre').textContent,
      series: c.data.datasets.map(d => d.label), dernier: c.data.datasets[0].data.at(-1), objectif: c.data.datasets[1].data.at(-1) === cible,
      visible: b.top >= 0 && b.bottom <= innerHeight, vise: document.getElementById('macro-stat-p').classList.contains('macro-stat--vise'),
      ancien: !!document.getElementById('macrosChart') };
  });
  assert.deepEqual(r, { ecran: 'stats', titre: 'Progrès', series: ['Protéines (g)', 'Objectif'], dernier: 120, objectif: true, visible: true, vise: true, ancien: false });
  await page.click('#onglet-repas');
  // Le reste du résumé : la dépense du jour et le bilan de la journée,
  // dans une fenêtre sur Repas du jour (plus dans Progrès, qui parle de la période).
  await page.click('#ecran-repas .summary-card .anneaux');
  const dep = await page.evaluate(() => ({ ecran: ecranActif, modale: document.getElementById('depense-modal').classList.contains('show'),
    dansProgres: !!document.querySelector('#ecran-stats #bloc-depense, #ecran-stats #carte-bilan-jour'),
    bilanJour: !!document.querySelector('#depense-modal #carte-bilan-jour'),
    lignes: document.querySelectorAll('#detail-depense > div').length, visible: document.getElementById('bloc-depense').getBoundingClientRect().top < innerHeight }));
  assert.deepEqual(dep, { ecran: 'repas', modale: true, dansProgres: false, bilanJour: true, lignes: 7, visible: true });
  await page.evaluate(() => fermerModal('depense-modal'));
  await page.click('#ecran-repas .macro-item:nth-child(3)');
  await page.waitForTimeout(700);
  assert.ok(await page.evaluate(() => document.getElementById('macro-stat-f').classList.contains('macro-stat--vise')));
  assert.equal(await page.evaluate(() => document.querySelector('#ecran-stats .nutri-serie--active').dataset.serie), 'f');
}));

test("« Déjà mangé » suit le nouveau nom d'un aliment renommé (même code-barres)", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const t = todayStr();
    const jours = [shiftDate(t, -3), shiftDate(t, -2), shiftDate(t, -1)];
    getDay(jours[0]).meals[MEALS[0]].push({ name: "Kok'o handgekookte gepelde eieren", grams: 86, kcal: 114, p: 11, c: 1, f: 8, code: '5413828000650' });
    getDay(jours[1]).meals[MEALS[0]].push({ name: "Kok'o handgekookte gepelde eieren", grams: 86, kcal: 114, p: 11, c: 1, f: 8, code: '5413828000650' });
    getDay(jours[2]).meals[MEALS[0]].push({ name: 'Yaourt nature', grams: 125, kcal: 70, p: 5, c: 6, f: 2 });
    // Même produit noté à la main (sans code-barres) sous l'ancien nom : rattaché au code.
    getDay(jours[2]).meals[MEALS[1]].push({ name: "Kok'o handgekookte gepelde eieren", grams: 50, kcal: 66, p: 6, c: 0, f: 5 });
    // Autre saisie à la main, jamais vue avec un code : reste à part.
    getDay(jours[2]).meals[MEALS[2]].push({ name: "Kok'o oeufs durs", grams: 86, kcal: 114, p: 11, c: 1, f: 8 });
    jours.forEach(saveData); invaliderHistorique();
    // La base renvoie l'aliment perso renommé, avec le même code-barres.
    window.chercherAlimentsSupabase = async () => ({ aliments: [
      { name: "Kok'o - oeufs dur", source: 'perso', code: '5413828000650', nutriments: { 'energy-kcal_100g': 132 } }
    ], probleme: '' });
    await afficherRecherche('kok', false);
    const noms = [...document.querySelectorAll('#off-suggestions-list .off-suggestion')].map(b => b.textContent);
    const deja = chercherDansHistorique('', 10).map(p => [p.name, p.fois]);
    return { noms, deja };
  });
  // Le produit au code-barres : une seule entrée au nouveau nom (3 fois, dont la
  // saisie à la main) ; plus de doublon dans « Mes aliments ».
  assert.equal(r.noms.length, 2, JSON.stringify(r.noms));
  assert.match(r.noms[0], /Kok'o - oeufs dur/);
  assert.match(r.noms[1], /Kok'o oeufs durs/);
  assert.doesNotMatch(r.noms.join(' '), /handgekookte/);
  assert.deepEqual(r.deja[0], ["Kok'o - oeufs dur", 3]);
  // Les repas notés prennent le nouveau nom ; valeurs et poids inchangés.
  const repas = await page.evaluate(() => [-3, -1].map(k => getDay(shiftDate(todayStr(), k))).map((j, i) => (i ? j.meals[MEALS[1]] : j.meals[MEALS[0]])[0]).map(it => [it.name, it.code, it.grams, it.kcal]));
  assert.deepEqual(repas, [["Kok'o - oeufs dur", '5413828000650', 86, 114], ["Kok'o - oeufs dur", '5413828000650', 50, 66]]);
  // × : retire l'entrée de « Déjà mangé », sans toucher aux repas.
  await page.evaluate(() => document.querySelectorAll('#off-suggestions-list .off-retirer')[1].click());
  const restant = await page.evaluate(() => ({ deja: chercherDansHistorique('kok', 10).map(p => p.name), repas: getDay(shiftDate(todayStr(), -1)).meals[MEALS[2]].length, masques: Object.keys(userProfile.dejaMangeMasques) }));
  assert.deepEqual(restant, { deja: ["Kok'o - oeufs dur"], repas: 1, masques: ["kok'o oeufs durs"] });
  // Renommage dans Administration : l'ancien nom disparaît aussi des repas sans code-barres.
  const admin = await page.evaluate(() => { const n = renommerDansHistorique({ ancienNom: "Kok'o oeufs durs", codes: [''], nouveauNom: 'Oeufs durs maison' }); const it = getDay(shiftDate(todayStr(), -1)).meals[MEALS[2]][0]; return [n, it.name, it.grams, it.kcal]; });
  assert.deepEqual(admin, [1, 'Oeufs durs maison', 86, 114]);
  // Retenu d'une ouverture à l'autre (sans réseau) et appliqué tout de suite après un renommage.
  const apres = await page.evaluate(() => { nomsParCode = JSON.parse(localStorage.getItem('anqaa_noms_par_code')); invaliderHistorique(); retenirNomParCode('5413828000650', 'Oeufs durs Kokou'); return chercherDansHistorique('', 10)[0].name; });
  assert.equal(apres, 'Oeufs durs Kokou');
}));

test('cartes de stats : poids et nutrition sur Repas du jour, bandeaux cardio et muscu dans Activité, chacun ouvre son détail', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const t = todayStr();
    userProfile.mesures = userProfile.mesures || {};
    for (let k = 1; k <= 30; k++) {
      const d = shiftDate(t, -k), jour = getDay(d);
      jour.weight = 80 - k * 0.1;
      jour.meals[MEALS[0]].push({ name: 'Test', kcal: 2000 + k, p: 140, c: 200, f: 60 });
      if (k % 3 === 0) jour.workouts.push({ type: 'course', time: 30, distance: 5, intensite: 2 });
      if (k % 7 === 0) userProfile.mesures[d] = { poids: jour.weight, grassePct: 18 + k / 30, muscleKg: 36, osKg: 3.2, eauPct: 58 };
      saveData(d);
    }
    musculationHistorique.unshift({ id: 'h-test', programmeNom: 'Test', date: t, debut: Date.now(), fin: Date.now(), dureeMin: 50, maj: Date.now(),
      exercices: [{ exerciceId: 'x', nom: 'Développé couché', series: [{ poids: 60, reps: 10, fait: true }, { poids: 60, reps: 9, fait: true }] }] });
    allerA('repas'); renderApp();
  });
  // Plus d'entrée « Statistiques » dans le menu du bouton flottant.
  assert.equal(await page.$('#nav-stats'), null);
  const repas = await page.evaluate(() => [...document.querySelectorAll('#cartes-stats-repas .carte-stats')].map(c => c.id));
  assert.deepEqual(repas, ['carte-stats-poids', 'carte-stats-nutrition']);
  assert.match(await page.textContent('#carte-stats-poids .carte-stats-valeur'), /79,9\s*kg/);
  // Deux tuiles côte à côte (icône, valeur, tendance, graphique) ; le détail est dans la fenêtre.
  const tuiles = await page.evaluate(() => ['#carte-stats-poids', '#carte-stats-nutrition'].map(c => { const b = document.querySelector(c).getBoundingClientRect(); return [Math.round(b.top), Math.round(b.width), !!document.querySelector(c + ' .tuile-graph')]; }));
  assert.equal(tuiles[0][0], tuiles[1][0], 'tuiles sur la même ligne');
  assert.ok(tuiles.every(([, w, g]) => w < 200 && g), JSON.stringify(tuiles));
  assert.equal(await page.$('#cartes-stats-repas .carte-stats-cases'), null);

  // Poids : la carte ouvre le détail, 4 petits graphiques de composition, pas de bilan IA.
  await page.click('#carte-stats-poids');
  // Les graphiques se dessinent 120 ms après l'ouverture (écran visible).
  await page.waitForFunction(() => compoChartsInstances.length > 0);
  let r = await page.evaluate(() => ({
    ecran: ecranActif, onglet: categorieStatsActive(),
    cases: document.querySelectorAll('#compo-grille .compo-case').length,
    vides: document.querySelectorAll('#compo-grille .compo-case--vide').length,
    graphiques: compoChartsInstances.length,
    bilanDansResume: !!document.querySelector('#ecran-stats .stats-tab[data-tab="resume"] .stats-bilan'),
    ongletsVisibles: document.getElementById('stats-onglets-nav').offsetHeight > 0
  }));
  assert.equal(r.ecran, 'stats');
  assert.deepEqual([r.onglet, r.cases, r.vides, r.graphiques, r.bilanDansResume, r.ongletsVisibles], ['poids', 4, 0, 4, true, true]);
  await page.click('#onglet-repas');
  assert.equal(await page.evaluate(() => ecranActif), 'repas');

  // Nutrition : la carte ouvre Progrès › Repas (le bilan IA de la période est dans le Résumé).
  await page.click('#carte-stats-nutrition');
  r = await page.evaluate(() => ({ ecran: ecranActif, onglet: categorieStatsActive(), bilans: document.querySelectorAll('#ecran-stats .stats-bilan').length }));
  assert.deepEqual(r, { ecran: 'stats', onglet: 'nutrition', bilans: 1 });
  await page.evaluate(() => choisirPeriodeStats('perso'));
  await page.click('#onglet-repas');

  // Cardio : plus de carte en doublon, le bandeau de la semaine ouvre Progrès.
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('cardio'); });
  assert.equal(await page.$('#carte-stats-cardio'), null);
  await page.click('#seance-cardio .hx--cardio');
  assert.equal(await page.evaluate(() => ecranActif), 'stats');

  // Muscu : idem, depuis le bandeau « Ta semaine » d'Activité › Musculation.
  await page.click('#onglet-seance');
  await page.evaluate(() => choisirModeSeance('muscu'));
  assert.equal(await page.$('#carte-stats-muscu-carte'), null);
  assert.match(await page.textContent('#vitrine-muscu .hx-unite'), /1 séance/);
  await page.click('#vitrine-muscu .hx');
  r = await page.evaluate(() => ({ ecran: ecranActif, onglet: categorieStatsActive(), grille: !!document.getElementById('pg-grille-muscu').offsetHeight }));
  assert.deepEqual(r, { ecran: 'stats', onglet: 'muscu', grille: true });
  // Plus de bouton « Retour » : la barre d'onglets suffit (seule la période est en haut).
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#ecran-stats .stats-entete button')].some(b => /retour/i.test(b.textContent))), false);
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
    res.pastille = document.querySelector('#onglet-seance .pastille-gymbro')?.textContent;
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
  assert.deepEqual(r.sections, ['Demande reçue', 'Tes gymbros · 1', 'Demande envoyée']);
  assert.deepEqual(r.reponse, ['gymbro_repondre', { p_pseudo: 'alice', p_accepter: true }]);
  assert.equal(r.pastilleApres, 0);
  assert.ok(r.seancesAlice, 'une fois acceptée, la comparaison charge les séances');
  assert.ok(r.invitation);
  assert.equal(r.seancesDave, false);
  assert.deepEqual(r.demande, ['gymbro_demander', { p_pseudo: 'dave' }]);
  assert.ok(r.apresDemande);
}));

test("fil de l'espace Gymbros : cartes, respect, respects reçus", () => avecAppli({}, async ({ page }) => {
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
    res.pastille = document.querySelector('#onglet-seance .pastille-gymbro')?.textContent;
    ouvrirGymbro('fil');
    await new Promise(ok => setTimeout(ok, 50));
    const cartes = [...document.querySelectorAll('#fil-gymbros .fil-carte')];
    res.cartes = cartes.map(c => [...c.querySelector('.fil-qui').children].map(x => x.textContent.trim()).join(' '));
    res.stats = [...cartes[0].querySelector('.fil-stats').children].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    res.meilleure = cartes[0].textContent.includes('100 kg × 5');
    res.respects = document.querySelector('#fil-gymbros .fil-respects').textContent;
    res.pastilleApres = document.querySelectorAll('#onglet-seance .pastille-gymbro').length;
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

test("Gymbros : rangée d'Activité, record du fil, classement de la semaine, lien d'invitation", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const jour = todayStr();
    const exo = toutesLesExercices().find(e => e.nom === 'Développé couché avec barre');
    const seance = (id, date, poids, nom) => ({ id, date, programmeNom: nom || 'Push', dureeMin: 50, exercices: [{ exerciceId: exo.id, series: [
      { poids, reps: 5, fait: true }, { poids, reps: 5, fait: true }] }] });
    const reponse = data => ({ then: ok => Promise.resolve({ data, error: null }).then(ok) });
    supa = {
      rpc: (nom, args) => {
        if (nom === 'gymbro_mes_liens') return reponse([{ pseudo: 'carl', sens: 'envoyee', statut: 'acceptee' }, { pseudo: 'alice', sens: 'recue', statut: 'acceptee' }, { pseudo: 'lea', sens: 'recue', statut: 'attente' }]);
        if (nom === 'gymbro_fil') return reponse([
          { pseudo: 'carl', seance_id: 'c1', donnees: seance('c1', jour, 100), respects: 0, mon_respect: false },
          { pseudo: 'alice', seance_id: 'a1', donnees: seance('a1', decalerJours(jour, -10), 60, 'Jambes'), respects: 0, mon_respect: false }]);
        if (nom === 'gymbro_seances' && args.p_pseudo === 'carl') return reponse([seance('c1', jour, 100), seance('c0', decalerJours(jour, -7), 90)].map(d => ({ donnees: d })));
        return reponse([]);
      },
      from: () => ({ select: () => reponse(null) })
    };
    sessionUtilisateur = { id: 'moi', email: 'moi@x.fr' };
    monPseudo = { pseudo: 'jamal' };
    musculationHistorique.push(seance('m1', jour, 80));
    await chargerLiensGymbro();
    await chargerFilGymbros(true);
    allerA('seance');
    const res = {};
    const textes = sel => [...document.querySelectorAll(sel)].map(x => x.textContent.trim());
    res.noms = textes('#gymbros-rangee .gst small');
    res.sous = textes('#gymbros-rangee .gst em');
    res.anneaux = document.querySelectorAll('#gymbros-rangee .gav--actif').length;
    res.profil = !!document.querySelector('#gymbros-rangee-profil .gstrip');
    ouvrirGymbro('fil');
    await new Promise(ok => setTimeout(ok, 80));
    res.record = document.querySelector('#fil-gymbros .fil-carte .gcarte-rec')?.textContent;
    res.badge = document.getElementById('gymbro-badge-mes').textContent;
    choisirOngletGymbro('classement');
    res.classement = textes('#gymbro-vue-classement .gcl-t b');
    res.valeurs = textes('#gymbro-vue-classement .gcl em');
    res.defi = document.querySelector('#gymbro-vue-classement .gdefi b').textContent;
    choisirMesureGymbro('seances');
    res.parSeances = textes('#gymbro-vue-classement .gcl-t b');
    // Lien d'invitation : partagé avec mon nom, lu à l'ouverture puis retiré de l'adresse.
    Object.defineProperty(navigator, 'share', { configurable: true, value: async o => { res.partage = o.url; } });
    await partagerLienGymbro();
    history.replaceState({}, '', location.pathname + '?gymbro=Carl');
    lireInvitationGymbro();
    res.adresse = location.search;
    fermerModal('gymbro-modal');
    ouvrirInvitationGymbro();
    await new Promise(ok => setTimeout(ok, 80));
    res.ouvert = gymbroModalOuvert();
    res.fiche = document.querySelector('#gymbro-comparaison .gb-barre-retour h4')?.textContent;
    res.face = !!document.querySelector('#gymbro-comparaison .gface .gface-vs');
    return res;
  });
  assert.deepEqual(r.noms, ['Inviter', '@lea', '@carl', '@alice']);
  assert.deepEqual(r.sous, ['Nouveau', 'Push · auj.', 'il y a 10 j']);
  assert.equal(r.anneaux, 1, "anneau pour qui s'est entraîné aujourd'hui");
  assert.ok(r.profil, 'la rangée est aussi dans le Profil');
  assert.match(r.record, /A battu son record : .*100 kg × 5/);
  assert.equal(r.badge, '1');
  assert.deepEqual(r.classement, ['@carl', 'Toi', '@alice']);
  assert.deepEqual(r.valeurs, ['1t', '800kg', '0kg']);
  assert.equal(r.defi, 'Plus que 200 kg');
  assert.deepEqual(r.parSeances, ['Toi', '@carl', '@alice']);
  assert.match(r.partage, /\?gymbro=jamal$/);
  assert.equal(r.adresse, '');
  assert.ok(r.ouvert);
  assert.equal(r.fiche, '@carl');
  assert.ok(r.face);
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
    const lire = () => ['nav-admin', 'onglet-profil'].map(id => document.querySelector('#' + id + ' > .pastille-gymbro')?.textContent || null)
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
    res.requete = requetes.slice(-2);
    // Tout est validé : les pastilles disparaissent.
    restants = 0;
    await compterAValiderAdmin();
    res.apres = lire();
    return res;
  });
  assert.deepEqual(r.nonAdmin, { requetes: 0, pastilles: [null, null, null] });
  assert.deepEqual(r.admin, ['3', '3', '3']);
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
    () => { allerA('seance'); renderRangeesGymbros(); },
    () => { ouvrirGymbro('mes'); return comparerGymbro(document.querySelector('#gymbro-favoris :is(.gli, .gdem) b').textContent.replace(/^@/, '')); },
    () => { const P = __seancePiegee(1).notes; gymbroLiens = [{ pseudo: P, sens: 'envoyee', statut: 'acceptee' }]; profilsGymbros[P.toLowerCase()] = { bio: P, avatar: P, membreDepuis: Date.now() }; return comparerGymbro(P); },
    () => { renderRangeesGymbros(); ouvrirGymbro('fil'); choisirOngletGymbro('classement'); choisirOngletGymbro('mes'); },
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

test("Repas du jour allégé : idées dans « Recette », pas dans Activité, bilan de la journée dans sa fenêtre", () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const j = getDay(todayStr());
    j.meals[MEALS[0]].push({ name: "Flocons d'avoine", grams: 80, kcal: 300, p: 10, c: 50, f: 6 });
    saveData(todayStr()); allerA('repas'); renderApp();
  });
  const r = await page.evaluate(() => ({
    idees: !!document.querySelector('#ecran-repas [onclick*="chercherRecettesMacros"]'),
    ideesDansRecette: !!document.querySelector('#feuille-choix-recette [onclick*="chercherRecettesMacros"]'),
    pasDansActivite: getComputedStyle(document.getElementById('carte-pas-seances')).display !== 'none' || !document.querySelector('#ecran-repas .heros-puce-modif'),
    bilanDansNutrition: !!document.querySelector('#depense-modal #carte-bilan-jour'),
    bilanDansRepas: !!document.querySelector('#ecran-repas #carte-bilan-jour'),
    vides: document.querySelectorAll('#meals-container .meal-card--vide').length,
    listesVides: document.querySelectorAll('#meals-container .meal-card--vide .food-list').length,
    macrosAliment: getComputedStyle(document.querySelector('#ecran-repas .food-macros')).display,
    pct: !!document.getElementById('pct-p')
  }));
  assert.deepEqual(r, { idees: false, ideesDansRecette: true, pasDansActivite: false, bilanDansNutrition: true, bilanDansRepas: false, vides: 3, listesVides: 0, macrosAliment: 'none', pct: false });
  // Eau : la gourde à gauche, quantité et boutons à droite.
  const eau = await page.evaluate(() => { const g = document.querySelector('#bloc-eau .gourde').getBoundingClientRect(), b = document.querySelector('#bloc-eau .eau-boutons').getBoundingClientRect(); return b.left > g.right - 1 && b.top < g.bottom; });
  assert.ok(eau);
  // Toucher un aliment ouvre sa fenêtre (poids et macros).
  await page.click('#ecran-repas .food-info');
  assert.ok(await page.evaluate(() => document.getElementById('macros-popup-modal').classList.contains('show')));
}));

test('tout aliment ajouté part en validation dans la base, sauf s\'il y est déjà', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Fausse base : aliments partagés + base d'aliments, avec les requêtes réellement faites.
    const T = confSupabase().table;
    const db = { aliments_partages: [], [T]: [{ id: 1, nom: 'Pomme', code_barre: '999' }] };
    const envoyes = [];
    const requete = table => {
      const filtres = []; let ligne = null;
      const b = {
        select: () => b, limit: () => b, single: () => b,
        ilike: (c, v) => { filtres.push(x => String(x[c] || '').toLowerCase() === v.replace(/\\(.)/g, '$1').toLowerCase()); return b; },
        eq: (c, v) => { filtres.push(x => String(x[c]) === String(v)); return b; },
        insert: l => { ligne = l; return b; },
        then: (ok, ko) => {
          if (ligne) { (db[table] = db[table] || []).push(ligne); envoyes.push(ligne); return Promise.resolve({ data: ligne, error: null }).then(ok, ko); }
          return Promise.resolve({ data: (db[table] || []).filter(x => filtres.every(f => f(x))), error: null }).then(ok, ko);
        }
      };
      return b;
    };
    supa = { from: requete };
    sessionUtilisateur = { id: 'u1', email: 'membre@x.fr' };
    detecterSchemaAliments = async () => ({ vide: false, nom: 'nom', codeBarre: 'code_barre', cle: 'id' });
    const attendre = () => new Promise(res => setTimeout(res, 50));
    activeMealId = 'lunch';
    // 1) Produit scanné (OpenFoodFacts) : envoyé, en attente de validation.
    currentScannedFood = { name: 'Skyr nature', code: '123', kcal100: 60, p100: 10, c100: 4, f100: 0.2, unite: 'g', source: 'OpenFoodFacts' };
    document.getElementById('barcode-grams').value = 150;
    ajouterAlimentBarcode(); await attendre();
    // 2) Le même rescanné : pas de doublon.
    ajouterAlimentBarcode(); await attendre();
    // 3) Produit scanné déjà dans la base d'aliments (même code-barres) : rien.
    currentScannedFood = { name: 'Pomme Gala', code: '999', kcal100: 52, p100: 0.3, c100: 14, f100: 0.2, unite: 'g', source: 'OpenFoodFacts' };
    ajouterAlimentBarcode(); await attendre();
    // 4) Repris de « Déjà mangé » et absent de la base : envoyé.
    addItemToMeal('lunch', { name: 'Galette maison', grams: 100, kcal: 200, p: 5, c: 30, f: 6 }, { source: 'historique' }); await attendre();
    // 5) Pris tel quel dans notre base : rien.
    addItemToMeal('lunch', { name: 'Riz', grams: 100, kcal: 130, p: 3, c: 28, f: 0 }, { partager: false }); await attendre();
    return envoyes.map(e => [e.nom, e.code_barre, e.source, e.kcal100, 'valide' in e]);
  });
  assert.deepEqual(r, [['Skyr nature', '123', 'scan', 60, false], ['Galette maison', '', 'historique', 200, false]]);
}));

test("scan : un produit déjà dans notre base s'affiche sous notre nom, pas celui d'OpenFoodFacts", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const db = { aliments_partages: [{ nom: "Kok'o - oeufs dur", kcal100: 132, p100: 12, c100: 1, f100: 9, code_barre: '5413828000650', valide: false, createur_id: 'u1', supprime: false }] };
    const requete = table => {
      const filtres = [];
      const b = { select: () => b, limit: () => b, eq: (c, v) => { filtres.push(x => String(x[c]) === String(v)); return b; },
        then: (ok, ko) => Promise.resolve({ data: (db[table] || []).filter(x => filtres.every(f => f(x))), error: null }).then(ok, ko) };
      return b;
    };
    supa = { from: requete };
    sessionUtilisateur = { id: 'u1', email: 'membre@x.fr' };
    detecterSchemaAliments = async () => null;
    let appelsOFF = 0;
    const fetchOrigine = window.fetch;
    window.fetch = async url => { appelsOFF++; return { json: async () => ({ status: 1, product: { product_name: 'Kok\'o handgekookte gepelde eieren', brands: 'Kok\'o', nutriments: { 'energy-kcal_100g': 132 } } }) }; };
    const lire = () => [document.getElementById('barcode-name').value, (document.getElementById('barcode-source') || {}).textContent];
    // 1) Dans notre base (en attente, créé par moi) : notre nom, sans OpenFoodFacts.
    await chercherProduitOFFParCode('5413828000650');
    const a = [lire(), appelsOFF, currentScannedFood.dansNotreBase];
    // 2) Pas dans notre base mais déjà renommé chez nous : OpenFoodFacts, sous notre nom.
    db.aliments_partages = [];
    nomsParCode['5413828000650'] = 'Oeufs durs maison';
    await chercherProduitOFFParCode('5413828000650');
    const b = [lire(), appelsOFF, !!currentScannedFood.dansNotreBase];
    window.fetch = fetchOrigine;
    return { a, b };
  });
  assert.deepEqual(r.a, [["Kok'o - oeufs dur", 'Trouvé dans : ta base'], 0, true]);
  assert.deepEqual(r.b, [['Oeufs durs maison', 'Trouvé dans : OpenFoodFacts'], 1, false]);
}));

test("Administration : les doublons d'aliments sont fusionnés au lieu d'apparaître deux fois", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const T = confSupabase().table;
    const att = (id, nom, code_barre, cree_le) => ({ id, nom, code_barre, cree_le, valide: false, supprime: false });
    const db = {
      aliments_partages: [
        att('A', 'Skyr nature', '123', '2026-10-01'), att('B', 'Skyr Nature', '', '2026-10-02'),          // même nom
        att('C', 'Galette', '555', '2026-10-01'), att('D', 'Galette maison', '555', '2026-10-03'),       // même code-barres
        att('E', "Kok'o", '777', '2026-10-04'),                                                          // déjà validé
        { id: 'F', nom: "Kok'o - oeufs dur", code_barre: '777', cree_le: '2026-09-01', valide: true, supprime: false },
        att('G', 'Pomme', '999', '2026-10-05'),                                                          // déjà dans la base d'aliments
        att('H', 'Unique', '', '2026-10-05'),                                                            // seul : gardé
        att('I', 'Wrap', '', '2026-10-01'), att('J', 'wrap', '42', '2026-10-02')                         // le gardé récupère le code
      ],
      [T]: [{ id: 1, nom: 'Pomme Gala', code_barre: '999' }]
    };
    const majs = [];
    const requete = table => {
      const filtres = []; let maj = null;
      const b = {
        select: () => b, limit: () => b, or: () => b,
        eq: (c, v) => { filtres.push(x => String(x[c]) === String(v)); return b; },
        in: (c, vals) => { filtres.push(x => vals.map(String).includes(String(x[c]))); return b; },
        update: v => { maj = v; return b; },
        then: (ok, ko) => {
          const lignes = (db[table] || []).filter(x => filtres.every(f => f(x)));
          if (maj) { lignes.forEach(x => Object.assign(x, maj)); majs.push([lignes.map(x => x.id).sort().join(','), Object.keys(maj).join(',')]); }
          return Promise.resolve({ data: maj ? null : lignes, error: null }).then(ok, ko);
        }
      };
      return b;
    };
    supa = { from: requete, rpc: async () => ({ data: null, error: null }) };
    sessionUtilisateur = { id: 'admin', email: ADMIN_EMAIL };
    detecterSchemaAliments = async () => ({ vide: false, nom: 'nom', codeBarre: 'code_barre', cle: 'id' });
    const n = await fusionnerDoublonsAliments(true);
    const restants = db.aliments_partages.filter(a => !a.supprime).map(a => a.id + (a.code_barre ? ':' + a.code_barre : '')).sort();
    return { n, restants, majs, parQui: db.aliments_partages.find(a => a.id === 'B').supprime_par };
  });
  assert.equal(r.n, 5);
  assert.deepEqual(r.restants, ['A:123', 'C:555', 'F:777', 'H', 'I:42']);
  assert.deepEqual(r.majs, [['B,D,E,G,J', 'supprime,supprime_par,supprime_le'], ['I', 'code_barre']]);
  assert.match(r.parQui, /^fusion/);
}));

test('Repas du jour refait : anneaux, semaine, série de jours, coach', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const t = todayStr();
    [-2, -1, 0].forEach(k => { const d = shiftDate(t, k); getDay(d).meals[MEALS[0]].push({ name: 'Skyr', grams: 150, kcal: 600, p: 20, c: 60, f: 10 }); saveData(d); });
    allerA('repas'); renderApp();
    const cible = computeTargets(getDay(t), t).target;
    const a = document.getElementById('anneau-kcal'), tour = 2 * Math.PI * 72;
    const part = 1 - parseFloat(a.style.strokeDashoffset) / tour;
    const res = { part: Math.round(part * 100), attendu: Math.round(600 / cible * 100), trop: a.getAttribute('stroke'),
      jours: document.querySelectorAll('#semaine-jours .semaine-jour:not(.futur)').length, actif: document.querySelector('#semaine-jours .semaine-jour.actif b').textContent,
      dernier: [...document.querySelectorAll('#semaine-jours .semaine-jour:not(.futur)')].pop().dataset.date === t,
      futurs: [...document.querySelectorAll('#semaine-jours .semaine-jour.futur')].map(b => [b.dataset.date > t, b.disabled, b.getAttribute('aria-hidden')].join()),
      // Dernier jour : le dimanche de la semaine, ou aujourd'hui + 3 si c'est plus tard.
      dernierFutur: [...document.querySelectorAll('#semaine-jours .semaine-jour')].pop().dataset.date === [shiftDate(t, (7 - new Date(t + 'T12:00:00').getDay()) % 7), shiftDate(t, 3)].sort().pop(),
      serie: document.getElementById('serie-jours').textContent.trim(), coach: document.getElementById('coach-jour').textContent };
    // Dépassement : l'anneau passe à l'orange-rouge.
    getDay(t).meals[MEALS[1]].push({ name: 'Pizza', grams: 600, kcal: cible, p: 60, c: 200, f: 80 }); saveData(t); renderApp();
    res.tropApres = a.getAttribute('stroke'); res.libelle = document.getElementById('reste-libelle').textContent;
    return res;
  });
  assert.equal(r.part, r.attendu);
  assert.equal(r.trop, 'url(#grad-kcal)');
  // Roulette : 180 jours d'historique jusqu'à aujourd'hui, aujourd'hui au centre ; les jours
  // à venir de la semaine (3 au moins) suivent, grisés et inactifs, jusqu'au dimanche (au-delà s'il en manque).
  assert.equal(r.jours, 181);
  assert.equal(r.dernier, true);
  assert.ok(r.futurs.length >= 3 && r.futurs.length <= 9, String(r.futurs.length));
  assert.ok(r.futurs.every(f => f === 'true,true,true'), r.futurs.join(' '));
  assert.equal(r.dernierFutur, true);
  assert.equal(r.actif, String(new Date().getDate()));
  assert.equal(r.serie, '3');
  assert.match(r.coach, /Coach du jour/);
  assert.equal(r.tropApres, 'url(#grad-kcal-trop)');
  assert.equal(r.libelle, 'Dépassement');
  // Toucher hier : la roulette tourne jusqu'à hier, qui devient le jour affiché.
  await page.click(`#semaine-jours .semaine-jour[data-date="${await page.evaluate(() => shiftDate(todayStr(), -1))}"]`);
  await page.waitForFunction(() => currentDate === shiftDate(todayStr(), -1), null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => document.querySelector('#semaine-jours .semaine-jour.actif').dataset.date), await page.evaluate(() => currentDate));
  // Faire défiler de 5 jours vers le passé : le jour qui s'arrête au centre s'affiche.
  await page.evaluate(() => { const c = document.getElementById('semaine-jours'); rouletteGeste = true; c.scrollLeft -= c.getBoundingClientRect().width / 7 * 5; });
  await page.waitForFunction(() => currentDate === shiftDate(todayStr(), -6), null, { timeout: 3000 });
  // « Aujourd'hui » ramène la roulette au bout.
  await page.click('#semaine-aujourdhui');
  await page.waitForFunction(() => currentDate === todayStr(), null, { timeout: 3000 });
}));

test('anciens styles visuels retirés : un choix enregistré n\'est plus appliqué', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => { localStorage.setItem('anqaa_style', 'systeme'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof allerA === 'function');
  const r = await page.evaluate(() => ({ attr: document.documentElement.hasAttribute('data-style'), local: localStorage.getItem('anqaa_style'),
    selecteur: !!document.getElementById('styles-visuels'), fn: typeof choisirStyle }));
  assert.deepEqual(r, { attr: false, local: null, selecteur: false, fn: 'undefined' });
}));

test('le thème sombre ne casse aucun écran', () => avecAppli({ theme: 'dark' }, async ({ page }) => {
  for (const ecran of ['repas', 'seance', 'stats', 'reglages']) {
    await page.evaluate(e => allerA(e), ecran);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('cardio'); ouvrirCardio(); });
  assert.ok(await page.isVisible('#modal-cardio'));
}));

test('vitrines : Activité (corps, séance du jour, programmes), Cardio (arc, tracés), Profil (niveau, badges, objectif)', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const exos = toutesLesExercices();
    const pecs = exos.filter(e => e.groupe === 'pectoraux').slice(0, 2), jambes = exos.filter(e => e.groupe === 'quadriceps').slice(0, 2);
    const prog = (id, nom, liste) => ({ id, nom, maj: Date.now(), exercices: liste.map(e => ({ exerciceId: e.id, nom: e.nom, series: [{ poids: 40, reps: 10 }, { poids: 40, reps: 10 }] })) });
    musculationProgrammes.push(prog('pa', 'Haut', pecs), prog('pb', 'Bas', jambes));
    // « Haut » fait aujourd'hui : la séance du jour suggérée est « Bas », jamais faite.
    musculationHistorique.push({ id: 'h1', programmeId: 'pa', programmeNom: 'Haut', date: todayStr(), debut: Date.now() - 3e6, fin: Date.now(), dureeMin: 50, maj: Date.now(),
      exercices: pecs.map(e => ({ exerciceId: e.id, nom: e.nom, series: [{ poids: 50, reps: 10, fait: true }, { poids: 50, reps: 8, fait: true }] })) });
    sauvegarderHistorique();
    const j = getDay(todayStr()); j.workouts = [{ type: 'course', time: 30, distance: 5, intensite: 2, cardio: true }]; saveData(todayStr());
    allerA('seance'); choisirModeSeance('muscu');
  });
  const m = await page.evaluate(() => ({
    geant: document.querySelector('#vitrine-muscu .hx-geant').textContent,
    corps: !!document.querySelector('#vitrine-muscu .hx-corps svg path'),
    sdj: document.querySelector('#vitrine-muscu .sdj h4').textContent,
    programmes: [...document.querySelectorAll('#programmes-liste-container .pc b')].map(b => b.textContent),
    // Un seul affichage des programmes (le carrousel), pas de doublon.
    pcAilleurs: document.querySelectorAll('.pc').length - document.querySelectorAll('#programmes-liste-container .pc').length,
    ancienneListe: document.querySelectorAll('.programme-carte').length,
    pasEnBas: getComputedStyle(document.getElementById('carte-pas-seances')).display !== 'none'
  }));
  assert.deepEqual(m, { geant: '4', corps: true, sdj: 'Bas', programmes: ['Haut', 'Bas'], pcAilleurs: 0, ancienneListe: 0, pasEnBas: false });
  // Le ⋯ d'une carte : modifier, dupliquer, supprimer — sans ouvrir l'aperçu.
  await page.click('#programmes-liste-container .pc:nth-child(1) .pc-options');
  assert.ok(await page.isVisible('#menu-programme-popup'));
  assert.equal(await page.evaluate(() => !!document.querySelector('#apercu-programme-modal.show')), false);
  await page.click('#menu-programme-popup [onclick*="modifier"]');
  assert.equal(await page.evaluate(() => programmeEnEdition && programmeEnEdition.nom), 'Haut');
  await page.evaluate(() => { programmeEnEdition = null; renderSeance(); });
  await page.click('#vitrine-muscu .sdj');
  await page.waitForSelector('#apercu-programme-modal.show');
  assert.match(await page.textContent('#apercu-programme-heros'), /Bas/);
  await page.evaluate(() => { fermerModal('apercu-programme-modal'); choisirModeSeance('cardio'); });
  const c = await page.evaluate(() => ({
    arc: !!document.querySelector('#seance-cardio .hx--cardio .arc-val'),
    // Plus de tracé décoratif : la vraie distance, et les séances groupées par mois.
    trace: document.querySelectorAll('#seance-cardio .cardio-seance .trace').length,
    valeur: document.querySelector('#seance-cardio .cardio-seance-val').textContent,
    mois: document.querySelectorAll('#seance-cardio .cardio-mois').length,
    longue: document.querySelector('#seance-cardio .bento .bt-n').textContent
  }));
  assert.deepEqual(c, { arc: true, trace: 0, valeur: '5 km', mois: 1, longue: '5km' });
  await page.evaluate(() => allerA('reglages'));
  const p = await page.evaluate(() => ({
    niveau: document.querySelector('#vitrine-profil .niveau-t b').textContent,
    badges: document.querySelectorAll('#vitrine-profil .badge').length,
    objectifCache: getComputedStyle(document.getElementById('carte-objectif')).display
  }));
  // 1 séance (40 XP) + 1 cardio (25 XP), aucun repas : 65 XP, sous le seuil du niveau 2 (100 XP).
  assert.equal(p.badges, 8);
  assert.match(p.niveau, /^Niveau 1 · Débutant$/);
  assert.equal(p.objectifCache, 'none');
  await page.click('#vitrine-profil .obj-tuile:has-text("Masse")');
  const o = await page.evaluate(() => ({ select: document.getElementById('objectif-select').value, goal: getDay(todayStr()).goal, on: document.querySelector('#vitrine-profil .obj-tuile.on').textContent.trim() }));
  assert.deepEqual(o, { select: 'masse', goal: 'masse', on: 'Masse' });
}));

test('séance : un record est fêté une fois, la série cochée « pop », le repos tourne en anneau', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.groupe === 'pectoraux');
    musculationHistorique.push({ id: 'h1', programmeId: null, programmeNom: 'Séance', date: shiftDate(todayStr(), -3), debut: Date.now() - 3e6, fin: Date.now(), dureeMin: 50, maj: Date.now(),
      exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 60, reps: 8, fait: true }, { poids: 60, reps: 8, fait: true }] }] });
    allerA('seance'); demarrerSeanceLibre(); ajouterExerciceASession(exo.id);
    const s = musculationSessionActive.exercices[0].series;
    s[0].poids = 70; s[0].reps = 8; s[1].poids = 70; s[1].reps = 8;
    basculerSerieSession(0, 0);
    const premier = { fete: document.getElementById('celebration').textContent, record: document.querySelectorAll('.serie-record').length,
      pop: !!document.querySelector('.serie-check.pop[data-serie="0_0"]'), anneau: !!document.querySelector('#repos-anneau-0_0') };
    document.getElementById('celebration').textContent = '';
    basculerSerieSession(0, 1); // même charge : pas un nouveau record
    // L'exercice terminé se replie : les records se comptent dans la séance.
    return { ...premier, deuxieme: document.getElementById('celebration').textContent, records: musculationSessionActive.exercices[0].series.filter(x => x.record).length };
  });
  assert.match(r.fete, /Nouveau record/);
  assert.deepEqual({ record: r.record, pop: r.pop, anneau: r.anneau, deuxieme: r.deuxieme, records: r.records }, { record: 1, pop: true, anneau: true, deuxieme: '', records: 1 });
}));

test('trophées : un badge tout juste gagné est fêté, une seule fois', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    localStorage.setItem('anqaa_trophees', JSON.stringify({ niveau: 1, badges: [] }));
    for (let k = 0; k < 3; k++) { const d = shiftDate(todayStr(), -k), j = getDay(d); j.meals[MEALS[0]].push({ name: 'Pomme', grams: 100, kcal: 52, p: 0, c: 14, f: 0 }); saveData(d); }
    renderApp();
    const fete = document.getElementById('celebration').textContent;
    document.getElementById('celebration').textContent = '';
    renderApp();
    return { fete, encore: document.getElementById('celebration').textContent, memo: JSON.parse(localStorage.getItem('anqaa_trophees')).badges };
  });
  assert.match(r.fete, /Badge débloqué : Série/);
  assert.equal(r.encore, '');
  assert.ok(r.memo.includes('serie'));
}));

test('trophées : un badge déjà gagné n\'est pas refêté quand ses données arrivent après le démarrage', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const d = todayStr(), j = getDay(d); j.meals[MEALS[0]].push({ name: 'Pomme', grams: 100, kcal: 52, p: 0, c: 14, f: 0 }); saveData(d);
    localStorage.setItem('anqaa_trophees', JSON.stringify({ niveau: niveauUtilisateur().n, badges: ['gymbro'] }));
    const fete = () => { const c = document.getElementById('celebration'); const t = c ? c.textContent : ''; if (c) c.textContent = ''; return t; };
    gymbroLiens = [];   // relance : la liste des gymbros n'est pas encore chargée
    renderApp(); const auDemarrage = fete();
    const memo = JSON.parse(localStorage.getItem('anqaa_trophees')).badges;
    gymbroLiens = [{ pseudo: 'carl', sens: 'envoyee', statut: 'acceptee' }];   // elle arrive
    renderApp(); const aLArrivee = fete();
    return { auDemarrage, aLArrivee, memo };
  });
  assert.equal(r.auDemarrage, '');
  assert.ok(r.memo.includes('gymbro'), 'le badge reste mémorisé');
  assert.equal(r.aLArrivee, '', 'pas de fête pour un badge déjà gagné');
}));

test('trophées : l\'arrivée des données au démarrage n\'est pas fêtée', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    renderApp(); // rien de noté : rien de mémorisé
    const avant = localStorage.getItem('anqaa_trophees');
    // Les données arrivent d'un coup (synchronisation) : plusieurs niveaux et badges.
    for (let k = 0; k < 25; k++) { const d = shiftDate(todayStr(), -k), j = getDay(d); j.meals[MEALS[0]].push({ name: 'Pomme', grams: 100, kcal: 52, p: 0, c: 14, f: 0 }); j.eauMl = 4000; saveData(d); }
    for (let k = 0; k < 12; k++) musculationHistorique.push({ id: 'h' + k, date: shiftDate(todayStr(), -k), exercices: [] });
    renderApp(); const premier = (document.getElementById('celebration') || {}).textContent || '';
    localStorage.setItem('anqaa_trophees', JSON.stringify({ niveau: 1, badges: [] }));
    renderApp(); const saut = (document.getElementById('celebration') || {}).textContent || '';
    return { avant, premier, saut };
  });
  assert.deepEqual(r, { avant: null, premier: '', saut: '' });
}));

test('animations : les chiffres défilent jusqu\'à leur valeur exacte', () => avecAppli({ animations: true }, async ({ page }) => {
  await page.evaluate(() => { const j = getDay(todayStr()); j.meals[MEALS[1]].push({ name: 'Riz', grams: 100, kcal: 1234, p: 3, c: 28, f: 0 }); saveData(todayStr()); allerA('repas'); renderApp(); });
  await page.waitForFunction(() => document.getElementById('total-kcals').textContent.replace(/\s/g, '') === '1234');
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('cardio'); });
  await page.waitForFunction(() => /^0/.test(document.querySelector('#seance-cardio .cardio-gros').textContent));
}));

test('bouton + : l\'action utile de chaque écran', () => avecAppli({}, async ({ page }) => {
  const ouvert = () => page.evaluate(() => [...document.querySelectorAll('.feuille.show, .modal.show')].map(m => m.id).join(','));
  const fermer = () => page.evaluate(() => { fermerFeuilles(); document.querySelectorAll('.modal.show').forEach(m => fermerModal(m.id)); });
  await page.evaluate(() => { musculationProgrammes.push({ id: 'pz', nom: 'Jambes', exercices: [], maj: Date.now() }); allerA('repas'); });
  await page.click('#onglet-plus'); assert.equal(await ouvert(), 'feuille-repas'); await fermer();
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('muscu'); });
  assert.equal(await page.getAttribute('#onglet-plus', 'aria-label'), 'Lancer une séance');
  await page.click('#onglet-plus'); assert.equal(await ouvert(), 'feuille-activite');
  assert.match(await page.textContent('#opt-seance-jour'), /Séance du jour\s*Jambes/);
  await page.click('#opt-seance-jour'); assert.equal(await ouvert(), 'apercu-programme-modal'); await fermer();
  await page.evaluate(() => choisirModeSeance('cardio'));
  await page.click('#onglet-plus'); assert.equal(await ouvert(), 'modal-cardio'); await fermer();
  // Progrès : pas de + (grisé, rien ne s'ouvre), sur tous les onglets.
  for (const o of ['resume', 'poids', 'muscu']) {
    await page.evaluate(o => ouvrirStats(o), o);
    assert.equal(await page.isDisabled('#onglet-plus'), true);
    await page.evaluate(() => actionPlus()); assert.equal(await ouvert(), '');
  }
  await page.evaluate(() => allerA('reglages'));
  await page.click('#onglet-plus'); assert.equal(await ouvert(), 'mesures-modal'); await fermer();
  // Séance en cours : plein écran, barre d'onglets cachée ; l'ajout d'exercice
  // passe par le bouton de la séance, « Réduire » ramène à l'écran d'avant.
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('muscu'); demarrerSeanceLibre(); });
  assert.equal(await page.getAttribute('#onglet-plus', 'aria-label'), 'Ajouter un exercice');
  assert.equal(await page.evaluate(() => document.body.classList.contains('mode-seance')), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.onglets')).pointerEvents), 'none');
  await page.click('#seance-vue-active button:has-text("Ajouter un exercice")'); assert.equal(await ouvert(), 'picker-exercices-modal'); await fermer();
  await page.click('.seance-reduire');
  assert.deepEqual(await page.evaluate(() => [ecranActif, document.body.classList.contains('mode-seance'), document.getElementById('bandeau-seance-flottant').classList.contains('hidden')]), ['reglages', false, false]);
  await page.click('#bandeau-seance-flottant');
  assert.deepEqual(await page.evaluate(() => [ecranActif, document.body.classList.contains('mode-seance')]), ['seance', true]);
}));

test("séance en cours : en-tête (chrono, avancée, corps) et un mini-cadran par muscle", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.nom === 'Développé couché avec barre');
    musculationProgrammes.push({ id: 'pc', nom: 'Push', exercices: [{ exerciceId: exo.id, series: [{ poids: 60, reps: 8 }, { poids: 60, reps: 8 }, { poids: 60, reps: 8 }] }], maj: Date.now() });
    allerA('seance'); demarrerSeance('pc');
    basculerSerieSession(0, 0);
    const res = {};
    res.titre = document.getElementById('titre-session-modal').textContent;
    res.chrono = /^\d+:\d{2}$/.test(document.getElementById('session-chrono').textContent);
    res.avancee = document.querySelector('#session-progression .sh-prog-t').textContent.replace(/\s+/g, ' ').trim();
    res.corps = !!document.querySelector('#session-corps svg.corps-svg');
    const c = document.querySelector('#session-zones .mc');
    res.cadran = [c.querySelector('.mc-n').textContent, c.querySelector('.mc-a').textContent];
    c.click();
    res.detail = document.querySelector('#session-zones .mc-detail').textContent;
    document.querySelector('#session-zones .mc').click();
    res.ferme = !document.querySelector('#session-zones .mc-detail');
    basculerCorpsSession();
    res.agrandi = document.getElementById('session-entete').classList.contains('agrandi');
    return res;
  });
  assert.equal(r.titre, 'Push');
  assert.ok(r.chrono, 'chrono en minutes:secondes');
  assert.equal(r.avancee, '1/3 séries · exo 1/1');
  assert.ok(r.corps);
  assert.deepEqual(r.cadran, ['Pectoraux', '+1 auj.']);
  assert.match(r.detail, /^Pectoraux · .* dont 1 aujourd'hui\./);
  assert.ok(r.ferme);
  assert.ok(r.agrandi);
}));

test('vidéos HD : préchargées au démarrage de la séance, reprises telles quelles par la fiche et l\'agrandissement', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => VIDEOS_SMARTWORKOUT[e.id]);
    const url = videoExercice(exo).video;
    musculationProgrammes.push({ id: 'pv', nom: 'Test', exercices: [{ exerciceId: exo.id, series: [{ poids: 20, reps: 8 }] }], maj: Date.now() });
    allerA('seance'); demarrerSeance('pv');
    const prechargee = videosHD.get(url);
    afficherFicheExerciceBiblio(exo.id);
    const fiche = document.querySelector('#fiche-exercice-container video.hd');
    agrandirVideoExercice(exo.id);
    const zoom = document.querySelector('#video-zoom-media video.hd');
    fermerVideoExercice();
    return { prechargee: !!prechargee, memeFiche: fiche === prechargee, memeZoom: zoom === prechargee,
      revenue: document.querySelector('#fiche-exercice-container video.hd') === prechargee, src: fiche && fiche.getAttribute('src') === url };
  });
  assert.deepEqual(r, { prechargee: true, memeFiche: true, memeZoom: true, revenue: true, src: true });
}));

test("frictions : confirmation de l'appli (plus de fenêtre du navigateur), série supprimée avec Annuler, quantité prête à taper, mot de passe plus gardé", () => avecAppli({}, async ({ page, dialogues }) => {
  // Vraie fenêtre de l'appli : Abandonner une séance demande confirmation.
  await page.evaluate(() => {
    confirmer = window.__confirmerReel; informer = window.__informerReel;
    const exo = toutesLesExercices()[0];
    musculationProgrammes.push({ id: 'pf', nom: 'Test', exercices: [{ exerciceId: exo.id, series: [{ poids: 20, reps: 8 }, { poids: 20, reps: 8 }] }], maj: Date.now() });
    allerA('seance'); demarrerSeance('pf');
    abandonnerSeance();
  });
  await page.waitForSelector('#modal-dialogue.show');
  assert.match(await page.textContent('#dialogue-texte'), /Abandonner cette séance/);
  assert.equal(await page.textContent('#dialogue-oui'), 'Abandonner');
  await page.click('#dialogue-non');
  assert.ok(await page.evaluate(() => !!musculationSessionActive), 'Annuler garde la séance');
  // alert() passe aussi par la fenêtre de l'appli.
  await page.evaluate(() => alert('Bonjour'));
  await page.waitForSelector('#modal-dialogue.show');
  assert.equal(await page.isHidden('#dialogue-non'), true);
  await page.click('#dialogue-oui');
  // Série supprimée tout de suite, avec Annuler.
  await page.evaluate(() => retirerSerieSession(0, 1));
  assert.equal(await page.evaluate(() => musculationSessionActive.exercices[0].series.length), 1);
  await page.click('#toast-annuler button');
  assert.equal(await page.evaluate(() => musculationSessionActive.exercices[0].series.length), 2);
  // Aliment choisi : la quantité est sélectionnée, prête à être remplacée.
  const q = await page.evaluate(() => {
    ouvrirManuel('lunch');
    selectionnerProduitOFF({ name: 'Riz cuit', nutriments: { 'energy-kcal_100g': 130 } });
    const c = document.activeElement;
    return { id: c.id, tout: c.selectionStart === 0 && c.selectionEnd === c.value.length };
  });
  assert.deepEqual(q, { id: 'man-grams', tout: true });
  // « Se souvenir de moi » : plus de case, plus de mot de passe gardé.
  const mdp = await page.evaluate(() => {
    localStorage.setItem('mc_identifiants_sauvegardes', JSON.stringify({ email: 'a@b.fr', mdp: 'secret' }));
    tenterConnexionAutomatique();
    return { reste: localStorage.getItem('mc_identifiants_sauvegardes'), caseSouvenir: !!document.getElementById('compte-souvenir') };
  });
  assert.deepEqual(mdp, { reste: null, caseSouvenir: false });
  assert.equal(dialogues.length, 0, 'aucune fenêtre du navigateur');
}));

test('séance : pavé de saisie à la salle (− / +, pas selon le matériel, valider)', () => avecAppli({}, async ({ page }) => {
  const r0 = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.materiel === 'barre');
    musculationHistorique.push({ id: 'h1', date: shiftDate(todayStr(), -2), exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 60, reps: 8, fait: true }, { poids: 60, reps: 8, fait: true }] }] });
    allerA('seance'); demarrerSeanceLibre(); ajouterExerciceASession(exo.id);
    const s = musculationSessionActive.exercices[0].series; s.forEach(x => { x.poids = null; x.reps = null; }); renderSessionModal();
    return { paves: document.querySelectorAll('.serie-pave').length, poids: document.getElementById('pave-poids-0_0').textContent, reps: document.getElementById('pave-reps-0_0').textContent };
  });
  // Pré-rempli avec la dernière perf, un seul pavé (la série à faire).
  assert.deepEqual(r0, { paves: 1, poids: '60', reps: '8' });
  const plus = '#pave-0_0 .pave-champ:nth-child(1) .pave-btn:last-of-type';
  await page.click(plus); await page.click(plus);
  await page.click('#pave-0_0 .pave-champ:nth-child(2) .pave-btn:first-of-type');
  let r = await page.evaluate(() => ({ poids: document.getElementById('pave-poids-0_0').textContent, champ: document.getElementById('serie-poids-0_0').value, reps: document.getElementById('pave-reps-0_0').textContent }));
  assert.deepEqual(r, { poids: '65', champ: '65', reps: '7' }); // barre : 2,5 kg par pas
  await page.click('#pave-0_0 .pave-valider');
  r = await page.evaluate(() => ({ fait: musculationSessionActive.exercices[0].series[0].fait, valeurs: [musculationSessionActive.exercices[0].series[0].poids, musculationSessionActive.exercices[0].series[0].reps], pave: !!document.getElementById('pave-0_1'), suivant: document.getElementById('pave-poids-0_1').textContent }));
  // Validée ; le pavé passe à la série suivante, qui reprend la charge.
  assert.deepEqual(r, { fait: true, valeurs: [65, 7], pave: true, suivant: '65' });
}));

test('séance du jour : le programme suivant dans l\'ordre de la liste', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    ['A', 'B', 'C'].forEach(n => musculationProgrammes.push({ id: 'p' + n, nom: n, exercices: [], maj: Date.now() }));
    const fait = (id, k) => musculationHistorique.unshift({ id: 'h' + id + k, programmeId: id, programmeNom: id, date: shiftDate(todayStr(), -k), fin: Date.now() - k * 1000, exercices: [] });
    const res = [programmeSuggere().p.nom];   // rien de fait : le premier
    fait('pB', 2); res.push(programmeSuggere().p.nom);   // après B : C
    fait('pA', 5); res.push(programmeSuggere().p.nom);   // A plus ancien : toujours C
    fait('pC', 1); res.push(programmeSuggere().p.nom);   // après C, le dernier : retour à A
    musculationHistorique.unshift({ id: 'libre', programmeId: null, date: todayStr(), exercices: [] });
    res.push(programmeSuggere().p.nom);   // une séance vide ne compte pas
    allerA('seance'); choisirModeSeance('muscu');
    res.push(document.querySelector('#vitrine-muscu .sdj h4').textContent);
    return res;
  });
  assert.deepEqual(r, ['A', 'C', 'C', 'A', 'A', 'A']);
}));

test('bilan de fin de séance : récapitulatif (tonnage, séries, records, écart), plus d\'avis IA', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.groupe === 'pectoraux');
    musculationProgrammes.push({ id: 'pb', nom: 'Pecs', exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 60, reps: 8 }, { poids: 60, reps: 8 }] }], maj: Date.now() });
    musculationHistorique.push({ id: 'h0', programmeId: 'pb', programmeNom: 'Pecs', date: shiftDate(todayStr(), -3), dureeMin: 40, exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 60, reps: 8, fait: true }, { poids: 60, reps: 8, fait: true }] }] });
    allerA('seance'); demarrerSeance('pb');
    musculationSessionActive.exercices[0].series.forEach(s => { s.poids = 70; s.reps = 8; s.fait = true; });
    terminerSeance();
    const z = document.getElementById('bilan-seance-recap');
    return { titre: z.querySelector('h4').textContent, tonnage: z.querySelector('.bilan-geant b').textContent.replace(/\s/g, ''),
      tuiles: [...z.querySelectorAll('.bilan-tuile b')].map(b => b.textContent), records: z.querySelectorAll('.bilan-records > div').length,
      ecart: z.querySelector('.bilan-ecart').textContent.trim(), ia: !!document.getElementById('bilan-seance-container') || /coach/i.test(document.getElementById('bilan-seance-modal').textContent) };
  });
  assert.deepEqual(r, { titre: 'Pecs', tonnage: '1120', tuiles: ['< 1', '2', '1'], records: 1, ecart: '▲ 17 % vs la dernière fois', ia: false });
}));

test('séance : repos à rebours réglable (retenu dans le programme), disques à la barre', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const exo = toutesLesExercices().find(e => e.materiel === 'barre');
    musculationProgrammes.push({ id: 'pr', nom: 'Force', exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids: 100, reps: 5 }, { poids: 100, reps: 5 }, { poids: 100, reps: 5 }] }], maj: Date.now() });
    allerA('seance'); demarrerSeance('pr'); replierTousExercicesSession(false);
    const res = { disques: document.getElementById('pave-disques-0_0').textContent.replace(/\s+/g, ' ').trim() };
    basculerSerieSession(0, 0);
    res.chrono = document.getElementById('repos-chrono-0_0').textContent;
    ajusterReposExo(0, 15);
    res.apres = document.getElementById('repos-chrono-0_0').textContent;
    res.retenu = musculationProgrammes.find(p => p.id === 'pr').exercices[0].repos;
    // Fin du repos : la barre passe à « Go ! »
    reposActifs['0_0'] = Date.now() - 106 * 1000; majReposActifs();
    res.fini = document.getElementById('repos-barre-0_0').classList.contains('fini');
    res.go = document.getElementById('repos-libelle-0_0').textContent;
    res.plus = document.getElementById('repos-chrono-0_0').textContent;
    return res;
  });
  assert.deepEqual(r, { disques: 'Par côté :2515', // 100 kg : 40 kg par côté = 25 + 15
    chrono: '1:30', apres: '1:45', retenu: 105, fini: true, go: 'Go !', plus: '+0:01' });
}));

test('repas : annuler une suppression, « Comme hier », favoris, pesée et pas rapides, eau libre, icônes', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const hier = shiftDate(todayStr(), -1), jh = getDay(hier);
    jh.meals[MEALS[0]].push({ name: "Flocons d'avoine", grams: 80, kcal: 300, p: 10, c: 50, f: 6 }, { name: 'Lait demi-écrémé', grams: 200, kcal: 92, p: 6, c: 10, f: 3 });
    saveData(hier);
    allerA('repas'); currentDate = todayStr(); renderApp();
    const res = {};
    // « Comme hier »
    ouvrirFeuilleRepas(MEALS[0]);
    res.hier = !document.getElementById('opt-hier').classList.contains('hidden') && document.getElementById('opt-hier-titre').textContent;
    copierRepasPrecedent();
    res.copies = getDay(todayStr()).meals[MEALS[0]].map(x => x.name);
    res.icones = [...document.querySelectorAll('#meals-container .food-initiale')].slice(0, 2).map(x => x.textContent);
    // Suppression puis annulation
    supprimerAliment(MEALS[0], 0);
    res.apresSuppr = getDay(todayStr()).meals[MEALS[0]].length;
    document.querySelector('#toast-annuler button').click();
    res.apresAnnul = getDay(todayStr()).meals[MEALS[0]].map(x => x.name);
    // Pesée rapide
    ouvrirSaisieRapide('poids'); document.getElementById('saisie-rapide-champ').value = 81.4; validerSaisieRapide();
    res.poids = [getDay(todayStr()).weight, userProfile.mesures[todayStr()].poids];
    // Pas : la pastille du résumé ouvre la saisie
    document.querySelector('.heros-puce-modif').click();
    res.feuillePas = document.getElementById('feuille-saisie-rapide').classList.contains('show');
    document.getElementById('saisie-rapide-plus').click(); document.getElementById('saisie-rapide-plus').click(); validerSaisieRapide();
    res.pas = getDay(todayStr()).steps;
    // Eau libre
    const avant = Number(getDay(todayStr()).eauMl) || 0;
    ouvrirSaisieRapide('eau'); document.getElementById('saisie-rapide-champ').value = 330; validerSaisieRapide();
    res.eau = (Number(getDay(todayStr()).eauMl) || 0) - avant;
    // Favori : en tête de « Déjà mangé »
    const cle = historique().find(e => /lait/i.test(e.nom)).cle;
    basculerAlimentFavori(cle);
    res.favoriEnTete = chercherDansHistorique('')[0].name;
    return res;
  });
  assert.deepEqual(r, { hier: 'Comme hier', copies: ["Flocons d'avoine", 'Lait demi-écrémé'], icones: ['🥣', '🥛'], apresSuppr: 1, apresAnnul: ["Flocons d'avoine", 'Lait demi-écrémé'],
    poids: [81.4, 81.4], feuillePas: true, pas: 1000, eau: 330, favoriEnTete: 'Lait demi-écrémé' });
}));

test('thème « Auto » : suit le réglage clair/sombre du téléphone, même en cours de route ; flou coupé si moins de transparence', () => avecAppli({}, async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => choisirTheme('auto'));
  const lire = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, pref: localStorage.getItem('elite_theme'),
    actif: document.querySelector('#segment-theme [aria-pressed="true"], #segment-theme .actif')?.textContent.trim() || null }));
  const sombre = await lire();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(50);
  const clair = await lire();
  assert.deepEqual([sombre.theme, sombre.pref, clair.theme, clair.pref], ['dark', 'auto', 'light', 'auto']);
  assert.equal(clair.actif, 'Auto');
  // Un choix explicite ne bouge plus avec le système.
  await page.evaluate(() => choisirTheme('dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal((await lire()).theme, 'dark');
  // Flou : présent d'ordinaire, coupé avec « réduire la transparence » ou peu de mémoire.
  const flou = () => page.evaluate(() => getComputedStyle(document.getElementById('onglets')).backdropFilter);
  // Un changement de thème retire le flou une image (deux fois, à 80 ms d'écart) pour forcer le repeint.
  await page.waitForFunction(() => !document.documentElement.classList.contains('theme-repaint'));
  await page.waitForTimeout(200);
  assert.notEqual(await flou(), 'none');
  await page.evaluate(() => document.documentElement.classList.add('flou-leger'));
  assert.equal(await flou(), 'none');
  // Pas de service worker hors http(s) (fichier ouvert en local, tests).
  assert.equal(await page.evaluate(() => navigator.serviceWorker ? navigator.serviceWorker.controller : null), null);
}));

test('Progrès : résumé en une phrase, projection, maintenance réelle, constats, période en pastille, mensurations, force', () => avecAppli({}, async ({ page }) => {
  await page.evaluate(() => {
    const t = todayStr();
    userProfile.mesures = {};
    for (let k = 0; k <= 34; k++) {
      const d = shiftDate(t, -k), j = getDay(d), we = [0, 6].includes(new Date(d + 'T12:00:00').getDay());
      j.weight = Math.round((80 + k * 0.03) * 100) / 100;
      j.meals[MEALS[0]].push({ name: 'Poulet rôti', grams: 300, kcal: we ? 2500 : 2000, p: 150, c: 200, f: 70 });
      saveData(d);
    }
    userProfile.mesures[shiftDate(t, -25)] = { tailleCm: 86 };
    userProfile.mesures[shiftDate(t, -2)] = { tailleCm: 84.5 };
    userProfile.poidsVise = 78;
    const exo = toutesLesExercices().find(e => e.groupe === 'pectoraux');
    const seance = (id, date, poids) => ({ id, programmeNom: 'Pecs', date, debut: Date.now(), fin: Date.now(), dureeMin: 50, maj: Date.now(),
      exercices: [{ exerciceId: exo.id, nom: exo.nom, series: [{ poids, reps: 10, fait: true }, { poids, reps: 10, fait: true }, { poids, reps: 9, fait: true }] }] });
    musculationHistorique.push(seance('a1', shiftDate(t, -45), 60), seance('a2', shiftDate(t, -38), 60), seance('b1', shiftDate(t, -20), 62.5), seance('b2', shiftDate(t, -6), 65));
    const j = getDay(t); j.workouts = j.workouts || []; j.workouts.push({ type: 'course', time: 30, distance: 5, intensite: 2, cardio: true }); saveData(t);
    buildMasterArrays();
    choisirPeriodeStats('30');
    ouvrirProgres();
  });
  await page.waitForTimeout(300);
  let r = await page.evaluate(() => ({
    phrase: document.querySelector('.pg-heros h3').textContent,
    sous: document.querySelector('.pg-heros p').textContent,
    courbe: !!document.querySelector('.pg-heros .pg-h-courbe .pg-h-proj'),
    tuiles: document.querySelectorAll('#pg-resume .pg-tuile--lien').length,
    maint: Number((document.querySelector('#pg-resume .pg-maint b').textContent.match(/[\d\s ]+/) || [''])[0].replace(/\D/g, '')),
    faits: [...document.querySelectorAll('#pg-resume .pg-fait')].map(f => f.textContent.replace(/\s+/g, ' ').trim()),
    serie: document.querySelector('#pg-resume .pg-serie').textContent,
    cal: document.querySelectorAll('#pg-resume .pg-cal i').length,
    ligne: document.getElementById('stats-periode-resume').textContent
  }));
  assert.match(r.phrase, /^Tu perds 0,2 kg par semaine sans perdre de force\.$/);
  assert.match(r.sous, /objectif 78 kg vers le/);
  assert.ok(r.courbe);
  assert.equal(r.tuiles, 4);
  assert.ok(r.maint >= 2300 && r.maint <= 2450, 'maintenance ' + r.maint);
  assert.ok(r.faits.some(f => /1 record/.test(f)), r.faits.join(' | '));
  assert.ok(r.faits.some(f => /Le week-end : \+500 kcal/.test(f)), r.faits.join(' | '));
  assert.match(r.serie, /35 jours\s*de suite.*record 35/);
  assert.equal(r.cal, 30);
  assert.match(r.ligne, /comparé aux 30 jours d’avant$/);
  // Une tuile ouvre son onglet.
  await page.click('#pg-resume .pg-tuile--lien');
  assert.equal(await page.evaluate(() => categorieStatsActive()), 'poids');
  // La période : pastille, menu, choix, menu refermé.
  await page.click('#pg-periode-btn');
  assert.equal(await page.evaluate(() => document.getElementById('pg-periode-menu').classList.contains('hidden')), false);
  await page.click('#stats-periode button:nth-child(3)');
  r = await page.evaluate(() => ({ p: periodeStats, lib: document.getElementById('pg-periode-lib').textContent, ferme: document.getElementById('pg-periode-menu').classList.contains('hidden') }));
  assert.deepEqual(r, { p: '90', lib: '3 mois', ferme: true });
  await page.evaluate(() => choisirPeriodeStats('30'));
  // Corps : mensurations et leur écart, projection.
  r = await page.evaluate(() => ({ mesures: document.getElementById('pg-mensurations').textContent.replace(/\s+/g, ' '), proj: document.getElementById('pg-projection-corps').textContent }));
  assert.match(r.mesures, /Tour de taille\s*84,5 cm\s*−1,5 cm/);
  assert.match(r.proj, /objectif 78 kg vers le/);
  // Repas : un seul graphique visible, choisi au sélecteur ; week-ends marqués.
  await page.evaluate(() => choisirOngletStats('nutrition'));
  await page.waitForFunction(() => caloriesChartInstance && caloriesChartInstance.options.plugins.weekEnds);
  await page.click('#nutri-series-nav button:nth-child(5)');
  r = await page.evaluate(() => ({ actives: [...document.querySelectorAll('#ecran-stats .nutri-serie--active')].map(d => d.dataset.serie),
    weekEnds: caloriesChartInstance.options.plugins.weekEnds.dates.length, top: document.querySelector('#pg-top-aliments b').textContent }));
  assert.deepEqual(r, { actives: ['eau'], weekEnds: 30, top: 'Poulet rôti' });
  // Cardio : la semaine en cours et ce qu'il manque.
  await page.evaluate(() => choisirOngletStats('activite'));
  assert.match(await page.textContent('#pg-cardio-semaine'), /30 \/ 150 min.*Encore 120 min/s);
  // Muscu : force exercice par exercice, bulle au toucher d'une case.
  await page.evaluate(() => choisirOngletStats('muscu'));
  await page.waitForTimeout(250);
  assert.match(await page.textContent('#pg-force .pg-lift em'), /↗ \+\d+ %/);
  await page.click('#pg-grille-muscu .zones-case:not(.vide)');
  r = await page.evaluate(() => { const b = document.getElementById('pg-bulle'); return { visible: b.classList.contains('visible'), texte: b.textContent }; });
  assert.ok(r.visible);
  assert.match(r.texte, /Pectoraux · .* : \d+(,\d)? séries?/);
  // Poids visé : effacé, la phrase invite à en fixer un.
  await page.evaluate(() => { userProfile.poidsVise = null; choisirOngletStats('resume'); majToutesStats(); });
  assert.match(await page.textContent('.pg-heros p'), /Fixe un poids visé/);
}));

test('profil : le formulaire suit le profil enregistré et une saisie vide ne remplace rien', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    onbReponses.gender = 'f'; onbReponses.goal = 'seche'; onbReponses.pasHabituels = 6000;
    document.getElementById('onb-age').value = '41'; document.getElementById('onb-taille').value = '163'; document.getElementById('onb-poids').value = '68';
    await onbTerminer();
    document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    allerA('reglages');
    const formulaire = ['base-gender', 'base-age', 'base-height'].map(id => document.getElementById(id).value);
    // Corriger un seul champ ne réécrit pas les autres avec des valeurs par défaut.
    const sel = document.getElementById('base-gender'); sel.value = 'm'; sel.dispatchEvent(new Event('change'));
    const apresSexe = [userProfile.gender, userProfile.age, userProfile.height];
    // Un âge effacé garde l'ancien, et le champ le réaffiche.
    const age = document.getElementById('base-age'); age.value = ''; age.dispatchEvent(new Event('change'));
    const ageGarde = age.value;
    // Profil arrivé d'un autre appareil : le formulaire se met à jour.
    Object.assign(userProfile, { age: 52, height: 181 }); renderApp();
    return { formulaire, apresSexe, ageGarde, synchro: ['base-age', 'base-height'].map(id => document.getElementById(id).value) };
  });
  assert.deepEqual(r.formulaire, ['f', '41', '163']);
  assert.deepEqual(r.apresSexe, ['m', 41, 163]);
  assert.equal(r.ageGarde, '41');
  assert.deepEqual(r.synchro, ['52', '181']);
}));

test("boissons : l'hydratation suit la boisson (ajout, suppression, annulation, quantité), pas l'alcool", () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const eau = () => Number(getDay(currentDate).eauMl) || 0;
    const ajouter = async (nom, ml) => { ouvrirManuel('breakfast'); uniteCourante = 'ml'; activeMealId = 'breakfast';
      document.getElementById('man-name').value = nom; document.getElementById('man-grams').value = ml; document.getElementById('man-kcal100').value = 45; await validerAjoutManuel(); };
    const e = {};
    await ajouter('Lait demi-écrémé', 250); e.lait = eau();
    await ajouter('Bière blonde', 500); e.biere = eau();
    await ajouter('Bière sans alcool', 330); e.sansAlcool = eau();
    supprimerAliment('breakfast', getDay(currentDate).meals.breakfast.findIndex(i => /Lait/.test(i.name))); e.suppression = eau();
    document.querySelector('#toast-annuler button').click(); e.annulation = eau();
    ouvrirPoidsAliment(document.querySelector('#meals-container .food-info[data-nom^="Lait"]'));
    document.getElementById('macros-popup-poids').value = 400; validerPoidsAliment(); e.quantite = eau();
    return e;
  });
  assert.deepEqual(r, { lait: 250, biere: 250, sansAlcool: 580, suppression: 330, annulation: 580, quantite: 730 });
}));

test('chiffres : même tendance du poids et même moyenne de calories sur Repas du jour et Progrès, nombres à la française', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(async () => {
    const t = todayStr();
    userProfile.mesures = {};
    for (let k = 35; k >= 0; k--) {
      const d = shiftDate(t, -k), jour = getDay(d);
      jour.weight = Math.round((80 + k * 0.06 + (k % 3) * 0.2) * 10) / 10;
      jour.meals[MEALS[0]].push({ name: 'Test', kcal: k === 0 ? 400 : 1800 + (k % 5) * 40, p: 140, c: 200, f: 60 });
      saveData(d);
    }
    userProfile.mesures[t] = { poids: 80.3, grassePct: 17.5, muscleKg: 36.4 };
    allerA('repas'); renderApp();
    const poids = document.querySelector('#carte-stats-poids').textContent.match(/−[0-9,]+ kg\/sem\./)[0];
    const nutri = document.querySelector('#carte-stats-nutrition .carte-stats-valeur b').textContent;
    const mesure = document.getElementById('resume-mesures').textContent;
    choisirPeriodeStats('30'); allerA('stats');
    await new Promise(res => setTimeout(res, 400));
    const phrase = document.querySelector('.pg-heros').textContent;
    choisirOngletStats('nutrition');
    await new Promise(res => setTimeout(res, 300));
    return { poids, phrase, nutri, moyRepas: document.querySelector('#ecran-stats').textContent.replace(/\s+/g, ' '), mesure };
  });
  const rythme = r.poids.replace('−', '').replace(' kg/sem.', '');
  assert.match(r.phrase, new RegExp('Tu perds ' + rythme + ' kg par semaine'));
  assert.match(r.moyRepas, new RegExp(r.nutri.replace(/\s/g, '\\s') + '\\s*kcal'));
  // 29 journées terminées (aujourd'hui, entamé, n'entre pas dans la moyenne).
  assert.equal(r.nutri.replace(/\s/g, ''), '1883');
  assert.match(r.mesure, /80,3 kg · 17,5 % de masse grasse · 36,4 kg de muscle/);
}));

/* Deux appareils d'un même compte (téléphone et tablette) sur un faux serveur. */
async function deuxAppareils(corps) {
  const serveur = creerServeur();
  const tel = await ouvrirAppli(navigateur, {}), tab = await ouvrirAppli(navigateur, {});
  try {
    await brancherServeur(tel.page, serveur, 'u1');
    await brancherServeur(tab.page, serveur, 'u1');
    await corps(tel.page, tab.page, serveur);
    assert.deepEqual(tel.erreurs, [], 'erreurs JavaScript (téléphone)');
    assert.deepEqual(tab.erreurs, [], 'erreurs JavaScript (tablette)');
  } finally { await tel.ctx.close(); await tab.ctx.close(); }
}
const noterAliment = (page, repas, nom) => page.evaluate(([r, n]) => {
  const j = todayStr(); getDay(j).meals[r].push({ name: n, grams: 100, unite: 'g', kcal: 100, p: 5, c: 15, f: 2 }); saveData(j);
}, [repas, nom]);
const retirerAliment = (page, repas, nom) => page.evaluate(([r, n]) => {
  const j = todayStr(), l = getDay(j).meals[r]; l.splice(l.findIndex(i => i.name === n), 1); saveData(j);
}, [repas, nom]);
const journee = page => page.evaluate(() => { const d = getDay(todayStr()); return { matin: d.meals.breakfast.map(i => i.name), midi: d.meals.lunch.map(i => i.name), eau: Number(d.eauMl) || 0 }; });
const synchro = (page, raison = 'auto') => page.evaluate(r => synchroniser(r), raison);

test('synchro : une journée modifiée sur deux appareils est fusionnée, rien ne se perd', () => deuxAppareils(async (tel, tab) => {
  await noterAliment(tel, 'breakfast', 'Flocons');
  await synchro(tel); await synchro(tab);
  assert.deepEqual((await journee(tab)).matin, ['Flocons']);
  // Le téléphone, hors ligne : une banane, deux bananes identiques, 500 ml d'eau, et il retire les flocons.
  await noterAliment(tel, 'breakfast', 'Banane'); await noterAliment(tel, 'breakfast', 'Banane');
  await tel.evaluate(() => ajouterEau(500));
  await retirerAliment(tel, 'breakfast', 'Flocons');
  // Pendant ce temps, la tablette note son déjeuner et 250 ml, et l'envoie.
  await noterAliment(tab, 'lunch', 'Poulet');
  await tab.evaluate(() => ajouterEau(250));
  await synchro(tab);
  // Le téléphone revient en ligne : fusion, puis la tablette la récupère.
  await synchro(tel); await synchro(tab);
  const attendu = { matin: ['Banane', 'Banane'], midi: ['Poulet'], eau: 750 };
  assert.deepEqual(await journee(tel), attendu);
  assert.deepEqual(await journee(tab), attendu);
  // Plus rien en attente d'envoi.
  assert.deepEqual(await tel.evaluate(() => joursModifies()), {});
}));

test("synchro : après la première, seules les nouveautés sont téléchargées, et un appareil à l'heure décalée est vu", () => deuxAppareils(async (tel, tab, serveur) => {
  await noterAliment(tel, 'breakfast', 'Pain');
  await synchro(tel); await synchro(tab);
  const lectures = () => serveur.journal.filter(q => q.table === 'journees' && q.op === 'select');
  const avant = lectures().length;
  // L'horloge de la tablette retarde de 3 heures.
  await tab.evaluate(() => { const vrai = Date.now; Date.now = () => vrai() - 3 * 3600e3; });
  await noterAliment(tab, 'lunch', 'Riz');
  await synchro(tab); await synchro(tel);
  const suivantes = lectures().slice(avant);
  assert.ok(suivantes.length >= 2 && suivantes.every(q => q.filtres.some(f => f[0] === 'gt')), 'lecture incrémentale : ' + JSON.stringify(suivantes.map(q => q.filtres)));
  assert.deepEqual((await journee(tel)).midi, ['Riz']);
  // Recettes et exercices des autres : relus seulement lors d'une synchro complète.
  const recettes = serveur.journal.filter(q => q.table === 'recettes_perso').length;
  await synchro(tel);
  assert.equal(serveur.journal.filter(q => q.table === 'recettes_perso').length, recettes);
  await synchro(tel, 'manuel');
  assert.ok(serveur.journal.filter(q => q.table === 'recettes_perso').length > recettes);
}));

test('bibliothèque : classiques en tête puis l\'alphabet ; icônes d\'aliments ; objectifs du premier lancement', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const noms = () => [...document.querySelectorAll('#picker-liste-exercices .exo-ligne-nom')].map(n => n.firstChild.textContent.trim());
    ouvrirPickerExercices('bibliotheque');
    const res = { tete: noms().slice(0, 5) };
    const champ = document.getElementById('picker-recherche');
    champ.value = 'curl'; rendrePickerExercices();
    res.curl = noms().slice(0, 3);
    const l = noms(), k = l.filter(n => /^curl/i.test(n)).length;
    res.toutesCurl = k > 3 && l.slice(0, k).every(n => /^curl/i.test(n));
    champ.value = ''; document.getElementById('picker-filtre-groupe').value = 'abdos'; rendrePickerExercices();
    const abdos = noms(); const apres = abdos.slice(2);
    res.abdos = abdos.slice(0, 2);
    res.alpha = apres.every((n, i) => !i || COLLATEUR_FR.compare(apres[i - 1], n) <= 0);
    fermerModal('picker-exercices-modal');
    res.icones = ['Thé vert', 'Escalope de veau', 'Laitue', 'Gâteau au chocolat', 'Pain au chocolat', 'Œufs brouillés', 'Plat mystère'].map(iconeAliment);
    getDay(todayStr()).meals[MEALS[0]].push({ name: 'Plat mystère', grams: 100, kcal: 100, p: 1, c: 1, f: 1 }); saveData(todayStr()); allerA('repas'); renderApp();
    res.ligne = [...document.querySelectorAll('.food-initiale')].map(x => x.textContent.trim()).pop();
    res.objectifs = [...document.querySelectorAll('#onb-objectif .onb-option')].map(b => b.dataset.valeur + ':' + b.querySelector('strong').textContent);
    return res;
  });
  assert.deepEqual(r.tete, ['Squat avec barre', 'Développé couché avec barre', 'Soulevé de terre', 'Développé militaire', 'Traction']);
  assert.deepEqual(r.curl, ['Curl à la barre', 'Curl prise marteau', r.curl[2]]);
  assert.match(r.curl[2], /^Curl/);
  assert.equal(r.toutesCurl, true);
  assert.deepEqual(r.abdos, ['Planche', 'Crunchs abdominaux']);
  assert.equal(r.alpha, true);
  assert.deepEqual(r.icones, ['🍵', '🥩', '🥗', '🍰', '🥐', '🍳', '🍽️']);
  assert.equal(r.ligne, '🍽️');
  assert.deepEqual(r.objectifs, ['seche:Sèche', 'maintien:Maintien', 'masse:Prise de masse', 'recomposition:Recomposition']);
}));

test('IA : cachée sans clé liée au compte, visible avec', () => avecAppli({}, async ({ page, dialogues }) => {
  const etat = () => page.evaluate(() => {
    const vu = sel => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
    const avant = [ecranActif];
    allerA('repas'); ouvrirFeuilleRepas(repasDuMoment());
    const r = { classe: document.documentElement.classList.contains('ia-active'), photo: vu('#opt-photo'), idees: vu('.idees-recette'),
      bilanJour: vu('#carte-bilan-jour'), periode: vu('.stats-bilan'), programme: vu('[onclick="ouvrirAssistantProgrammeIA()"].action-tuile'),
      aideIA: vu('#aide-routine-modal .btn-primary.ia-seulement'), exercicesLarge: getComputedStyle(document.querySelector('.pleine-sans-ia')).gridColumnStart };
    fermerFeuilles(); allerA(avant[0]);
    demarrerTourGuide('muscu'); r.etapesMuscu = tourListe.filter(e => e.ia).length; fermerTourGuide();
    demarrerTourGuide(); r.texteBilan = tourListe.find(e => e.titre === 'Bilan de la journée').texte; fermerTourGuide();
    return r;
  });
  const sans = await etat();
  assert.deepEqual([sans.classe, sans.photo, sans.idees, sans.bilanJour, sans.periode, sans.programme, sans.aideIA], [false, false, false, false, false, false, false]);
  assert.equal(sans.exercicesLarge, '1');
  assert.equal(sans.etapesMuscu, 0);
  assert.doesNotMatch(sans.texteBilan, /IA/);
  // Appelée quand même (écran resté ouvert) : un message clair, rien ne s'ouvre.
  await page.evaluate(() => ouvrirPhoto(MEALS[0]));
  assert.equal(await page.evaluate(() => document.getElementById('ai-modal').classList.contains('show')), false);
  assert.match(dialogues.pop(), /pas activée sur ton compte/);
  // Clé liée au compte (synchronisée avec le profil) : tout réapparaît.
  await page.evaluate(() => { userProfile.geminiKey = 'AIza-test'; appliquerGeminiKeyEffective(); });
  const avec = await etat();
  assert.deepEqual([avec.classe, avec.photo, avec.idees, avec.bilanJour, avec.periode, avec.programme, avec.aideIA], [true, true, true, true, true, true, true]);
  assert.equal(avec.etapesMuscu, 1);
  assert.match(avec.texteBilan, /par l'IA/);
}));

test('accessibilité : zoom permis, champs à 16 px, pas de bouton dans un bouton, cartes au clavier, zones de 44 px', () => avecAppli({}, async ({ page }) => {
  const r = await page.evaluate(() => {
    const t = todayStr();
    for (let k = 0; k < 12; k++) { const d = shiftDate(t, -k); getDay(d).meals[MEALS[0]].push({ name: 'Riz', grams: 100, kcal: 1800, p: 100, c: 200, f: 60 }); saveData(d); }
    musculationProgrammes.push({ id: 'pa', nom: 'Haut', exercices: [], maj: Date.now() });
    const res = { viewport: document.querySelector('meta[name="viewport"]').content, toucher: getComputedStyle(document.documentElement).touchAction };
    const champs = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden]), select:not(.hidden), textarea')];
    res.petitsChamps = champs.filter(c => parseFloat(getComputedStyle(c).fontSize) < 16).map(c => c.id || c.className);
    const imbriques = [];
    for (const e of ['repas', 'seance', 'stats', 'reglages']) {
      allerA(e); if (e === 'stats') ouvrirStats('resume'); renderApp();
      document.querySelectorAll('button, a[href], [role="button"]').forEach(b => {
        if (b.querySelector('button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')) imbriques.push(e + ':' + (b.id || b.className));
      });
    }
    res.imbriques = imbriques;
    allerA('stats'); ouvrirStats('resume');
    res.casesSansRole = document.querySelectorAll('i[data-bulle]:not([role="img"])').length;
    allerA('repas');
    const zone = getComputedStyle(document.querySelector('.repas-ajouter'), '::after');
    res.zone = [parseFloat(zone.width) >= 44, parseFloat(zone.height) >= 44];
    return res;
  });
  assert.doesNotMatch(r.viewport, /user-scalable|maximum-scale/);
  assert.equal(r.toucher, 'manipulation');
  assert.deepEqual(r.petitsChamps, []);
  assert.deepEqual(r.imbriques, []);
  assert.equal(r.casesSansRole, 0);
  assert.deepEqual(r.zone, [true, true]);
  // Le résumé des calories s'ouvre au clavier (Entrée sur son bouton) comme au doigt.
  await page.focus('#ecran-repas .summary-card .carte-action');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.getElementById('depense-modal').classList.contains('show')), true);
  await page.evaluate(() => fermerModal('depense-modal'));
  // Une carte de programme : le toucher l'ouvre toujours une seule fois.
  await page.evaluate(() => { allerA('seance'); choisirModeSeance('muscu'); window.__apercus = 0; apercuProgramme = () => { window.__apercus++; }; });
  await page.click('#programmes-liste-container .pc b');
  await page.focus('#programmes-liste-container .pc .carte-action'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__apercus), 2);
}));

test("eau : l'eau versée coule, monte avec le total, puis tout revient au calme dans l'état final", () => avecAppli({ animations: true }, async ({ page }) => {
  await page.evaluate(() => { getDay(currentDate).eauMl = 1000; saveData(currentDate); allerA('repas'); renderApp(); document.getElementById('bloc-eau').scrollIntoView(); });
  await page.waitForTimeout(1300);
  // Deux appuis rapprochés : un seul filet, la pastille cumule.
  await page.evaluate(() => { ajouterEau(250); ajouterEau(250); });
  await page.waitForFunction(() => document.getElementById('gourde-filet-eau').getAttribute('d'), null, { timeout: 3000 });
  const pendant = await page.evaluate(() => ({ anime: !!gourdeAnim, pastille: document.getElementById('eau-ajout').textContent,
    ouverte: document.getElementById('gourde').classList.contains('ouverte'), donnee: getDay(currentDate).eauMl }));
  assert.deepEqual(pendant, { anime: true, pastille: '+500 ml', ouverte: true, donnee: 1500 });
  await page.waitForFunction(() => !gourdeAnim, null, { timeout: 8000 });
  const fin = await page.evaluate(() => {
    const quota = quotaEauSuggere(currentDate);
    return { texte: document.getElementById('eau-texte').textContent === `${texteLitres(1500)} / ${texteLitres(quota)} L`,
      niveau: document.getElementById('eau-vague').style.transform === `translateY(${((1 - partGourde(1500, quota)) * GOURDE_COURSE).toFixed(1)}px)`,
      particules: document.getElementById('gourde-particules').childElementCount, filet: document.getElementById('gourde-filet-eau').getAttribute('d'),
      calme: document.getElementById('gourde-surface').getAttribute('transform'), ouverte: document.getElementById('gourde').classList.contains('ouverte') };
  });
  assert.deepEqual(fin, { texte: true, niveau: true, particules: 0, filet: '', calme: null, ouverte: false });
  // Retrait : le niveau baisse sans filet, et l'animation s'arrête aussi.
  await page.evaluate(() => retirerEau());
  assert.equal(await page.evaluate(() => !!gourdeAnim && !document.getElementById('gourde').classList.contains('ouverte')), true);
  await page.waitForFunction(() => !gourdeAnim, null, { timeout: 5000 });
  assert.match(await page.textContent('#eau-texte'), /^1,25 \//);
}));

test("démarrage : le T se forme puis va se poser dans la barre du haut ; ensuite démarrage court ; simple fondu en mouvement réduit", async () => {
  // Horloge figée dès le départ : les étapes de l'écran de démarrage
  // (minuteries) n'avancent que quand le test le décide.
  async function lancer(ctx) {
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', e => erreurs.push(e.message));
    await page.clock.install({ time: new Date('2026-10-23T08:00:00') });
    await page.clock.pauseAt(new Date('2026-10-23T08:00:01'));
    await page.goto('file://' + path.join(RACINE, 'index.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof allerA === 'function' && typeof Chart !== 'undefined');
    // Compte « connecté » : la fenêtre de connexion fermée, Repas du jour affiché.
    await page.evaluate(() => { connexionObligatoire = false; document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); document.body.classList.remove('couche-ouverte'); });
    return { page, erreurs };
  }
  const etat = page => page.evaluate(() => {
    const s = document.getElementById('splash-screen'), logo = document.querySelector('.app-bar .logo-anqa');
    return { affiche: getComputedStyle(s).display !== 'none', court: s.classList.contains('spl-court'), logo: logo.style.opacity, lettres: s.querySelectorAll('.spl-lettre').length };
  });
  const contexte = reducedMotion => navigateur.newContext({ viewport: { width: 390, height: 844 }, reducedMotion }).then(async ctx => {
    await ctx.route(/^https?:/, r => /\/npm\/chart\.js@/.test(r.request().url())
      ? r.fulfill({ path: path.join(RACINE, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'), contentType: 'application/javascript' }) : r.abort());
    await ctx.addInitScript(() => { try { localStorage.setItem('installPopupVu', String(Date.now())); } catch (e) {} });
    return ctx;
  });

  const ctx = await contexte('no-preference');
  try {
    // Premier lancement : animation complète, le T reste jusqu'à 2,4 s.
    const { page, erreurs } = await lancer(ctx);
    await page.clock.runFor(2300);
    assert.deepEqual(await etat(page), { affiche: true, court: false, logo: '', lettres: 7 });
    // Puis il s'envole vers le logo de la barre (caché le temps du vol)…
    await page.clock.runFor(200);
    assert.equal((await etat(page)).logo, '0');
    const arrivee = await page.evaluate(() => {
      const t = document.querySelector('#splash-screen .spl-t');
      t.getAnimations().forEach(a => a.finish());
      const r = t.getBoundingClientRect(), l = document.querySelector('.app-bar .logo-anqa').getBoundingClientRect();
      // Le masque du logo est en « contain » dans sa case : même largeur, centré en hauteur.
      return [r.left - l.left, r.width - l.width, (r.top + r.height / 2) - (l.top + l.height / 2)].map(v => Math.round(Math.abs(v)));
    });
    assert.deepEqual(arrivee, [0, 0, 0], 'le T se pose exactement sur le logo de la barre');
    // … et s'y pose : l'écran disparaît, le vrai logo reprend sa place.
    await page.clock.runFor(1000);
    assert.deepEqual(await etat(page), { affiche: false, court: false, logo: '', lettres: 7 });
    assert.deepEqual(erreurs, []);

    // Lancement suivant (nouvel onglet, même appareil) : le T déjà formé, envol à ~0,4 s.
    const deux = await lancer(ctx);
    assert.deepEqual(await etat(deux.page), { affiche: true, court: true, logo: '', lettres: 7 });
    await deux.page.clock.runFor(500);
    assert.equal((await etat(deux.page)).logo, '0');
    await deux.page.clock.runFor(1000);
    assert.deepEqual(await etat(deux.page), { affiche: false, court: true, logo: '', lettres: 7 });
    // Rechargé dans la même session : plus d'écran de démarrage du tout.
    await deux.page.reload({ waitUntil: 'load' });
    assert.equal((await etat(deux.page)).affiche, false);
    assert.deepEqual(deux.erreurs, []);
  } finally {
    await ctx.close();
  }

  // Mouvement réduit : rien ne bouge, l'écran fond simplement, sans envol.
  const ctxReduit = await contexte('reduce');
  try {
    const { page, erreurs } = await lancer(ctxReduit);
    assert.deepEqual(await etat(page), { affiche: true, court: true, logo: '', lettres: 7 });
    await page.clock.runFor(750);
    assert.equal((await etat(page)).logo, '');
    await page.clock.runFor(400);
    assert.deepEqual(await etat(page), { affiche: false, court: true, logo: '', lettres: 7 });
    assert.deepEqual(erreurs, []);
  } finally {
    await ctxReduit.close();
  }
});

test("connexion : ouverte d'elle-même (lancement sans session), elle ne fait pas surgir le clavier ; ouverte à la main, le champ email prend le focus", () => avecAppli({}, async ({ page }) => {
  const focus = () => page.evaluate(() => new Promise(r => setTimeout(() => r((document.activeElement && document.activeElement.id) || ''), 150)));
  // Lancement sans session : la fenêtre de connexion s'ouvre seule, sans focus.
  await page.evaluate(() => definirSessionUtilisateur(null));
  assert.equal(await page.evaluate(() => document.getElementById('compte-modal').classList.contains('show')), true);
  assert.equal(await focus(), '');
  // Pendant l'écran de démarrage, aucune fenêtre ne prend le focus.
  await page.evaluate(() => { connexionObligatoire = false; fermerModal('compte-modal'); document.getElementById('splash-screen').style.display = ''; ouvrirModal('compte-modal'); });
  assert.equal(await focus(), '');
  // Ouverte à la main, une fois l'appli affichée : le champ email est prêt.
  await page.evaluate(() => { fermerModal('compte-modal'); document.getElementById('splash-screen').style.display = 'none'; ouvrirModal('compte-modal'); });
  assert.equal(await focus(), 'compte-email-input');
}));

test("bande unie en haut (contre le flou d'iOS) : couleur du fond, absente du Profil, couleur de l'écran de démarrage tant qu'il est là", () => avecAppli({}, async ({ page }) => {
  // Lu une image plus tard : en mouvement réduit, chaque changement de couleur
  // passe par une transition de 0,01 ms.
  const lire = () => page.evaluate(() => new Promise(fin => requestAnimationFrame(() => requestAnimationFrame(() => fin(0))))).then(() => page.evaluate(() => {
    const b = document.querySelector('.bord-haut'), r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    return { affichee: cs.display !== 'none', fixe: cs.position === 'fixed', haut: r.top, pleineLargeur: r.width === innerWidth, assezHaute: r.height >= 12,
      memeFond: cs.backgroundColor === getComputedStyle(document.body).backgroundColor, fond: cs.backgroundColor };
  }));
  await page.evaluate(() => allerA('repas'));
  const repas = await lire();
  assert.deepEqual({ ...repas, fond: undefined }, { affichee: true, fixe: true, haut: 0, pleineLargeur: true, assezHaute: true, memeFond: true, fond: undefined });
  await page.evaluate(() => allerA('reglages'));
  assert.equal((await lire()).affichee, false);
  await page.evaluate(() => { allerA('repas'); document.documentElement.classList.add('spl-actif'); });
  assert.equal((await lire()).fond, 'rgb(255, 255, 255)');
  await page.evaluate(() => document.documentElement.classList.remove('spl-actif'));
}));
