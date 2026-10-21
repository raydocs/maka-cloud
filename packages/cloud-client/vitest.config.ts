import { defineConfig } from 'vitest/config';

// The shared logic must not need a DOM, so its tests run in plain Node.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], restoreMocks: true },
});
