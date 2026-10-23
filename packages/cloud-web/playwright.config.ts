import { defineConfig, devices } from '@playwright/test';

// The app talks to the real cloud-server (fake runner, temporary SQLite), started by
// tests/support/serve.ts. Build the server first: `npm --workspace @maka-cloud/server run build`.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  maxFailures: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH,
    },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'node tests/support/serve.ts',
      url: 'http://127.0.0.1:4175/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'CLOUD_WEB_API=http://127.0.0.1:4174 npm run dev -- --port 4173 --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
