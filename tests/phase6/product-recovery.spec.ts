import { expect, test } from '@playwright/test';
import type { Session } from '../../packages/contracts/src/index.js';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';
import { PRACTICE_REQUEST, PRACTICE_CORRECT_LABELS } from '../fixtures/practice.js';
import { audit } from './audit.js';

test('tutor practice reuses its saved presentation and keeps hints after reload', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  let createdPresentations = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/sessions\/[^/]+\/assessments$/.test(request.url())) createdPresentations++; });
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'session.ready')).toBe(true);
  await page.getByRole('textbox', { name: 'Ask your tutor a question', exact: true }).fill(PRACTICE_REQUEST);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await page.getByRole('button', { name: 'Answer tutor question', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect voice', exact: true })).toHaveCount(0);
  const state = transport.events.map(event => event.session as Session | undefined).find(session => !!session?.practice)?.practice;
  expect(state).toBeDefined();
  await page.getByRole('button', { name: 'Give me a hint', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Answer tutor question', exact: true }).click();
  await expect(page.getByText('This tutor question keeps its previously recorded hints and revealed-answer history.', { exact: true })).toBeVisible();
  for (const label of PRACTICE_CORRECT_LABELS) await page.getByRole('checkbox', { name: label, exact: true }).check();
  const attempt = page.waitForRequest(request => request.method() === 'POST' && /\/sessions\/[^/]+\/attempts$/.test(request.url()));
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  expect((await attempt).postDataJSON().presentationId).toBe(state!.presentation.id);
  await expect(page.getByText('Assisted attempt', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'That is coming together.', exact: true })).toBeVisible();
  expect(createdPresentations).toBe(0);
  await audit(page, info, 'tutor-practice-result');
  expect(transport.errors).toEqual([]);
});

test('retrying a lost HTTP response uses the same turn identity and changed input uses a new one', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  const requests: { requestId: string; text: string }[] = [];
  await page.route('http://localhost:4000/v1/sessions/*/messages', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const url = new URL(route.request().url()); url.port = '4100';
      const response = await route.fetch({ url: url.toString() }); expect(response.ok()).toBe(true);
      await route.abort('failed'); return;
    }
    await route.fallback();
  });
  const question = page.getByRole('textbox', { name: 'Ask your tutor a question', exact: true });
  await question.fill('Explain sunlight once.');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.workspace-error[role="alert"]')).toBeVisible();
  await expect(question).toHaveValue('Explain sunlight once.');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-student')).toHaveCount(1);
  expect(requests[0]!.requestId).toBeTruthy(); expect(requests[1]!.requestId).toBe(requests[0]!.requestId);
  await question.fill('Now explain water.');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-student')).toHaveCount(2);
  expect(requests[2]!.requestId).not.toBe(requests[1]!.requestId);
  await audit(page, info, 'http-turn-delivery');
  expect(transport.errors).toEqual([]);
});

test('usage errors do not block preferences and can be retried without fabricated prices', async ({ page }, info) => {
  const transport = await fixtureTransport(page); let unavailable = true;
  await page.route('http://localhost:4000/v1/me/usage', async route => unavailable ? route.fulfill({ status: 503, json: { message: 'Allowance unavailable.' } }) : route.fallback());
  await page.goto('/settings');
  await page.getByText('Usage and limits', { exact: true }).click();
  await expect(page.getByText('We couldn’t refresh your allowance. Your preferences and saved learning remain available.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save preferences', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('A learner who can keep editing');
  unavailable = false; await page.getByRole('button', { name: 'Refresh allowance', exact: true }).click();
  await expect(page.getByText('A provider price estimate is not configured.', { exact: true })).toBeVisible();
  await audit(page, info, 'settings-allowance');
  expect(transport.errors).toEqual([]);
});

test('native account forms expose required labels and the configured capability limits', async ({ page }, info) => {
  const transport = await fixtureTransport(page);
  // Only expose the form for an accessibility/constraint audit. Do not register
  // an account or replace the real production authentication implementation.
  await page.route('http://localhost:4000/auth/config', route => route.fulfill({ json: { native: true, oidc: false, passwordRecovery: false, emailVerification: false } }));
  await page.goto('/sign-in');
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('A learner');
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('learner@example.test');
  const password = page.getByLabel(/^Password/);
  await password.fill('short');
  expect(await password.evaluate(element => (element as HTMLInputElement).minLength)).toBe(12);
  await expect(page.getByText('Email addresses on these accounts are unverified.', { exact: true })).toBeVisible();
  await audit(page, info, 'native-account-form');
  expect(transport.errors).toEqual([]);
});
