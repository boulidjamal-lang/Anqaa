// Crochets de résolution : tout import « npm:stripe@… » ou
// « npm:@supabase/supabase-js@… » pointe vers les doubles de test.
const DOUBLES = new URL('./doubles.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('npm:')) return { url: DOUBLES + '?' + encodeURIComponent(specifier), shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(DOUBLES)) {
    const quoi = decodeURIComponent(url.split('?')[1] || '');
    const exporte = quoi.startsWith('npm:stripe@') ? 'export default globalThis.__doubles.Stripe;'
      : 'export const createClient = (...a) => globalThis.__doubles.createClient(...a);';
    return { format: 'module', source: exporte, shortCircuit: true };
  }
  return nextLoad(url, context);
}
