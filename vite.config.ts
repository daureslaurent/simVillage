import { defineConfig } from 'vite';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const commitCount = (() => {
  try { return execSync('git rev-list --count HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return '0'; }
})();
const APP_VERSION = `${pkg.version}.${commitCount}`;

/**
 * Vite config lives at the project root so the `vite` / `vite build` scripts
 * (run from the root) pick it up automatically, while `root: 'client'` keeps the
 * actual web app under client/.
 *
 * `fs.allow: ['..']` is what lets client code import the shared protocol from
 * ../shared/types — otherwise Vite refuses to serve files outside its root.
 */
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  root: 'client',
  server: {
    host: true, // bind 0.0.0.0 so the dev server is reachable from outside the container
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['..'], // permit importing ../shared from the project root
    },
    // Polling keeps HMR reliable across the WSL2 <-> Docker bind-mount boundary.
    watch: { usePolling: true },
  },
});
