import { expect, test } from '@playwright/test';
import { fixtureTransport } from '../fixtures/browser.js';
import { audit, sampleLesson } from './audit.js';

test('a file expiry disables its download while indexed source text remains selectable', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  const source = { id: 'expiry-source-fixture', title: 'Expiry reference fixture', filename: 'reference.txt', mimeType: 'text/plain', bytes: 1024, checksum: 'a'.repeat(64), revision: 1, status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pages: 1, chunks: 1, fileExpiresAt: new Date(Date.now() + 6000).toISOString() };
  // Only the expiry metadata is a controlled UI fixture; no clock or production
  // storage policy is changed. Native expiry rejection has separate integration coverage.
  await page.route('http://localhost:4000/v1/sources', route => route.fulfill({ json: { sources: [source] } }));
  await page.goto('/learn/new');
  const download = page.getByRole('button', { name: 'Download Expiry reference fixture', exact: true });
  await expect(download).toBeEnabled();
  await expect(download).toBeDisabled({ timeout: 12000 });
  await expect(page.getByText('The original file expired. Indexed text remains available for teaching until its retention period ends or you delete this source.', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Expiry reference fixture', exact: true })).toBeEnabled();
  await audit(page, info, 'expired-private-source');
  expect(transport.errors).toEqual([]);
});

test('a recap reaching its file deadline removes playback without another fetch', async ({ page }, info) => {
  const transport = await fixtureTransport(page), id = await sampleLesson(page);
  let deadline: string | undefined, reads = 0;
  await page.route(`http://localhost:4000/v1/sessions/${id}/learning`, async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    const response = await route.fetch({ url: url.toString() }), body = await response.json(); reads++;
    for (const artifact of body.artifacts) if (artifact.kind === 'recap' && artifact.status === 'ready') { deadline ??= new Date(Date.now() + 7000).toISOString(); artifact.fileExpiresAt = deadline; }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/sessions/${id}`);
  const consent = page.getByRole('checkbox', { name: 'Allow saved recap audio for this lesson', exact: true });
  await consent.click(); await expect(consent).toBeChecked();
  await page.getByRole('button', { name: 'Generate audio recap', exact: true }).click();
  await page.getByRole('button', { name: 'Load audio recap', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(1);
  const afterLoad = reads;
  await expect(page.locator('audio')).toHaveCount(0, { timeout: 12000 });
  expect(reads).toBe(afterLoad);
  await expect(page.getByRole('button', { name: 'Download wav', exact: true })).toBeDisabled();
  await expect(page.getByText('Saved file expired. Generate a new copy with the controls above.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate audio recap', exact: true })).toBeEnabled();
  await audit(page, info, 'expired-recap');
  expect(transport.errors).toEqual([]);
});

test('the allowance distinguishes file bytes and conservative dollar reservations from invoices', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  await page.route('http://localhost:4000/v1/me/usage', async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    const response = await route.fetch({ url: url.toString() }), body = await response.json();
    // Explicit synthetic accounting values exercise labels without changing real budgets.
    body.storage = { bytes: 3 * 1024 * 1024, objects: 2 };
    body.budget = { enabled: true, basis: 'conservative-reservations', ownerLimitUsd: 1, globalLimitUsd: 5, ownerUsedUsd: 0.25, globalUsedUsd: 1, ownerRemainingUsd: 0.75, globalRemainingUsd: 4 };
    for (const item of body.kinds) if (['storage', 'egress'].includes(item.kind)) { item.used = 1048576; item.remaining = item.limit - item.used; }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/settings');
  await page.getByText('Usage and limits', { exact: true }).click();
  await expect(page.getByText(/Current private files: 3 MiB across 2 files/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily spending reservation', exact: true })).toBeVisible();
  await expect(page.getByText('$0.75 remaining for this learner.', { exact: true })).toBeVisible();
  await expect(page.getByText('$4.00 remaining in the shared workspace budget.', { exact: true })).toBeVisible();
  await expect(page.getByText(/They are spending controls, not an invoice/)).toBeVisible();
  expect(await page.getByRole('progressbar').count()).toBe(6);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await audit(page, info, 'priced-file-allowance');
  expect(transport.errors).toEqual([]);
});
