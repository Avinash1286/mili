import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { SpeechError, synthesizeSpeech } from '../src/synthesis.js';

function wave(): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return new Uint8Array(bytes);
}
const input = { text: 'Explain chloroplasts.', apiKey: 'server-secret-do-not-log' };
const response = () => new Response(wave(), { headers: { 'Content-Type': 'audio/wav' } });

describe('HTTP speech synthesis', () => {
  it('sends only the server credential and documented WAV request; returns a Buffer', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await synthesizeSpeech(input, { fetchImpl });
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect(result.contentType).toBe('audio/wav');
    expect(result.audio.length).toBe(48);
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://tts.us.assemblyai.com/v1/speech');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject({ Authorization: input.apiKey });
    expect(JSON.parse(String(options?.body))).toEqual({
      text: input.text, voice_id: 'aai-audrey', language: 'english', container: 'wav', stream: false,
    });
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
  });

  it('validates size, empty input, voice and configuration before making any paid call', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const invalid of [
      { ...input, text: '' }, { ...input, text: 'x'.repeat(2_001) },
      { ...input, voiceId: 'voice\r\ninjection' }, { ...input, apiKey: '' },
    ]) await expect(synthesizeSpeech(invalid, { fetchImpl })).rejects.toBeInstanceOf(SpeechError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('counts Unicode code points rather than UTF-16 units', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    await synthesizeSpeech({ ...input, text: '🙂'.repeat(1_500) }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [500, 'provider-error']])(
    'does not expose upstream bodies or retry HTTP %i', async (status, code) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`error ${input.apiKey}`, { status }));
      const error = await synthesizeSpeech(input, { fetchImpl }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain(input.apiKey);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects JSON success and fake WAV headers instead of returning error text as audio', async () => {
    for (const bad of [
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      new Response('secret upstream error', { headers: { 'Content-Type': 'audio/wav' } }),
      new Response(new Uint8Array(wave().slice(0, 45)), { headers: { 'Content-Type': 'audio/wav' } }),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(bad);
      await expect(synthesizeSpeech(input, { fetchImpl })).rejects.toMatchObject({ code: 'invalid-audio' });
    }
  });

  it('bounds header-declared and chunked audio without trusting content-length', async () => {
    const oversized = 8 * 1024 * 1024 + 1;
    for (const bad of [
      new Response(wave(), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(oversized) } }),
      new Response(new Uint8Array(oversized), { headers: { 'Content-Type': 'audio/wav' } }),
    ]) await expect(synthesizeSpeech(input, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(bad) }))
      .rejects.toMatchObject({ code: 'audio-too-large' });
  });

  it('enforces timeout even when an injected transport ignores abort', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    await expect(synthesizeSpeech(input, { fetchImpl, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('bounds a response body that stalls after successful headers', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(synthesizeSpeech(input, { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' });
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels in-flight work and never starts a pre-cancelled request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const task = synthesizeSpeech({ ...input, signal: controller.signal }, { fetchImpl });
    controller.abort('private context');
    await expect(task).rejects.toMatchObject({ code: 'aborted' });
    await expect(synthesizeSpeech({ ...input, signal: controller.signal }, { fetchImpl }))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('replaces unsafe network exceptions with a bounded error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Proxy headers ${input.apiKey}`));
    const error = await synthesizeSpeech(input, { fetchImpl }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'provider-error' });
    expect(String(error)).not.toContain(input.apiKey);
  });
});
