import { test, expect } from '@playwright/test';
import { fixtureTransport } from '../fixtures/browser.js';

test.beforeEach(async ({ page }) => { await fixtureTransport(page); });

test('landing page leads to Learn and profile menu holds Courses, Settings and sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Make the next/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /New lesson/i })).toHaveCount(0);
  await page.getByLabel('Open guest profile menu').click();
  await expect(page.getByRole('link', { name: 'Courses', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Start learning' }).click();
  await expect(page).toHaveURL(/\/learn$/);
  await expect(page.getByRole('heading', { name: 'What do you want to learn?' })).toBeVisible();
});

test('legacy Review and new-lesson URLs return to Learn', async ({ page }) => {
  await page.goto('/review');
  await expect(page).toHaveURL(/\/learn$/);
  await page.goto('/learn/new');
  await expect(page).toHaveURL(/\/learn$/);
});
