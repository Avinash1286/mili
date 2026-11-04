import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testDir: '../e2e',
  outputDir: '../../test-results/regression',
  reporter: [['list'], ['json', { outputFile: resolve(__dirname, '../../test-results/regression/report.json') }]],
});
