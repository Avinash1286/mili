import { expect, test } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';
import { audit } from './audit.js';

test('study tabs have one tab stop and keyboard navigation exposes the named panel', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  const tabs = page.getByRole('tablist', { name: 'Study tools', exact: true });
  await tabs.getByRole('tab', { name: 'Conversation', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  const concepts = tabs.getByRole('tab', { name: 'Concepts', exact: true });
  await expect(concepts).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(concepts).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Concepts', exact: true })).toBeVisible();
  expect(await tabs.getByRole('tab').evaluateAll(elements => elements.filter(element => (element as HTMLElement).tabIndex === 0).length)).toBe(1);
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Practice', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'Conversation', exact: true })).toBeFocused();
  expect(transport.errors).toEqual([]);
});

test('drawing-share dialog traps focus, closes with Escape and restores its trigger', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await page.locator('.board-node').first().click();
  const trigger = page.getByRole('button', { name: 'Preview drawing to share', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Share just this drawing.', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Your question', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Your question', exact: true }).fill('Explain this selected idea.');
  await dialog.getByRole('button', { name: 'Share drawing with tutor', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel drawing share', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Share drawing with tutor', exact: true })).toBeFocused();
  await audit(page, info, 'drawing-share-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(transport.errors).toEqual([]);
});

test('saved materials recover from a failed initial read without a browser reload', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.goto('/learn/new');
  await page.getByRole('button', { name: 'Guided sample', exact: true }).click();
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/[a-f0-9-]{36}$/);
  await expect(page.getByRole('progressbar', { name: 'Lesson progress', exact: true })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  let unavailable = true;
  await page.route(`http://localhost:4000/v1/sessions/${id}/learning`, async route => {
    if (unavailable) { await route.fulfill({ status: 503, json: { message: 'Saved materials are temporarily unavailable.' } }); return; }
    await route.fallback();
  });
  await page.goto(`/sessions/${id}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Saved materials are temporarily unavailable.');
  await expect(page.getByText('Opening your lesson materials…', { exact: true })).not.toBeVisible();
  unavailable = false;
  await page.getByRole('button', { name: 'Retry lesson materials', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate study pack', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Lesson notes/ })).toBeEditable();
  expect(transport.errors).toEqual([]);
});
