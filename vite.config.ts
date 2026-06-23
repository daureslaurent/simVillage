import { defineConfig } from 'vite';

/**
 * Vite config lives at the project root so the `vite` / `vite build` scripts
 * (run from the root) pick it up automatically, while `root: 'client'` keeps the
 * actual web app under client/.
 *
 * `fs.allow: ['..']` is what lets client code import the shared protocol from
 * ../shared/types — otherwise Vite refuses to serve files outside its root.
 */
export default defineConfig({
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
