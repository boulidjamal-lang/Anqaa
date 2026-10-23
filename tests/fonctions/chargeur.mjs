// Fait tourner les Edge Functions (Deno, TypeScript) sous Node pour les
// tests : les imports « npm:… » sont remplacés par des doubles de test
// (tests/fonctions/doubles.mjs), et Deno par un objet minimal.
import { register } from 'node:module';
register(new URL('./crochets.mjs', import.meta.url));
