import { test, expect } from '@playwright/test';
import { fixtureTransport } from '../fixtures/browser.js';

test.beforeEach(async ({ page }) => { await fixtureTransport(page); });

test('guest can open a prepared lesson and find it in Courses', async ({ page }) => {
  await page.goto('/learn');
  await expect(page.getByRole('heading', { name: 'What do you want to learn?' })).toBeVisible();
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Photosynthesis/ }).click();
  await expect(page).toHaveURL(/\/learn\//);
  await expect(page.getByRole('heading', { name: 'A sealed jar in the sun' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ready for question' })).toBeVisible();
  await page.goto('/courses');
  await expect(page.locator('.course-card')).toHaveCount(1);
  await expect(page.locator('.course-card')).toContainText('How plants make their food');
  await expect(page.locator('.course-card')).toContainText('In progress');
});

test('prepared lesson remains usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn');
  await page.getByRole('button', { name: 'Offline demo', exact: true }).click();
  await page.getByRole('button', { name: /^Circuits/ }).click();
  await expect(page.getByRole('heading', { name: 'Close the loop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask milli for help' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
