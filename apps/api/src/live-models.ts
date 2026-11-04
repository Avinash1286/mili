import { fastProvidersFromEnv } from '@tokai/tutor-core';

type Env = Record<string, string | undefined>;
/** Fast OpenAI-compatible providers first, Gemini as the fallback. */
export const liveModels = (env: Env) => ({ apiKey: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '', fastProviders: fastProvidersFromEnv(env) });
export const liveModelsConfigured = (env: Env) => Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL) || fastProvidersFromEnv(env).length > 0;
