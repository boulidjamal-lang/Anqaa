# Tests d'Anqā

Ces tests ouvrent la vraie appli (`index.html`) dans Chromium et la font
tourner comme un utilisateur : chargement, repas, pas, séance de musculation,
programme, cardio, statistiques, visites guidées, thème sombre. Un test échoue
aussi si la page lève la moindre erreur JavaScript.

Le réseau est coupé pendant les tests (Supabase, IA, polices) : l'appli doit
fonctionner sans. Chart.js est servi depuis `node_modules`, dans la même
version que celle de `index.html` (un test vérifie qu'elles correspondent).

`tests/fonctions.test.js` teste à part les deux fonctions serveur du Pro
(`supabase/functions/ia` et `stripe-webhook`) : elles tournent sous Node avec
de faux Supabase, Stripe et Gemini (`tests/fonctions/`), sans rien déployer.

## Lancer

```
npm install
npm test                 # fonctions serveur, puis l'appli
npm run test:fonctions   # seulement les fonctions serveur
```

Chromium : celui de `CHROMIUM_PATH` s'il est défini, sinon celui préinstallé
pour Playwright (`/opt/pw-browsers`), sinon celui de Playwright
(`npx playwright-core install chromium`).

## Quand les lancer

Avant chaque envoi sur GitHub, et après avoir changé la version d'une
bibliothèque dans `index.html`.
