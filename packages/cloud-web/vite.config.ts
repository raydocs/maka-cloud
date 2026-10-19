import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { mockMiddleware } from './mock/server';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-contract-mock',
      configureServer(server) {
        if (process.env.CLOUD_WEB_MOCK === '1') server.middlewares.use(mockMiddleware());
      },
    },
  ],
  define: { __MOCK__: JSON.stringify(process.env.CLOUD_WEB_MOCK === '1') },
  resolve: {
    // Reuse the public ChoicePanel export without building the desktop/UI graph.
    // This is the same implementation exported by packages/ui/src/index.ts.
    alias: { '@maka/ui': fileURLToPath(new URL('../ui/src/choice-panel.tsx', import.meta.url)) },
    dedupe: ['react', 'react-dom', '@astryxdesign/core'],
  },
  test: { environment: 'jsdom', include: ['tests/**/*.test.{ts,tsx}'], restoreMocks: true },
  server: {
    port: 4173,
    strictPort: true,
    watch: { ignored: ['**/test-results/**', '**/playwright-report/**', '**/evidence/**'] },
  },
});
