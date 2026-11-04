import { StoreError } from '@tokai/db';
import type { VerifiedModelLimit } from '@tokai/contracts';

/** Metadata lookup only; fixed Google origin, no redirects, no prompt or key in logs. */
export async function lookupModelLimits(model: string, apiKey: string | undefined, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<VerifiedModelLimit> {
  const name = model.replace(/^models\//, '');
  if (!apiKey || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(name)) throw new StoreError(503, 'USD_BOUND_UNAVAILABLE', 'A verified provider model limit is required for dollar admission.');
  try {
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}`, {
      headers: { 'x-goog-api-key': apiKey }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536) throw new Error('MODEL_METADATA_UNAVAILABLE');
    const reader = response.body?.getReader(); if (!reader) throw new Error('MODEL_METADATA_UNAVAILABLE');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { await reader.cancel(); throw new Error('MODEL_METADATA_OVERSIZE'); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    const value = JSON.parse(text);
    if (value.name !== `models/${name}` || !Number.isSafeInteger(value.inputTokenLimit) || value.inputTokenLimit < 1 || !Number.isSafeInteger(value.outputTokenLimit) || value.outputTokenLimit < 1) throw new Error('MODEL_METADATA_MISMATCH');
    return { model: name, inputTokenLimit: value.inputTokenLimit, outputTokenLimit: value.outputTokenLimit, verifiedAt: Date.now() };
  } catch { throw new StoreError(503, 'USD_BOUND_UNAVAILABLE', 'Model capability verification failed. Dollar-capped work was not started.'); }
}
