/* Outils communs aux tests : ouvre index.html dans Chromium, sans réseau
   (Supabase, IA, polices… sont bloqués : l'appli doit fonctionner sans),
   avec Chart.js servi depuis node_modules à la place du CDN. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const RACINE = path.join(__dirname, '..');
const URL_APPLI = 'file://' + path.join(RACINE, 'index.html');
const CHART_JS = path.join(RACINE, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
// Le Chromium des tests perd parfois, au rechargement, le localStorage d'une
// page ouverte en fichier local (file://) : les tests qui rechargent l'appli
// la servent en https sur ce faux domaine (voir options.https).
const HOTE_HTTPS = 'appli.test';

// Chromium : CHROMIUM_PATH si défini, sinon celui préinstallé pour
// Playwright (/opt/pw-browsers), sinon celui que Playwright connaît.
function cheminChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dossiers = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dossiers) {
      for (const sous of ['chrome-linux', 'chrome-linux64']) {
        const exe = path.join(base, d, sous, 'chrome');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (e) {}
  return undefined;
}

async function lancerNavigateur() {
  return chromium.launch({ executablePath: cheminChromium() });
}

/* Nouvelle page sur l'appli, connexion obligatoire contournée, écran de
   démarrage et fenêtres d'accueil fermés. Renvoie { page, erreurs, dialogues } :
   `erreurs` reçoit toute exception JavaScript non rattrapée de la page. */
async function ouvrirAppli(navigateur, options = {}) {
  // Mouvement réduit par défaut : les chiffres s'affichent tout de suite à
  // leur valeur (pas de défilement), ce que les tests lisent aussitôt.
  const ctx = await navigateur.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    reducedMotion: options.animations ? 'no-preference' : 'reduce', serviceWorkers: 'block' });
  await ctx.route(/^https?:/, r => {
    const url = new URL(r.request().url());
    if (/\/npm\/chart\.js@/.test(url.href)) return r.fulfill({ path: CHART_JS, contentType: 'application/javascript' });
    // options.https : l'appli servie en https (https://appli.test/) depuis
    // le dossier du dépôt, comme sur le site, au lieu d'un fichier local.
    if (options.https && url.host === HOTE_HTTPS) {
      const fichier = path.join(RACINE, decodeURIComponent(url.pathname));
      if (fichier.startsWith(RACINE + path.sep) && fs.existsSync(fichier)) return r.fulfill({ path: fichier });
      return r.fulfill({ status: 404, body: '' });
    }
    return r.abort();
  });
  // La proposition « installer sur l'écran d'accueil » s'ouvre 1,2 s après
  // le démarrage et masquerait les boutons : on la marque comme déjà vue.
  await ctx.addInitScript(() => { try { localStorage.setItem('installPopupVu', String(Date.now())); } catch (e) {} });
  if (options.natif) await ctx.addInitScript(installerFauxNatif);
  const page = await ctx.newPage();
  const erreurs = [];
  const dialogues = [];
  page.on('pageerror', e => erreurs.push(e.message));
  page.on('dialog', d => { dialogues.push(d.message()); d.accept(); });
  // Les fenêtres de l'appli (confirmer / informer) remplacent confirm() et
  // alert() : elles sont notées dans `dialogues` et acceptées d'office.
  await page.exposeFunction('__noterDialogue', m => { dialogues.push(m); });
  await page.goto(options.https ? `https://${HOTE_HTTPS}/index.html` : URL_APPLI, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof allerA === 'function' && typeof Chart !== 'undefined');
  await page.waitForTimeout(800);
  await preparer(page, options.theme);
  return { page, ctx, erreurs, dialogues };
}

/* Faux iPhone : window.AppNatif comme dans l'app iOS (dépôt Anqa,
   ios-app/src/natif.js). Chaque appel d'un module est noté dans
   window.__appelsNatifs ([module, méthode, options]) ; les réponses viennent
   de window.__reponsesNatives (« Module.methode » → valeur ou fonction). */
function installerFauxNatif() {
  window.__appelsNatifs = [];
  window.__reponsesNatives = window.__reponsesNatives || {};
  const module = nom => new Proxy({}, {
    get: (cible, methode) => (options, ...reste) => {
      window.__appelsNatifs.push([nom, methode, options === undefined ? null : JSON.parse(JSON.stringify(options))]);
      const r = window.__reponsesNatives[nom + '.' + methode];
      try { return Promise.resolve(typeof r === 'function' ? r(options, ...reste) : (r === undefined ? {} : r)); } catch (e) { return Promise.reject(e); }
    }
  });
  const natif = { plateforme: 'ios', version: 'test', disponible: () => true };
  ['App', 'Browser', 'Filesystem', 'Haptics', 'Keyboard', 'LocalNotifications', 'ScreenOrientation', 'Share', 'SplashScreen',
    'StatusBar', 'KeepAwake', 'CapacitorBarcodeScanner', 'Health', 'NativePurchases', 'Onglets'].forEach(n => { natif[n] = module(n); });
  window.AppNatif = natif;
}

async function preparer(page, theme) {
  await page.evaluate(theme => {
    connexionObligatoire = false;
    window.__confirmerReel = confirmer; window.__informerReel = informer;
    confirmer = texte => { window.__noterDialogue(String(texte)); return Promise.resolve(true); };
    informer = texte => { window.__noterDialogue(String(texte)); return Promise.resolve(true); };
    const sp = document.getElementById('splash-screen');
    if (sp) sp.style.display = 'none';
    document.documentElement.classList.remove('spl-actif');
    document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    document.body.classList.remove('couche-ouverte');
    if (theme) appliquerTheme(theme);
  }, theme || null);
}

module.exports = { lancerNavigateur, ouvrirAppli, preparer, RACINE };
