import { expect, test } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';

test('voice availability distinguishes a failed check from missing configuration and can recover', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  let checks = 0, stage: 'failure' | 'unconfigured' | 'configured' = 'failure', releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('http://localhost:4000/health/live', async route => {
    checks++;
    await first;
    if (stage === 'failure') { await route.fulfill({ status: 503, json: { message: 'Readiness temporarily unavailable.' } }); return; }
    if (stage === 'unconfigured') {
      const response = await route.fetch({ url: 'http://localhost:4100/health/live' });
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, providers: { ...data.providers, voice: false } } });
      return;
    }
    await route.fallback();
  });
  await page.reload();
  const voice = page.getByRole('region', { name: 'Voice conversation', exact: true });
  await expect(voice).toContainText('Checking voice availability');
  await expect(voice.getByRole('button', { name: 'Start voice', exact: true })).toBeDisabled();
  releaseFirst();
  await expect(voice).toContainText('We couldn’t check voice availability.');
  // Development StrictMode may start one abandoned mount read before its cleanup.
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(checks).toBeLessThanOrEqual(3);
  const failedChecks = checks;
  await expect(voice).not.toContainText('Voice needs');
  await expect(page.getByRole('textbox', { name: 'Ask your tutor a question', exact: true })).toBeEditable();
  stage = 'unconfigured';
  await voice.getByRole('button', { name: 'Retry voice availability', exact: true }).click();
  await expect(voice).toContainText('Voice needs the tutor and AssemblyAI keys');
  expect(checks).toBe(failedChecks + 1); // A valid unavailable response must not automatically retry.
  await expect(voice.getByRole('button', { name: 'Start voice', exact: true })).toBeDisabled();
  stage = 'configured';
  await voice.getByRole('button', { name: 'Retry voice availability', exact: true }).click();
  await expect(voice.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
  expect(checks).toBe(failedChecks + 2);
  await voice.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'session.ready')).toBe(true);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.unrouteAll({ behavior: 'wait' });
  expect(transport.errors).toEqual([]);
});

test('late saved preferences fill untouched defaults without overwriting onboarding edits', async ({ page }) => {
  const transport = await fixtureTransport(page);
  let releasePreferences!: () => void;
  const preferencesReady = new Promise<void>(resolve => { releasePreferences = resolve; });
  await page.route('http://localhost:4000/v1/me', async route => {
    await preferencesReady;
    const response = await route.fetch({ url: 'http://localhost:4100/v1/me' });
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, preferences: { ...data.preferences, goal: 'An older saved goal.', level: 'advanced', language: 'french', lessonMinutes: 30, retainTranscript: true, retainRecapAudio: false } } });
  });
  await page.goto('/learn/new');
  await page.getByRole('textbox', { name: 'Topic or question', exact: true }).fill('Why do shadows change?');
  const goal = page.getByRole('textbox', { name: 'Your learning goal', exact: true });
  await goal.fill('Explain shadow length with a lamp and a pencil.');
  await page.getByRole('checkbox', { name: 'Keep this lesson’s transcript for later study', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Allow saved recap audio when I request it', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Start my lesson', exact: true })).toBeDisabled();
  releasePreferences();
  await expect(page.getByRole('combobox', { name: 'Learning level', exact: true })).toHaveValue('advanced');
  await expect(page.getByRole('combobox', { name: 'Lesson language', exact: true })).toHaveValue('french');
  await expect(goal).toHaveValue('Explain shadow length with a lamp and a pencil.');
  await expect(page.getByRole('checkbox', { name: 'Keep this lesson’s transcript for later study', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Allow saved recap audio when I request it', exact: true })).toBeChecked();
  await page.getByRole('combobox', { name: 'Lesson language', exact: true }).selectOption('spanish');
  const created = page.waitForResponse(response => response.url().endsWith('/v1/lessons') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(payload.session.settings).toMatchObject({ goal: 'Explain shadow length with a lamp and a pencil.', preferences: { language: 'spanish', level: 'advanced', lessonMinutes: 30, retainTranscript: false, retainRecapAudio: true } });
  await expect(page).toHaveURL(/\/learn\/[a-f0-9-]{36}$/);
  await expect(page.getByRole('progressbar', { name: 'Lesson progress', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
  expect(transport.errors).toEqual([]);
});
