import { expect, test, type Page } from '@playwright/test';
import { fixtureTransport } from '../fixtures/browser.js';

async function sample(page: Page, topic = 'fractions') {
  await page.goto('/learn/new');
  await page.getByRole('button', { name: 'Guided sample', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Lesson language', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Lesson language', exact: true })).toHaveValue('english');
  await page.getByRole('combobox', { name: 'Sample topic', exact: true }).selectOption(topic);
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/[a-f0-9-]{36}$/);
  return page.url().split('/').at(-1)!;
}
async function practice(page: Page, id: string, assessmentId: string) {
  await page.goto(`/sessions/${id}`);
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Practice question', exact: true }).selectOption(assessmentId);
  await page.getByRole('button', { name: 'Start question', exact: true }).click();
}

test('onboarding persists preferences, saved notes and searchable lesson lifecycle', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.goto('/settings');
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Curious learner');
  await page.getByRole('textbox', { name: /^Timezone/ }).fill('Asia/Kathmandu');
  await page.getByRole('combobox', { name: 'Learning level', exact: true }).selectOption('intermediate');
  await page.getByRole('checkbox', { name: 'Reduce motion', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Higher contrast', exact: true }).check();
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByText('Your learning preferences are saved.', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  const id = await sample(page);
  await page.goto(`/sessions/${id}`);
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('textbox', { name: /^Lesson notes/ }).fill('My private reminder: fractions use equal parts.');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByText(/Your notes are saved/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Lesson notes/ })).toHaveValue('My private reminder: fractions use equal parts.');
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Lesson title', exact: true }).fill('Equal parts, clearer thinking');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search your lessons', exact: true }).fill('clearer thinking');
  await expect(page.getByRole('heading', { name: 'Equal parts, clearer thinking' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Equal parts, clearer thinking' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Lesson status', exact: true }).selectOption('archived');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('combobox', { name: 'Lesson status', exact: true }).selectOption('active');
  await expect(page.getByRole('heading', { name: 'Equal parts, clearer thinking' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/tokai-phase-5-dashboard.png', fullPage: true });
  expect(transport.errors).toEqual([]);
});

test('practice grades numeric and diagram answers, tracks assistance and preserves retry history', async ({ page }) => {
  const transport = await fixtureTransport(page), id = await sample(page);
  await practice(page, id, 'fractions-num-quarters');
  await page.getByRole('textbox', { name: 'Your numeric answer', exact: true }).fill('3/4');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  await expect(page.getByText('Independent attempt', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'That is coming together.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try this question again', exact: true }).click();
  await page.getByRole('button', { name: 'Give me a hint', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your numeric answer', exact: true }).fill('0.75');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  await expect(page.getByText('Assisted attempt', { exact: true })).toBeVisible();
  await page.getByText('Ask for the feedback to be reconsidered', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Reason for review', exact: true }).fill('Please recheck how this retry contributes to my evidence.');
  await page.getByRole('button', { name: 'Request another review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This needs another look.', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Practice question', exact: true }).selectOption('fractions-label-numbers');
  await page.getByRole('button', { name: 'Start question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Label 1', exact: true }).fill('numerator');
  await page.getByRole('textbox', { name: 'Label 2', exact: true }).fill('denominator');
  await page.getByRole('button', { name: 'Check my answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'That is coming together.', exact: true })).toBeVisible();
  expect(transport.errors).toEqual([]);
});

test('study artifacts run through jobs, exports download and shared packs omit notes by default', async ({ page, context }) => {
  const transport = await fixtureTransport(page), id = await sample(page);
  await page.goto(`/sessions/${id}`);
  const recapConsent = page.getByRole('checkbox', { name: 'Allow saved recap audio for this lesson', exact: true });
  await expect(recapConsent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Generate audio recap', exact: true })).toBeDisabled();
  await recapConsent.click();
  await expect(recapConsent).toBeChecked();
  await expect(page.getByRole('button', { name: 'Generate audio recap', exact: true })).toBeEnabled();
  await page.reload(); await expect(recapConsent).toBeChecked();
  await recapConsent.click();
  await expect(page.getByText('Saved recap audio is disabled for this lesson. Existing saved recap audio has been removed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate audio recap', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('textbox', { name: /^Lesson notes/ }).fill('Private thought: I want more examples before the exam.');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByText(/Your notes are saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Study pack', exact: true }).click();
  await page.getByRole('button', { name: 'Generate study pack', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your lesson, gathered.', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: 'Prepare download', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download markdown', exact: true }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Include my private lesson notes', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Create read-only link', exact: true }).click();
  const url = await page.getByRole('textbox', { name: 'Your share link', exact: true }).inputValue();
  const shared = await context.newPage(); await fixtureTransport(shared); await shared.goto(url);
  await expect(shared.getByRole('heading', { name: 'Your lesson, gathered.', exact: true })).toBeVisible();
  await expect(shared.getByText('Private thought: I want more examples before the exam.', { exact: true })).toHaveCount(0);
  await expect(shared.getByRole('button', { name: 'Save notes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await expect(page.getByText('Shared link revoked.', { exact: true })).toBeVisible();
  await shared.reload(); await expect(shared.getByRole('main').getByRole('alert')).toContainText(/expired|revoked|unavailable|not found/i);
  await shared.close(); expect(transport.errors).toEqual([]);
});

test('card edits preserve cloze fields and reviews save one rating before advancing', async ({ page }) => {
  const transport = await fixtureTransport(page), id = await sample(page);
  await page.goto(`/sessions/${id}`); await page.getByRole('button', { name: 'Review cards', exact: true }).click();
  const cloze = page.getByRole('article').filter({ has: page.getByText('cloze · active', { exact: true }) }).first();
  await cloze.getByRole('button', { name: 'Edit card', exact: true }).click();
  await cloze.getByRole('textbox', { name: 'Missing answer', exact: true }).fill('equal');
  await cloze.getByRole('textbox', { name: 'Text before the blank', exact: true }).fill('A whole is divided into ');
  await cloze.getByRole('textbox', { name: 'Text after the blank', exact: true }).fill(' parts.');
  await cloze.getByRole('button', { name: 'Save card', exact: true }).click();
  await expect(cloze.getByRole('button', { name: 'Edit card', exact: true })).toBeVisible();
  await page.goto('/review');
  await expect(page.getByRole('region', { name: 'Current review card', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your recall answer', exact: true }).fill('I am trying to recall this in my own words.');
  await page.getByRole('button', { name: 'Check my recall', exact: true }).click();
  await expect(page.getByText('Compare your answer', { exact: true })).toBeVisible();
  const receipt = page.waitForResponse(response => /\/v1\/reviews\/[^/]+\/attempts$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Good I recalled the idea$/ }).click();
  expect((await receipt).status()).toBe(200);
  await expect(page.getByText(/Review saved/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your recall answer', exact: true })).toHaveValue('');
  expect(transport.errors).toEqual([]);
});

test('mobile product navigation and device denial keep a usable text route', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied for testing', 'NotAllowedError'); } }); });
  await page.goto('/learn/new');
  await page.getByRole('button', { name: 'Check microphone', exact: true }).click();
  await expect(page.getByText(/Microphone permission was denied/)).toBeVisible();
  await page.getByRole('button', { name: 'Guided sample', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start my lesson', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/tokai-phase-5-mobile-onboarding.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Mobile learning space', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make this space yours.', exact: true })).toBeVisible();
  expect(transport.errors).toEqual([]);
});

test('dictation stops its tracks before transcription and cancellation preserves typed work', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { __dictationTracks: MediaStreamTrack[] }; testWindow.__dictationTracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), target = context.createMediaStreamDestination();
      oscillator.frequency.value = 220; oscillator.connect(target); oscillator.start(); await context.resume();
      for (const track of target.stream.getTracks()) { testWindow.__dictationTracks.push(track); const stop = track.stop.bind(track); let stopped = false; track.stop = () => { if (stopped) return; stopped = true; stop(); oscillator.stop(); void context.close(); }; }
      return target.stream;
    };
  });
  const id = await sample(page); await practice(page, id, 'fractions-short-denominator');
  let submissions = 0; page.on('request', request => { if (request.url().endsWith('/v1/dictation')) submissions++; });
  await page.getByRole('button', { name: 'Dictate answer', exact: true }).click();
  await expect(page.getByRole('button', { name: /Stop and transcribe · 1s/ })).toBeVisible();
  await page.getByRole('button', { name: /Stop and transcribe/ }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __dictationTracks: MediaStreamTrack[] }).__dictationTracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Your explanation', exact: true })).toHaveValue('The denominator tells us the whole is divided into four equal parts.');
  expect(submissions).toBe(1);
  await page.getByRole('textbox', { name: 'Your explanation', exact: true }).fill('Keep this typed explanation.');
  await page.getByRole('button', { name: 'Dictate answer', exact: true }).click();
  await expect(page.getByRole('button', { name: /Stop and transcribe/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your explanation', exact: true })).toHaveValue('Keep this typed explanation.');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __dictationTracks: MediaStreamTrack[] }).__dictationTracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(submissions).toBe(1); expect(transport.errors).toEqual([]);
});

test('notes conflicts retain the draft until the learner chooses the saved version', async ({ page, context }) => {
  const transport = await fixtureTransport(page), id = await sample(page);
  await page.goto(`/sessions/${id}`); await page.getByRole('button', { name: 'My notes', exact: true }).click();
  await page.getByRole('textbox', { name: /^Lesson notes/ }).fill('My unsaved local draft.');
  const other = await context.newPage(); await fixtureTransport(other); await other.goto(`/sessions/${id}`);
  await other.getByRole('button', { name: 'My notes', exact: true }).click();
  await other.getByRole('textbox', { name: /^Lesson notes/ }).fill('Notes saved in another tab.');
  await other.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(other.getByText(/Your notes are saved/)).toBeVisible(); await other.close(); await page.bringToFront();
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(/changed|reload/i);
  await expect(page.getByRole('textbox', { name: /^Lesson notes/ })).toHaveValue('My unsaved local draft.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Lesson notes/ })).toHaveValue('Notes saved in another tab.');
  expect(transport.errors).toEqual([]);
});

test('a custom live topic carries the selected goal, language and pace into a real lesson route', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.goto('/learn/new');
  await page.getByRole('textbox', { name: 'Topic or question', exact: true }).fill('Why do shadows change?');
  await page.getByRole('textbox', { name: 'Your learning goal', exact: true }).fill('Explain shadow length with a lamp and a pencil.');
  await page.getByRole('combobox', { name: 'Lesson language', exact: true }).selectOption('spanish');
  await page.getByRole('spinbutton', { name: 'Lesson length (minutes)', exact: true }).fill('20');
  await page.getByRole('combobox', { name: 'Learning level', exact: true }).selectOption('intermediate');
  const created = page.waitForResponse(response => response.url().endsWith('/v1/lessons') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start my lesson', exact: true }).click();
  const response = await created; expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(payload.session.settings).toMatchObject({ goal: 'Explain shadow length with a lamp and a pencil.', grounding: 'general', preferences: { language: 'spanish', level: 'intermediate', lessonMinutes: 20 } });
  expect(payload.session.plan).toMatchObject({ status: 'ready', provenance: 'generated', minutes: 20 });
  await expect(page).toHaveURL(/\/learn\/[a-f0-9-]{36}$/);
  await expect(page.locator('.message-tutor')).toContainText('Fixture tutor response');
  await page.getByRole('textbox', { name: /question/i }).fill('Can you use the pencil example?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-tutor').last()).toContainText('Can you use the pencil example?');
  expect(transport.errors).toEqual([]);
});
