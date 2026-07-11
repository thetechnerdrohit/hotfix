import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a build works under a subpath host (itch.io, GH Pages) — J8
  base: './',
});
