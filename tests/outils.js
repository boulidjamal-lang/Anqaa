/* Outils communs aux tests : ouvre index.html dans Chromium, sans réseau
   (Supabase, IA, polices… sont bloqués : l'appli doit fonctionner sans),
   avec Chart.js servi depuis node_modules à la place du CDN. */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const RACINE = path.join(__dirname, '..');
const URL_APPLI = 'file://' + path.join(RACINE, 'index.html');
const CHART_JS = path.join(RACINE, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');

// Chromium : CHROMIUM_PATH si défini, sinon celui préinstallé pour
// Playwright (/opt/pw-browsers), sinon celui que Playwright connaît.
function cheminChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dossiers = fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dossiers) {
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
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
    reducedMotion: options.animations ? 'no-preference' : 'reduce' });
  await ctx.route(/^https?:/, r => {
    if (/\/npm\/chart\.js@/.test(r.request().url())) return r.fulfill({ path: CHART_JS, contentType: 'application/javascript' });
    return r.abort();
  });
  // La proposition « installer sur l'écran d'accueil » s'ouvre 1,2 s après
  // le démarrage et masquerait les boutons : on la marque comme déjà vue.
  await ctx.addInitScript(() => { try { localStorage.setItem('installPopupVu', String(Date.now())); } catch (e) {} });
  const page = await ctx.newPage();
  const erreurs = [];
  const dialogues = [];
  page.on('pageerror', e => erreurs.push(e.message));
  page.on('dialog', d => { dialogues.push(d.message()); d.accept(); });
  await page.goto(URL_APPLI, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof allerA === 'function' && typeof Chart !== 'undefined');
  await page.waitForTimeout(800);
  await preparer(page, options.theme);
  return { page, ctx, erreurs, dialogues };
}

async function preparer(page, theme) {
  await page.evaluate(theme => {
    connexionObligatoire = false;
    const sp = document.getElementById('splash-screen');
    if (sp) sp.style.display = 'none';
    document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show'));
    document.body.classList.remove('couche-ouverte');
    if (theme) appliquerTheme(theme);
  }, theme || null);
}

module.exports = { lancerNavigateur, ouvrirAppli, preparer, RACINE };
