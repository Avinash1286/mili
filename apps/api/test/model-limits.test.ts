import { expect, it, vi } from 'vitest';
import { lookupModelLimits } from '../src/model-limits.js';
it('fetches only matching authenticated provider metadata and never follows a redirect', async () => {
  const fetcher = vi.fn(async () => Response.json({ name: 'models/fixture', inputTokenLimit: 1000, outputTokenLimit: 100 }));
  expect(await lookupModelLimits('fixture', 'private-fixture', undefined, fetcher as typeof fetch)).toMatchObject({ model: 'fixture', inputTokenLimit: 1000, outputTokenLimit: 100 });
  expect(fetcher).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/models/fixture', expect.objectContaining({ redirect: 'error', headers: { 'x-goog-api-key': 'private-fixture' } }));
  await expect(lookupModelLimits('https://other.test', 'private-fixture', undefined, fetcher as typeof fetch)).rejects.toMatchObject({ code: 'USD_BOUND_UNAVAILABLE' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('fails closed on mismatched, unavailable or incomplete capability metadata', async () => {
  for (const data of [{ name: 'models/other', inputTokenLimit: 1000, outputTokenLimit: 100 }, { name: 'models/fixture' }, { name: 'models/fixture', inputTokenLimit: -1, outputTokenLimit: 10 }]) {
    await expect(lookupModelLimits('fixture', 'private-fixture', undefined, vi.fn(async () => Response.json(data)) as typeof fetch)).rejects.toMatchObject({ code: 'USD_BOUND_UNAVAILABLE' });
  }
});
it('cancels a headerless oversized metadata stream before reading its remainder', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  await expect(lookupModelLimits('fixture', 'private-fixture', undefined, vi.fn(async () => new Response(stream)) as typeof fetch)).rejects.toMatchObject({ code: 'USD_BOUND_UNAVAILABLE' });
  expect(cancelled).toBe(true);
});
