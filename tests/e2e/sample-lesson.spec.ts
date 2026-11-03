import { test, expect } from '@playwright/test';

test('guest can learn, edit and save the board, review cards and finish a sample', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Make room for/ })).toBeVisible();
  const start = page.getByRole('button', { name: /Explore photosynthesis/ });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page).toHaveURL(/\/learn\//);
  await expect(page.getByText('SAMPLE LESSON', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Editable concept board')).toBeVisible();

  const node = page.locator('.board-node').first();
  await node.click();
  await page.getByRole('button', { name: /^Edit / }).click();
  await page.getByLabel('Your note').fill('My saved observation from the test lesson.');
  await page.getByRole('button', { name: 'Apply edit' }).click();
  await page.getByRole('button', { name: 'Save board' }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.board-node').first()).toContainText('My saved observation');

  await page.getByRole('textbox', { name: /question/i }).fill('What does sunlight do?');
  await page.getByRole('button', { name: /Send/i }).click();
  await expect(page.locator('.message-student').last()).toContainText('What does sunlight do?');
  await expect(page.locator('.message-tutor')).toHaveCount(2);
  await page.screenshot({ path: '.logs/tokai-workspace.png', fullPage: true });
  await page.getByRole('tab', { name: 'Cards', exact: true }).click();
  const card = page.locator('.flashcard').first();
  await expect(card).toContainText('Reveal answer');
  await card.click();
  await expect(card).toContainText('THE ANSWER');
  await page.getByRole('button', { name: 'Finish lesson' }).click();
  await expect(page.getByRole('heading', { name: 'Your lesson, collected.' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download notes' }).click();
  expect((await download).suggestedFilename()).toBe('tokai-photosynthesis-notes.md');
  await page.getByRole('link', { name: 'My learning space' }).click();
  await expect(page.locator('.saved-session')).toHaveCount(1);
  await expect(page.locator('.saved-session')).toContainText('Completed');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /^Delete / }).click();
  await expect(page.getByRole('heading', { name: 'Your first page is waiting.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile sample remains usable with study and board tabs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Explore photosynthesis/ })).toBeEnabled();
  await page.getByRole('button', { name: /Explore photosynthesis/ }).click();
  await expect(page.getByLabel('Editable concept board')).toBeVisible();
  await page.getByRole('button', { name: 'Study tools', exact: true }).click();
  await expect(page.getByText('SAMPLE LESSON', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /question/i }).fill('Explain this idea.');
  await page.getByRole('button', { name: /Send/i }).click();
  await expect(page.locator('.message-tutor')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.logs/tokai-mobile.png', fullPage: true });
});
