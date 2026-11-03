import { expect, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { decodeAudioFrame } from '../../packages/contracts/src/index.js';

export type TransportEvent = { type: string; outputEpoch?: number; state?: string; [key: string]: unknown };
export type TransportTrace = { direction: 'client' | 'server'; event: TransportEvent };

/** Real browser/API protocol; only the fixture server's paid providers are replaced. */
export async function fixtureTransport(page: Page) {
  const events: TransportEvent[] = [], clientEvents: TransportEvent[] = [], errors: string[] = [];
  const trace: TransportTrace[] = [];
  let hold: ((event: TransportEvent) => boolean) | undefined;
  const held: (() => void)[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost:4000/**', async route => {
    const url = new URL(route.request().url()); url.port = '4100';
    await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  await page.routeWebSocket('ws://localhost:4000/v1/voice?*', client => {
    const url = new URL(client.url()); url.port = '4100';
    const server = new WebSocket(url, { origin: 'http://localhost:3000', perMessageDeflate: false });
    const pending: (() => void)[] = [];
    client.onMessage(message => {
      const event = typeof message === 'string' ? JSON.parse(message) as TransportEvent : undefined;
      if (event) clientEvents.push(event);
      const send = () => {
        if (server.readyState !== WebSocket.OPEN) return;
        if (event) trace.push({ direction: 'client', event });
        server.send(message);
      };
      const enqueue = () => {
        if (server.readyState === WebSocket.OPEN) send();
        else if (server.readyState === WebSocket.CONNECTING) pending.push(send);
      };
      if (event && hold?.(event)) held.push(enqueue); else enqueue();
    });
    server.on('open', () => { for (const send of pending.splice(0)) send(); });
    server.on('message', (data, binary) => {
      if (!binary) {
        const event = JSON.parse(data.toString()) as TransportEvent;
        events.push(event); trace.push({ direction: 'server', event });
      } else {
        const frame = decodeAudioFrame(Buffer.from(data as Buffer));
        trace.push({ direction: 'server', event: { type: 'audio.chunk', streamId: frame.streamId, outputEpoch: frame.outputEpoch, seq: frame.seq, sampleCount: frame.samples.length } });
      }
      client.send(binary ? Buffer.from(data as Buffer) : data.toString());
    });
    server.on('close', code => { void client.close({ code: code === 1006 ? 1011 : code }); });
    server.on('error', () => { void client.close({ code: 1011 }); });
    client.onClose(() => { if (server.readyState < WebSocket.CLOSING) server.close(); });
  });
  return {
    events, clientEvents, errors, trace,
    holdClientEvents(predicate: (event: TransportEvent) => boolean) { hold = predicate; },
    releaseClientEvents() { hold = undefined; for (const send of held.splice(0)) send(); },
  };
}

export async function openLiveLesson(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Live AI/ })).toBeEnabled();
  await page.getByRole('button', { name: /^Live AI/ }).click();
  await page.getByRole('button', { name: /Explore photosynthesis/ }).click();
  await expect(page).toHaveURL(/\/learn\//);
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
}
