import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
// One public origin routes /v1, /auth and /health to Fastify; /api/auth stays in Next.
const env = { ...process.env, NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '/' };
const testEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: 'test' };
for (const name of Object.keys(testEnv)) if (/^(?:VERCEL(?:_|$)|GEMINI_|ASSEMBLYAI_|CONVEX_|NEXT_PUBLIC_CONVEX_|TOKAI_|OIDC_|BETTER_AUTH_|SESSION_SECRET$|INTERNAL_API_URL$|APP_ORIGIN$|API_ORIGIN$|API_PUBLIC_URL$)/.test(name)) delete testEnv[name];
// Vercel-native build gates run for CLI and Git-triggered deployments alike.
// Actual provider and local-service integration probes remain explicit release gates.
for (const args of [['typecheck'], ['test'], ['api:spec:check'], ['assets:sync'], ['assets:check'], ['--filter', '@tokai/web', 'build']]) {
  const result = spawnSync('pnpm', args, { cwd: root, env: args[0] === 'test' ? testEnv : env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
