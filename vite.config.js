import { defineConfig } from 'vite';

export default defineConfig({
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
