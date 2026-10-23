import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { build } from 'vite';

async function workerScript(): Promise<string> {
  const result = await build({
    configFile: false,
    publicDir: false,
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('./src/sw.js', import.meta.url)),
        formats: ['iife'],
        name: 'MakaWorker',
      },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if ('output' in bundle) {
    const worker = bundle.output.find((chunk) => chunk.type === 'chunk');
    if (worker?.type === 'chunk') return worker.code;
  }
  throw new Error('Service worker build produced no script');
}

let building = false;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'cloud-web-service-worker',
      configResolved(config) {
        building = config.command === 'build';
      },
      configureServer(server) {
        server.middlewares.use('/sw.js', async (_request, response) => {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(await workerScript());
        });
      },
      async buildStart() {
        if (!building) return;
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: await workerScript() });
      },
    },
  ],
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
