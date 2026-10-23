import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'cloud-web-service-worker',
      configureServer(server) {
        // Serve the module at the root in dev too, so the worker retains its existing scope.
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/sw.js') request.url = '/src/sw.js';
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw.js', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  resolve: {
    // Reuse the public ChoicePanel export without building the desktop/UI graph.
    // This is the same implementation exported by packages/ui/src/index.ts.
    alias: {
      '@maka/ui': fileURLToPath(new URL('../ui/src/choice-panel.tsx', import.meta.url)),
      // The logic the phone apps share; source-only, so no build step sits between them.
      '@maka-cloud/client': fileURLToPath(new URL('../cloud-client/src/index.ts', import.meta.url)),
    },
    dedupe: ['react', 'react-dom', '@astryxdesign/core'],
  },
  test: { environment: 'jsdom', include: ['tests/**/*.test.{ts,tsx}'], restoreMocks: true },
  server: {
    // Development against a running cloud-server: the app and the API share an origin.
    proxy: process.env.CLOUD_WEB_API
      ? { '/v1': { target: process.env.CLOUD_WEB_API, changeOrigin: false } }
      : undefined,
    port: 4173,
    strictPort: true,
    watch: { ignored: ['**/test-results/**', '**/playwright-report/**', '**/evidence/**'] },
  },
});
