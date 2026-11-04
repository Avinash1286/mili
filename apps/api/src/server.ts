import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

if (!process.env.VERCEL) for (const name of ['.env', '.env.local']) {
  try { loadEnvFile(fileURLToPath(new URL(`../../../${name}`, import.meta.url))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const production = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
if (production && (!process.env.CONVEX_URL || !process.env.TOKAI_SERVICE_PRIVATE_KEY || !process.env.TOKAI_JOB_SECRET || !process.env.APP_ORIGIN || !process.env.API_ORIGIN)) throw new Error('Production requires durable Convex, callback authentication and explicit application origins.');
if (production) for (const name of ['CONVEX_URL', 'APP_ORIGIN', 'API_ORIGIN'] as const) { const url = new URL(process.env[name]!); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Production ${name} must use HTTPS.`); }
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT or API_PORT must be a valid port number.');
const app = await createApp();
await app.listen({ port, host: production ? '0.0.0.0' : '127.0.0.1' });
console.info(`Tokai API ready on port ${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
  void app.close().then(() => { clearTimeout(deadline); process.exitCode = 0; }, () => { clearTimeout(deadline); process.exitCode = 1; });
});
export default app;
