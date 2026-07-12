// Loader hook for register-json.mjs — makes the game's src/ modules loadable
// under plain Node (the authoritative server reuses them unchanged):
//   1. *.json imports get the required `type: 'json'` import attribute
//      (Vite accepts bare JSON imports; Node does not).
//   2. `import.meta.env.DEV` (a Vite injection) is rewritten to `false` in
//      module source — server semantics = production; the DEV self-checks are
//      covered by the repo's verify-* scripts instead.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    return nextLoad(url, { ...context, importAttributes: { type: 'json' } });
  }
  const out = await nextLoad(url, context);
  if (url.includes('/src/') && out.source && String(out.source).includes('import.meta.env')) {
    return { ...out, source: String(out.source).replaceAll('import.meta.env.DEV', 'false') };
  }
  return out;
}
