import { expect, test } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';
import { audit } from './audit.js';

for (const route of ['/', '/learn/new', '/dashboard', '/library', '/settings', '/review']) {
  test(`default colors and semantics on ${route}`, async ({ page }, info) => {
    const transport = await fixtureTransport(page);
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (route === '/') await expect(page.getByRole('button', { name: /^Live AI/ })).toBeEnabled();
    if (route === '/learn/new') await expect(page.getByRole('combobox', { name: 'Learning level', exact: true })).toBeEnabled();
    if (route === '/settings') await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeEnabled();
    if (route === '/dashboard' || route === '/library') await expect(page.getByRole('heading', { name: 'A little space for your next idea.', exact: true })).toBeVisible();
    if (route === '/review') await expect(page.getByRole('heading', { name: 'A clear page for now.', exact: true })).toBeVisible();
    await audit(page, info, route.replaceAll('/', '-') || 'home');
    expect(transport.errors).toEqual([]);
  });
}

for (const tab of ['Conversation', 'Concepts', 'Cards', 'Practice']) {
  test(`lesson ${tab} surface has accessible names and contrast`, async ({ page }, info) => {
    const transport = await fixtureTransport(page);
    await openLiveLesson(page);
    await page.getByRole('tab', { name: tab, exact: true }).click();
    if (tab === 'Practice') await expect(page.getByRole('button', { name: 'Start question', exact: true })).toBeVisible();
    await audit(page, info, `lesson-${tab.toLowerCase()}`);
    expect(transport.errors).toEqual([]);
  });
}

test('mobile onboarding reflows at 390 px with default colors', async ({ page }, info) => {
  await fixtureTransport(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/new');
  await expect(page.getByRole('combobox', { name: 'Learning level', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await audit(page, info, 'mobile-onboarding');
});
