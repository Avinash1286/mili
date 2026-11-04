import { fastProvidersFromEnv } from '@milli/tutor-core';

type Env = Record<string, string | undefined>;
/** Groq is primary, followed by Cerebras and then Gemini when configured. */
export const liveModels = (env: Env) => ({ apiKey: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '', fastProviders: fastProvidersFromEnv(env) });
export const liveModelsConfigured = (env: Env) => Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL) || fastProvidersFromEnv(env).length > 0;
