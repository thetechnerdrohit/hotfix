// ============================================================================
// server/loader.mjs — Node ESM loader hook that lets the AUTHORITATIVE server
// import the UNMODIFIED client game modules from ../src directly, so the sim is
// byte-identical to the browser (no forked physics/combat/map/AI).
//
// It bridges exactly three Vite-isms that plain Node ESM doesn't handle, and
// touches NOTHING in src/ (the file fence): the transforms happen only in this
// loader, in memory, at import time.
//
//   1. `import X from 'three/addons/…'` — Vite alias. We resolve it to the real
//      package path `three/examples/jsm/…`.
//   2. `import DATA from './foo.json'` — Vite imports JSON as a default export.
//      Node <20.10 demands an `assert {type:'json'}` / `with {type:'json'}` in
//      SOURCE (the validator runs before load hooks can inject attributes), so
//      instead we synthesize a tiny JS module `export default <raw json>`.
//   3. `import.meta.env.DEV` — Vite injects `import.meta.env`; in Node it's
//      undefined and `.DEV` throws. We rewrite `import.meta.env` →
//      `(import.meta.env||{})` in src/ modules so the dev-only branches become
//      dead code (undefined → falsy) exactly as a production Vite build strips
//      them. No behavioural change: those branches are dev asserts/self-checks.
//
// The rewrites apply ONLY to files under a `/src/` path of this repo — the
// server's own code, three, colyseus, node stdlib are all passed straight
// through. This is a build-time compatibility shim, not a runtime dependency of
// the shipped game.
//
// Node ≥20.6 could use module.register(); we use --experimental-loader so this
// runs on the repo's Node 19.9 too (see server/package.json scripts).
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const THREE_ADDONS = 'three/addons/';
const SRC_MARKER = '/src/'; // only rewrite the client's own source modules

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(THREE_ADDONS)) {
    return next('three/examples/jsm/' + specifier.slice(THREE_ADDONS.length), context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  // (2) JSON → synthesized JS module (dodges the source-level assertion check).
  if (url.endsWith('.json') && url.includes(SRC_MARKER)) {
    const raw = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${raw};` };
  }
  // (3) import.meta.env guard for client source modules.
  if ((url.endsWith('.js') || url.endsWith('.mjs')) && url.includes(SRC_MARKER)) {
    let src = readFileSync(fileURLToPath(url), 'utf8');
    if (src.includes('import.meta.env')) {
      src = src.replace(/import\.meta\.env/g, '(import.meta.env||{})');
      return { format: 'module', shortCircuit: true, source: src };
    }
  }
  return next(url, context);
}
