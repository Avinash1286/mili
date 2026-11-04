import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from '../../playwright.config.js';

const workspace = resolve(__dirname, '../..');
const servers = Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : [];

// The audit uses the same isolated provider fixtures. Production mode requires
// a completed Next build and checks its real enforcing response headers.
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/phase6',
  reporter: [['list'], ['json', { outputFile: resolve(workspace, 'test-results/phase6/report.json') }]],
  webServer: servers.map(server => ({ ...server, cwd: workspace, ...(process.env.TOKAI_E2E_PRODUCTION === '1' && server.url === 'http://localhost:3000' ? { command: 'pnpm --filter @milli/web start' } : {}) })),
});
