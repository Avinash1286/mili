import { test, expect, type Page } from '@playwright/test';
import WebSocket from 'ws';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

type Event = { type: string; outputEpoch?: number; state?: string; [key: string]: unknown };
async function fixtureTransport(page: Page) {
  const events: Event[] = [], clientEvents: Event[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Bridge browser transport to the real API with injected provider fixtures.
  // Browser controls, contracts, audio worklets, tickets and server orchestration are unchanged.
  await page.route('http://localhost:4000/**', async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  await page.routeWebSocket('ws://localhost:4000/v1/voice?*', client => {
    const url = new URL(client.url()); url.port = '4100';
    const server = new WebSocket(url, { origin: 'http://localhost:3000', perMessageDeflate: false });
    const pending: (string | Buffer)[] = [];
    client.onMessage(message => {
      if (typeof message === 'string') clientEvents.push(JSON.parse(message));
      if (server.readyState === WebSocket.OPEN) server.send(message); else pending.push(message);
    });
    server.on('open', () => { for (const message of pending.splice(0)) server.send(message); });
    server.on('message', (data, binary) => {
      if (!binary) events.push(JSON.parse(data.toString()));
      client.send(binary ? Buffer.from(data as Buffer) : data.toString());
    });
    server.on('close', code => { void client.close({ code: code === 1006 ? 1011 : code }); });
    server.on('error', () => { void client.close({ code: 1011 }); });
    client.onClose(() => { if (server.readyState < WebSocket.CLOSING) server.close(); });
  });
  return { events, clientEvents, errors };
}

async function openLiveLesson(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Live AI/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Live AI/ }).click();
  await page.getByRole('button', { name: /Explore photosynthesis/ }).click();
  await expect(page).toHaveURL(/\/learn\//);
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
}

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
