import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  timeout: 60000, expect: { timeout: 15000 },
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'pnpm --filter @tokai/api start', url: 'http://localhost:4000/health/live', reuseExistingServer: !process.env.CI, timeout: 60000 },
    { command: 'pnpm dev:web', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 120000 },
    { command: 'pnpm exec tsx tests/fixtures/voice-api.ts', url: 'http://localhost:4100/health/live', reuseExistingServer: false, timeout: 60000 }
  ]
});
