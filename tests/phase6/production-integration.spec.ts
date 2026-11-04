import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ trace: 'off' });
test('production CSP permits native guest claim and private source transfers', async ({ page }, info) => {
  test.skip(process.env.TOKAI_E2E_PRODUCTION !== '1' || process.env.TOKAI_E2E_NATIVE !== '1', 'Explicit local production/native integration opt-in is required.');
  test.setTimeout(150000); // One real CPU source-ingestion job; no paid provider request.
  await page.addInitScript(() => {
    const failures: { directive: string; origin: string; source?: string; line?: number }[] = [];
    Object.assign(window, { __tokaiCspFailures: failures });
    document.addEventListener('securitypolicyviolation', event => {
      let origin = event.blockedURI;
      try { origin = new URL(event.blockedURI).origin; } catch { /* inline/eval sentinel */ }
      let source: string | undefined;
      try { const url = new URL(event.sourceFile); source = url.origin + url.pathname; } catch { source = event.sourceFile ? 'non-url script' : undefined; }
      failures.push({ directive: event.effectiveDirective, origin, source, line: event.lineNumber });
    });
  });
  const violations: { directive: string; origin: string }[] = [], uploads: string[] = [], downloads: string[] = [];
  const transferStatuses: { method: string; path: string; status: number }[] = [], sourceStates = new Set<string>();
  async function capturePolicyFailures() { violations.push(...await page.evaluate(() => (window as typeof window & { __tokaiCspFailures: { directive: string; origin: string }[] }).__tokaiCspFailures.splice(0))); }
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'PUT' && !['http://localhost:3000', 'http://localhost:4000'].includes(url.origin)) uploads.push(url.origin);
    if (request.method() === 'GET' && url.pathname === '/private-transfer' && !['http://localhost:3000', 'http://localhost:4000'].includes(url.origin)) downloads.push(url.origin);
  });
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.pathname === '/private-transfer' || url.pathname.startsWith('/v1/sources')) {
      if (transferStatuses.length < 100) transferStatuses.push({ method: response.request().method(), path: url.pathname.replace(/\/[a-f0-9-]{36}(?=\/|$)/g, '/:id'), status: response.status() });
      if (response.ok() && url.pathname === '/v1/sources') {
        try { const data = await response.json(); for (const source of data.sources ?? []) if (typeof source.status === 'string') sourceStates.add(source.status); } catch { /* Diagnostic capture must not affect the application flow. */ }
      }
    }
  });
  const suffix = randomUUID(), email = `tokai-csp-${suffix}@example.invalid`, password = `Test-only-${randomUUID()}-Aa7!`;
  let createdAccount = false;
  try {
    const response = await page.goto('/learn/new');
    const csp = response?.headers()['content-security-policy'] || '';
    expect(csp).toContain("default-src 'self'"); expect(csp).toContain("object-src 'none'"); expect(csp).not.toContain("'unsafe-eval'");
    await page.getByRole('button', { name: 'Guided sample', exact: true }).click();
    await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Let’s see the bigger picture.', exact: true })).toBeVisible();
    const lessonId = page.url().split('/').at(-1)!;
    await capturePolicyFailures(); await page.goto('/sign-in');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('CSP integration test');
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(email);
    await page.getByLabel(/^Password/).fill(password);
    const bridge = page.waitForResponse(response => response.url().endsWith('/auth/native-session') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create my account', exact: true }).click();
    expect((await bridge).status()).toBe(200); createdAccount = true;
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator(`a[href="/sessions/${lessonId}"]`).first()).toBeVisible();
    await capturePolicyFailures(); await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in and keep my learning', exact: true })).toBeVisible();
    await capturePolicyFailures(); await page.goto('/sign-in');
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(email);
    await page.getByLabel(/^Password/).fill(password);
    await page.getByRole('button', { name: 'Sign in to my account', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator(`a[href="/sessions/${lessonId}"]`).first()).toBeVisible();
    await capturePolicyFailures(); await page.goto('/library');
    const filename = `csp-${suffix}.txt`, body = 'A fraction describes equal parts of a whole. Three quarters means three of four equal parts. The numerator counts selected parts. The denominator describes the equal subdivision.';
    await page.getByLabel('Upload lesson source', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(body) });
    const downloadButton = page.getByRole('button', { name: `Download ${filename}`, exact: true });
    await expect.poll(async () => {
      if (await page.locator('main [role="alert"]').count()) throw new Error('The library reported a source upload error; see safe transfer diagnostics.');
      return downloadButton.count();
    }, { timeout: 90000 }).toBe(1);
    const downloadEvent = page.waitForEvent('download'); await downloadButton.click();
    const download = await downloadEvent, path = await download.path();
    expect(path).toBeTruthy(); expect(await readFile(path!, 'utf8')).toBe(body);
    await capturePolicyFailures();
    expect(uploads.length).toBeGreaterThan(0); expect(downloads.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
    await info.attach('production-csp-summary', { body: JSON.stringify({ enforcingCsp: true, nativeGuestClaim: true, directUploadOrigins: [...new Set(uploads)], directDownloadOrigins: [...new Set(downloads)], cspViolations: violations }, null, 2), contentType: 'application/json' });
  } catch (error) {
    await capturePolicyFailures().catch(() => undefined);
    await info.attach('production-transfer-diagnostics', { body: JSON.stringify({ cspViolations: violations, directUploadOrigins: [...new Set(uploads)], directDownloadOrigins: [...new Set(downloads)], transferStatuses, sourceStates: [...sourceStates] }, null, 2), contentType: 'application/json' });
    if (new URL(page.url()).pathname === '/library') await info.attach('library-before-cleanup', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    throw error;
  } finally {
    if (createdAccount) {
      await page.goto('/settings');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Delete my learning data', exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
    }
  }
});
