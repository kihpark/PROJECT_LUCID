import { defineConfig, devices } from '@playwright/test';

// ★ fix/stellar-6-class-with-screenshots — STELLAR_E2E_PORT lets the dev
// PC route Playwright off the default port if another process (eg.
// docker-compose lucid-web) is already bound to :3000. CI keeps :3000.
const PORT = process.env.STELLAR_E2E_PORT
  ? Number(process.env.STELLAR_E2E_PORT)
  : 3000;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `corepack pnpm exec next dev -p ${PORT}`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
