import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2), option = (name: string) => args[args.indexOf(name) + 1];
const target = option('--environment');
if (!['production', 'preview'].includes(target)) throw new Error('Choose --environment production or preview.');
const origin = new URL(option('--origin')), backend = new URL(option('--convex-url'));
if (origin.protocol !== 'https:' || origin.origin !== origin.href.replace(/\/$/, '') || !backend.hostname.endsWith('.convex.cloud') || backend.protocol !== 'https:') throw new Error('Explicit HTTPS app and Convex origins are required.');
const output = resolve(root, '.tokai/cloud'), apiFile = resolve(output, `${target}-api.env`), convexFile = resolve(output, `${target}-convex.env`);
await mkdir(output, { recursive: true });
if (await readFile(apiFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Environment already exists; rotate credentials deliberately instead of overwriting.');
const kid = `tokai-${target}-1`, keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), secret = () => randomBytes(32).toString('base64url');
const shared: Record<string, string> = { TOKAI_SERVICE_ISSUER: origin.origin, TOKAI_JOB_SECRET: secret(), APP_ORIGIN: origin.origin, BETTER_AUTH_SECRET: secret() };
const api: Record<string, string> = {
  ...shared, CONVEX_URL: backend.origin, CONVEX_SITE_URL: backend.origin.replace('.convex.cloud', '.convex.site'),
  TOKAI_SERVICE_PRIVATE_KEY: Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'),
  TOKAI_SERVICE_KEY_ID: kid, SESSION_SECRET: secret(), TOKAI_NATIVE_AUTH: '1',
  API_ORIGIN: origin.origin, API_PUBLIC_URL: origin.origin, NEXT_PUBLIC_API_URL: '/',
  NEXT_PUBLIC_CONVEX_URL: backend.origin, NEXT_PUBLIC_CONVEX_SITE_URL: backend.origin.replace('.convex.cloud', '.convex.site'),
  VERCEL_SUPPORT_LARGE_FUNCTIONS: '1', TOKAI_LOG_METRICS: '1',
};
if (args.includes('--include-provider-keys')) {
  // These values go only to the explicitly selected API host, never the browser or Convex.
  for (const file of ['.env', '.env.local']) {
    const content = await readFile(resolve(root, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    for (const line of content.split(/\r?\n/)) { const match = /^\s*(GEMINI_API_KEY|GEMINI_MODEL|VISION_MODEL|ASSEMBLYAI_API_KEY|ASSEMBLYAI_VOICE_ID|ASSEMBLYAI_STT_MODEL)\s*=\s*(.*?)\s*$/.exec(line); if (match?.[2]) api[match[1]!] = match[2].replace(/^(['"])(.*)\1$/, '$2'); }
  }
}
const convex: Record<string, string> = { ...shared, INTERNAL_API_URL: origin.origin, TOKAI_SERVICE_JWKS: Buffer.from(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })).toString('base64') };
if (target === 'preview') Object.assign(convex, { TOKAI_MODEL_GLOBAL_DAILY_UNITS: '10', TOKAI_SPEECH_GLOBAL_DAILY_UNITS: '5000', TOKAI_TRANSCRIPTION_GLOBAL_DAILY_UNITS: '120000', TOKAI_INGESTION_GLOBAL_DAILY_UNITS: String(30 * 1024 * 1024) });
const serialize = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n';
await writeFile(apiFile, serialize(api), { mode: 0o600, flag: 'wx' });
await writeFile(convexFile, serialize(convex), { mode: 0o600, flag: 'wx' });
console.info(JSON.stringify({ prepared: target, origin: origin.origin, backend: backend.origin, apiVariables: Object.keys(api), convexVariables: Object.keys(convex), note: 'Only ignored files were written. No cloud configuration or deployment was changed.' }));
