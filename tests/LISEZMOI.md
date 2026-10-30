# Tests d'Anqā

Ces tests ouvrent la vraie appli (`index.html`) dans Chromium et la font
tourner comme un utilisateur : chargement, repas, pas, séance de musculation,
programme, cardio, statistiques, visites guidées, thème sombre. Un test échoue
aussi si la page lève la moindre erreur JavaScript.

Le réseau est coupé pendant les tests (Supabase, IA, polices) : l'appli doit
fonctionner sans. Chart.js est servi depuis `node_modules`, dans la même
version que celle de `index.html` (un test vérifie qu'elles correspondent).

`tests/fonctions.test.js` teste à part les fonctions serveur du Pro
(`supabase/functions/ia`, `stripe-webhook` et `achats-apple`) : elles tournent
sous Node avec de faux Supabase, Stripe, Gemini et App Store
(`tests/fonctions/`), sans rien déployer.

L'app iOS (dépôt Anqa, `ios-app/`) embarque cette même appli. Les tests
« app iOS » l'ouvrent avec un faux iPhone (`ouvrirAppli(navigateur, { natif:
true })` dans `tests/outils.js`) : chaque appel aux modules de l'iPhone
(vibrations, notifications, Santé, achats…) y est noté, et un test vérifie
que sur le web rien ne change.

Ce qui passe entre comptes (Gymbro, séance en direct, séance à deux) est
testé avec un faux Supabase écrit dans chaque test : les appels de l'appli
y sont notés et les réponses des autres comptes simulées, y compris des
données piégées (un nom d'exercice qui contient du HTML doit rester du texte).

L'Administration a son propre faux Supabase (`installerFauxAdmin` dans
`tests/appli.test.js`) : chaque test lui donne une fonction qui renvoie les
réponses (« table:nom », « table:nom:compte », « table:nom:update »,
« rpc:nom » : une valeur, une fonction de la requête ou `{ __erreur }`).
Elle est exécutée dans la page, elle peut donc utiliser les variables de
l'appli (`VERSION_APPLI`…). Les appels sont notés dans `window.__appels`,
et un test vérifie que le bilan « Serveur et SQL » ne modifie rien.

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
