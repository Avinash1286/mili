import { expect, test } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';
import { audit, sampleLesson } from './audit.js';

test('320 px onboarding keeps larger text and controls inside the page', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('large');
  await page.getByRole('checkbox', { name: 'Reduce motion', exact: true }).check();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Your learning preferences are saved.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/learn/new');
  await expect(page.getByRole('combobox', { name: 'Learning level', exact: true })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', 'large');
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('textbox', { name: 'Topic or question', exact: true }).fill('How do rainbows form?');
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).scrollIntoViewIfNeeded();
  const bounds = await page.getByRole('button', { name: 'Start my lesson', exact: true }).boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await audit(page, info, '320-large-onboarding');
  expect(transport.errors).toEqual([]);
});

test('320 px workspace keeps larger-text study tabs and practice controls reachable', async ({ page }, info) => {
  await fixtureTransport(page);
  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Text size', exact: true }).selectOption('large');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Your learning preferences are saved.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await sampleLesson(page);
  await page.getByRole('button', { name: 'Study tools', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-font-scale', 'large');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const tab of ['Conversation', 'Concepts', 'Practice']) {
    const control = page.getByRole('tab', { name: tab, exact: true });
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await control.click();
    await expect(control).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByRole('button', { name: 'Start question', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Practice question', exact: true }).selectOption('fractions-num-quarters');
  await page.getByRole('button', { name: 'Start question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your numeric answer', exact: true }).fill('3/4');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'That is coming together.', exact: true })).toBeVisible();
  await audit(page, info, '320-large-workspace-practice');
});

test('saved pack, notes and active practice retain accessible controls', async ({ page }, info) => {
  const transport = await fixtureTransport(page), id = await sampleLesson(page);
  await page.goto(`/sessions/${id}`);
  await page.getByRole('button', { name: 'Generate study pack', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your lesson, gathered.', exact: true })).toBeVisible();
  await audit(page, info, 'saved-study-pack');
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('textbox', { name: /^Lesson notes/ }).fill('A note I can save using a keyboard.');
  await audit(page, info, 'saved-notes');
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Practice question', exact: true }).selectOption('fractions-num-quarters');
  await page.getByRole('button', { name: 'Start question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your numeric answer', exact: true }).fill('3/4');
  await audit(page, info, 'active-practice');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'That is coming together.', exact: true })).toBeVisible();
  await audit(page, info, 'practice-feedback');
  expect(transport.errors).toEqual([]);
});

test('card editing and review answer states expose labels and ratings', async ({ page }, info) => {
  const transport = await fixtureTransport(page), id = await sampleLesson(page);
  await page.goto(`/sessions/${id}`);
  await page.getByRole('button', { name: 'Review cards', exact: true }).click();
  const card = page.getByRole('article').filter({ has: page.getByText('cloze · active', { exact: true }) }).first();
  await card.getByRole('button', { name: 'Edit card', exact: true }).click();
  await audit(page, info, 'card-editor');
  await page.goto('/review');
  await expect(page.getByRole('textbox', { name: 'Your recall answer', exact: true })).toBeVisible();
  await audit(page, info, 'review-question');
  await page.getByRole('button', { name: 'I don’t know yet', exact: true }).click();
  await expect(page.getByText('Compare your answer', { exact: true })).toBeVisible();
  await audit(page, info, 'review-ratings');
  expect(transport.errors).toEqual([]);
});

test('shared pack and its creation controls remain accessible', async ({ page, context }, info) => {
  const transport = await fixtureTransport(page), id = await sampleLesson(page);
  await page.goto(`/sessions/${id}`);
  await page.getByRole('button', { name: 'Generate study pack', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your lesson, gathered.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Create read-only link', exact: true }).click();
  const link = page.getByRole('textbox', { name: 'Your share link', exact: true });
  await expect(link).toBeVisible(); await audit(page, info, 'share-controls');
  const shared = await context.newPage(); await fixtureTransport(shared); await shared.goto(await link.inputValue());
  await expect(shared.getByRole('heading', { name: 'Your lesson, gathered.', exact: true })).toBeVisible();
  await audit(shared, info, 'public-study-pack');
  await shared.close(); expect(transport.errors).toEqual([]);
});

test('camera-free spatial diagram exposes its interactive parts', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await page.getByRole('button', { name: '3D models', exact: true }).click();
  await page.getByRole('button', { name: 'Use 2D diagram', exact: true }).click();
  await expect(page.getByText('2D diagram ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Thylakoid membrane in diagram', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Select Thylakoid membrane in diagram', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await audit(page, info, 'spatial-fallback');
  expect(transport.errors).toEqual([]);
});

test('saved recap exposes captions and working playback speed controls', async ({ page }, info) => {
  const transport = await fixtureTransport(page), id = await sampleLesson(page);
  await page.goto(`/sessions/${id}`);
  const consent = page.getByRole('checkbox', { name: 'Allow saved recap audio for this lesson', exact: true });
  await consent.click(); await expect(consent).toBeChecked();
  await page.getByRole('button', { name: 'Generate audio recap', exact: true }).click();
  await page.getByRole('button', { name: 'Load audio recap', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Recap captions', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Recap playback speed', exact: true }).selectOption('1.5');
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => ({ ready: audio.readyState >= 2, speed: audio.playbackRate }))).toEqual({ ready: true, speed: 1.5 });
  await audit(page, info, 'saved-recap-player');
  expect(transport.errors).toEqual([]);
});
