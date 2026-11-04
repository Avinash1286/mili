import { TutorError, type FastProvider, type ProviderUsageObserver } from './types.js';

export type ToolCall = { id?: string; name: string; args: unknown };
export type ToolResult = { id?: string; name: string; output?: unknown; error?: unknown };
export type ModelTurn = { calls: ToolCall[]; text?: string; finishReason?: string };
/** One conversation with one provider; the tutor loop is provider-independent. */
export interface ModelDriver {
  readonly provider: 'gemini' | FastProvider['provider'];
  readonly label: string;
  next(signal: AbortSignal): Promise<ModelTurn>;
  results(results: ToolResult[]): void;
  nudge(text: string): void;
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number) { super(`Provider HTTP ${status}`); this.name = 'ApiError'; }
}

const PROVIDERS: Record<FastProvider['provider'], { label: string; baseUrl: string; model: string; key: string; modelKey: string }> = {
  cerebras: { label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', key: 'CEREBRAS_API_KEY', modelKey: 'CEREBRAS_MODEL' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', key: 'GROQ_API_KEY', modelKey: 'GROQ_MODEL' },
};

/** Fast OpenAI-compatible tutor providers in configured order; Gemini stays the caller's final fallback. */
export function fastProvidersFromEnv(env: Record<string, string | undefined>): FastProvider[] {
  const order = (env.TUTOR_PROVIDER_ORDER ?? 'cerebras,groq').split(',').map(value => value.trim().toLowerCase());
  const timeout = Number(env.TUTOR_FAST_TIMEOUT_MS ?? 12000);
  const timeoutMs = Number.isFinite(timeout) ? Math.max(2000, Math.min(30000, timeout)) : 12000;
  const result: FastProvider[] = [];
  for (const name of order) {
    if (name !== 'cerebras' && name !== 'groq') continue;
    const spec = PROVIDERS[name], apiKey = env[spec.key]?.trim();
    if (!apiKey || result.some(item => item.provider === name)) continue;
    result.push({ provider: name, apiKey, model: env[spec.modelKey]?.trim() || spec.model, timeoutMs });
  }
  return result;
}

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+=~-]{0,199}$/.test(value) ? value : undefined;
function withoutSchemaKeyword(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
  return rest;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string };
type ChatResponse = { id?: unknown; model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } }; choices?: { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] } }[] };

/** One OpenAI-compatible chat request; reports usage once, including failures with unknown counts. */
export async function postChat(config: FastProvider, body: Record<string, unknown>, signal: AbortSignal, onUsage?: ProviderUsageObserver): Promise<ChatResponse> {
  signal.throwIfAborted();
  const url = `${(config.baseUrl ?? PROVIDERS[config.provider].baseUrl).replace(/\/$/, '')}/chat/completions`;
  let reported = false;
  const report = (data?: ChatResponse) => {
    if (reported || !onUsage) return; reported = true;
    const usage = { provider: config.provider, model: identifier(data?.model) ?? identifier(config.model) ?? 'unknown-model', requestId: identifier(data?.id), inputTokens: count(data?.usage?.prompt_tokens), outputTokens: count(data?.usage?.completion_tokens), cachedInputTokens: count(data?.usage?.prompt_tokens_details?.cached_tokens), totalTokens: count(data?.usage?.total_tokens) };
    try { void Promise.resolve(onUsage(Object.freeze(Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as never))).catch(() => undefined); } catch { /* Metadata cannot change the learner result. */ }
  };
  try {
    const response = await fetch(url, { method: 'POST', signal, headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, ...body, ...(/gpt-oss/i.test(config.model) ? { reasoning_effort: 'low' } : {}) }) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ProviderHttpError(response.status); }
    const data = await response.json() as ChatResponse; report(data); return data;
  } catch (error) { report(); throw error; }
}
export { withoutSchemaKeyword };

export class OpenAICompatibleDriver implements ModelDriver {
  readonly provider: FastProvider['provider'];
  readonly label: string;
  private readonly messages: ChatMessage[];
  constructor(private readonly config: FastProvider, system: string, context: string, private readonly declarations: { name: string; description: string; parametersJsonSchema: unknown }[], private readonly onUsage?: ProviderUsageObserver) {
    this.provider = config.provider; this.label = PROVIDERS[config.provider].label;
    this.messages = [{ role: 'system', content: system }, { role: 'user', content: context }];
  }
  async next(signal: AbortSignal): Promise<ModelTurn> {
    const data = await postChat(this.config, {
      messages: this.messages, max_completion_tokens: 4096, temperature: 0.4, tool_choice: 'auto', parallel_tool_calls: true,
      tools: this.declarations.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: withoutSchemaKeyword(item.parametersJsonSchema) } })),
    }, signal, this.onUsage);
    const choice = data.choices?.[0], message = choice?.message;
    if (!message) throw new SyntaxError('Missing completion message.');
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    this.messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    const calls = toolCalls.map(call => {
      let args: unknown = call.function?.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = { invalidArguments: true }; } }
      return { id: typeof call.id === 'string' ? call.id : undefined, name: typeof call.function?.name === 'string' ? call.function.name : 'unknown', args };
    });
    return { calls, text: typeof message.content === 'string' ? message.content : undefined, finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined };
  }
  results(results: ToolResult[]) {
    for (const result of results) this.messages.push({ role: 'tool', tool_call_id: result.id ?? result.name, content: JSON.stringify(result.error !== undefined ? { error: result.error } : { output: result.output }) });
  }
  nudge(text: string) { this.messages.push({ role: 'user', content: text }); }
}

export function providerLabel(provider: ModelDriver['provider']) { return provider === 'gemini' ? 'Gemini' : PROVIDERS[provider].label; }
export function unavailable(): TutorError { return new TutorError('TUTOR_UNAVAILABLE', 'Live AI is not configured. Set CEREBRAS_API_KEY, GROQ_API_KEY or GEMINI_API_KEY with GEMINI_MODEL on the server, or explicitly choose a sample lesson.'); }
