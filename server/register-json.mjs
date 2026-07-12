// ============================================================================
// Node loader hook: let the server import the game's src/ modules unchanged.
// Vite accepts bare `import DATA from './x.json'`; Node requires an import
// attribute (`with { type: 'json' }`). Rather than churn every src/world file
// (and risk the Vite/esbuild side), this hook injects the attribute for any
// .json specifier at load time. Registered via:  node --import ./register-json.mjs
// ============================================================================
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./json-hook.mjs', import.meta.url), pathToFileURL('./'));
