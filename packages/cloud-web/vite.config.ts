import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Reuse the public ChoicePanel export without building the desktop/UI graph.
    // This is the same implementation exported by packages/ui/src/index.ts.
    alias: { '@maka/ui': fileURLToPath(new URL('../ui/src/choice-panel.tsx', import.meta.url)) },
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
