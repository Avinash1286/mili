import type { ProviderUsage, ProviderUsageObserver } from './types.js';

type GeminiUsageResponse = {
  modelVersion?: unknown; responseId?: unknown;
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; cachedContentTokenCount?: unknown; thoughtsTokenCount?: unknown; toolUsePromptTokenCount?: unknown; totalTokenCount?: unknown };
};
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+=~-]{0,199}$/.test(value) ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Provider metadata only. Missing values remain unknown; cached tokens are included in prompt tokens. */
export function geminiUsage(model: string, response?: GeminiUsageResponse): ProviderUsage {
  const result: ProviderUsage = { provider: 'gemini', model: identifier(response?.modelVersion) ?? identifier(model) ?? 'unknown-model' };
  const requestId = identifier(response?.responseId); if (requestId) result.requestId = requestId;
  const metadata = response?.usageMetadata;
  const fields = [
    ['inputTokens', metadata?.promptTokenCount], ['outputTokens', metadata?.candidatesTokenCount],
    ['cachedInputTokens', metadata?.cachedContentTokenCount], ['thoughtTokens', metadata?.thoughtsTokenCount],
    ['toolUseInputTokens', metadata?.toolUsePromptTokenCount], ['totalTokens', metadata?.totalTokenCount],
  ] as const;
  for (const [key, value] of fields) { const measured = count(value); if (measured !== undefined) result[key] = measured; }
  return result;
}

/** One observation per actual request, including failures/aborts with unknown token counts.
 * A late response after cancellation cannot emit a second charge. Observers must
 * not block provider completion; admission is enforced before this helper runs. */
export async function observeGeminiUsage<T extends GeminiUsageResponse>(options: { model: string; onUsage?: ProviderUsageObserver; signal?: AbortSignal }, operation: () => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  if (!options.onUsage) return operation();
  let reported = false;
  const report = (response?: GeminiUsageResponse) => {
    if (reported) return; reported = true; options.signal?.removeEventListener('abort', onAbort);
    try { void Promise.resolve(options.onUsage!(Object.freeze(geminiUsage(options.model, response)))).catch(() => undefined); }
    catch { /* A metadata sink cannot change a learner-facing provider result. */ }
  };
  const onAbort = () => report();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try { const result = await operation(); report(result); return result; }
  catch (error) { report(); throw error; }
}
