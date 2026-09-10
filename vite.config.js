import { defineConfig } from 'vite';

/**
 * The repository's index.html doubles as the dev entry and as whatever a static
 * host serves from the repository root, so it carries a redirect to the built
 * site. That redirect must never survive into the build itself, or the built
 * page would bounce to docs/docs/.
 */
function stripRootRedirect() {
  const BLOCK = /[ \t]*<!-- root-redirect:start -->[\s\S]*?<!-- root-redirect:end -->\n?/;
  return {
    name: 'strip-root-redirect',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!BLOCK.test(html)) {
          throw new Error('index.html no longer contains the root-redirect block — ' +
            'either restore the markers or delete this plugin.');
        }
        return html.replace(BLOCK, '');
      },
    },
  };
}

export default defineConfig({
  plugins: [stripRootRedirect()],
  // Relative base so the same build works on GitHub Pages project sites,
  // user sites, and local `vite preview` without rewriting asset URLs.
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
    target: 'es2022',
    minify: 'terser',
    terserOptions: { compress: { passes: 2 }, format: { comments: false } },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/peerjs')) return 'net';
        },
      },
    },
  },
  server: { host: true, port: 5173 },
});
