import { test, expect } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

test('voice output uses the shared typed conversation and can be interrupted, then reconnected', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => transport.events.filter(event => event.type === 'session.ready').length).toBe(1);
  await page.getByRole('textbox', { name: /question/i }).fill('Explain sunlight in one sentence');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'playback.ack' && event.status === 'started')).toBe(true);
  await page.getByRole('button', { name: 'Stop tutor', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'audio.cancel')).toBe(true);
  await expect(page.locator('.message-student')).toHaveCount(1);
  await expect(page.locator('.message-tutor')).toHaveCount(2);
  await expect.poll(() => transport.events.filter(event => event.type === 'session.snapshot').some(event => JSON.stringify(event).includes('interrupted'))).toBe(true);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => transport.events.filter(event => event.type === 'session.ready').length).toBe(2);
  await expect(page.locator('.message-student')).toHaveCount(1);
  const priorAudioStarts = transport.events.filter(event => event.type === 'audio.start').length;
  await page.getByRole('textbox', { name: /question/i }).fill('What happens next?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-student')).toHaveCount(2);
  await expect.poll(() => transport.events.filter(event => event.type === 'audio.start').length).toBe(priorAudioStarts + 1);
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'playback.ack' && event.status === 'completed')).toBe(true);
  await page.screenshot({ path: '.logs/tokai-phase-2-voice.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  expect(transport.errors).toEqual([]);
});

test('microphone worklet sends PCM and duplicate final transcripts create one tutor reply', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Study tools', exact: true }).click();
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'session.ready')).toBe(true);
  const hold = page.getByRole('button', { name: 'Hold to talk', exact: true });
  await hold.focus(); await page.keyboard.down('Space');
  await expect.poll(() => transport.events.some(event => event.type === 'transcript.partial')).toBe(true);
  await page.keyboard.up('Space');
  await expect(page.locator('.message-student')).toHaveCount(1);
  await expect(page.locator('.message-student').first()).toContainText('How does sunlight help plants?');
  await expect(page.locator('.message-tutor')).toHaveCount(2);
  await expect.poll(() => transport.events.filter(event => event.type === 'transcript.final').length).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.logs/tokai-phase-2-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  expect(transport.errors).toEqual([]);
});

test('microphone denial keeps typed input and streaming voice output usable', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Start voice', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'session.ready')).toBe(true);
  await expect(page.getByText(/Microphone permission was denied/)).toBeVisible();
  await page.getByRole('textbox', { name: /question/i }).fill('Can I still learn by typing?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-student')).toHaveCount(1);
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'playback.ack' && event.status === 'completed')).toBe(true);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  expect(transport.errors).toEqual([]);
});
