import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config.js';

const address = process.env.TOKAI_E2E_REMOTE_URL;
if (!address) throw new Error('Set the explicit protected preview URL before running remote integration.');
const url = new URL(address);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use the HTTPS preview origin without credentials or query parameters.');

export default defineConfig({
  ...base,
  testMatch: 'production-integration.spec.ts',
  webServer: [],
  outputDir: '../../test-results/remote-integration',
  reporter: [['list'], ['json', { outputFile: resolve(__dirname, '../../test-results/remote-integration/report.json') }]],
  use: { ...base.use, baseURL: url.origin, trace: 'off', screenshot: 'only-on-failure' },
});
