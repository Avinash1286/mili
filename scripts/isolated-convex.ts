import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'node_modules/convex/bin/main.js');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Fresh local data and keys only: no import/export, production deployment or main environment mutation. */
export async function createIsolatedConvex(input: { name: string; cloudPort: number; sitePort: number }) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(input.name) || ![input.cloudPort, input.sitePort].every(port => Number.isInteger(port) && port >= 3214 && port <= 3299) || input.cloudPort === input.sitePort) throw new Error('Invalid isolated probe name or port range.');
  for (const port of [input.cloudPort, input.sitePort]) await new Promise<void>((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`Isolated port ${port} is occupied; no process was stopped.`))); server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve())); });
  const directory = path.resolve(root, '.tokai', input.name, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex'));
  if (!directory.startsWith(path.join(root, '.tokai') + path.sep)) throw new Error('Unsafe isolated probe directory.');
  await mkdir(directory, { recursive: true });
  const cleanEnv = () => {
    const env = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_NO_TELEMETRY: '1' };
    for (const name of Object.keys(env)) if (/^(CONVEX_|TOKAI_|GEMINI_|ASSEMBLYAI_|GOOGLE_|BETTER_AUTH_|SESSION_SECRET|INTERNAL_API_URL)/.test(name) && !['CONVEX_AGENT_MODE', 'CONVEX_NO_TELEMETRY'].includes(name)) delete (env as Record<string, string | undefined>)[name];
    return env;
  };
  let sequence = 0, backend: ChildProcess | undefined, backendLog = '';
  const close = async () => {
    if (backend && backend.exitCode === null) { const child = backend; child.kill(); await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())), sleep(3000)]); }
    await writeFile(path.join(directory, 'backend.log'), backendLog.slice(-1024 * 1024), { mode: 0o600 });
  };
  const targetUrl = `http://127.0.0.1:${input.cloudPort}`;
  let adminKey: string | undefined;
  async function command(args: string[], authenticated = true) {
    if (['export', 'import'].includes(args[0]!)) throw new Error('Isolated probes never import or export application data.');
    const child = spawn(process.execPath, [cli, ...args, ...(authenticated && adminKey ? ['--url', targetUrl, '--admin-key', adminKey] : [])], { cwd: directory, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stdout = ''; child.stdout?.on('data', data => { output += data; stdout += data; }); child.stderr?.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill(), 180000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
    await writeFile(path.join(directory, `command-${++sequence}.log`), output, { mode: 0o600 });
    if (code !== 0) throw new Error(`Isolated Convex ${args[0]} failed; inspect ignored command-${sequence}.log in its probe directory.`);
    return stdout;
  }
  try {
    // Only the installed backend version is used; no main database/credentials are copied.
    const { backendVersion } = JSON.parse(await readFile(path.join(root, '.convex/local/default/config.json'), 'utf8')) as { backendVersion: string };
    const packages = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `tokai-${input.name}`, private: true, type: 'module', dependencies: { convex: packages.devDependencies.convex, '@convex-dev/better-auth': packages.dependencies['@convex-dev/better-auth'], 'better-auth': packages.dependencies['better-auth'] } }));
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    await cp(path.join(root, 'convex'), path.join(directory, 'convex'), { recursive: true });
    await mkdir(path.join(directory, 'packages/contracts'), { recursive: true });
    await cp(path.join(root, 'packages/contracts/src'), path.join(directory, 'packages/contracts/src'), { recursive: true });
    await symlink(path.join(root, 'packages/contracts/node_modules'), path.join(directory, 'packages/contracts/node_modules'), 'junction');
    await mkdir(path.join(directory, 'packages/db/src'), { recursive: true });
    await cp(path.join(root, 'packages/db/src/transfer-validation.ts'), path.join(directory, 'packages/db/src/transfer-validation.ts'));
    await writeFile(path.join(directory, 'convex/crons.ts'), "import { cronJobs } from 'convex/server'; export default cronJobs();\n");
    await command(['dev', '--once', '--skip-push', '--local-cloud-port', String(input.cloudPort), '--local-site-port', String(input.sitePort), '--local-backend-version', backendVersion, '--tail-logs', 'disable'], false);
    const config = JSON.parse(await readFile(path.join(directory, '.convex/local/default/config.json'), 'utf8'));
    if (config.ports.cloud !== input.cloudPort || config.ports.site !== input.sitePort) throw new Error('The isolated backend used unexpected ports.');
    adminKey = config.adminKey;
    const binary = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE!, 'AppData/Local'), 'convex/binaries', config.backendVersion, process.platform === 'win32' ? 'convex-local-backend.exe' : 'convex-local-backend'); await stat(binary);
    const utils = await readFile(path.join(root, 'node_modules/convex/src/cli/lib/localDeployment/utils.ts'), 'utf8');
    const fallback = utils.match(/LOCAL_BACKEND_INSTANCE_SECRET\s*=\s*["']([^"']+)["']/)?.[1];
    if (!config.instanceSecret && !fallback) throw new Error('The local backend instance secret is unavailable.');
    const state = path.join(directory, '.convex/local/default');
    backend = spawn(binary, ['--port', String(input.cloudPort), '--site-proxy-port', String(input.sitePort), '--instance-name', config.deploymentName, '--instance-secret', config.instanceSecret ?? fallback!, '--local-storage', path.join(state, 'convex_local_storage'), path.join(state, 'convex_local_backend.sqlite3')], { cwd: directory, env: { ...cleanEnv(), RUST_LOG: 'error' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    backend.stdout?.on('data', data => { backendLog = (backendLog + data).slice(-1024 * 1024); }); backend.stderr?.on('data', data => { backendLog = (backendLog + data).slice(-1024 * 1024); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { if (backend.exitCode !== null) throw new Error('Isolated backend exited during startup.'); try { if ((await fetch(`${targetUrl}/version`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} await sleep(200); }
    if (!ready) throw new Error('Isolated backend did not become ready within its deadline.');
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), keyId = 'isolated-probe-1';
    const env: Record<string, string | undefined> = { CONVEX_URL: targetUrl, CONVEX_SITE_URL: `http://127.0.0.1:${input.sitePort}`, TOKAI_SERVICE_ISSUER: `http://tokai-${input.name}.invalid`, TOKAI_SERVICE_KEY_ID: keyId,
      TOKAI_SERVICE_PRIVATE_KEY: Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'), TOKAI_SERVICE_JWKS: Buffer.from(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'RS256', use: 'sig' }] })).toString('base64'),
      TOKAI_JOB_SECRET: randomBytes(32).toString('base64url'), SESSION_SECRET: randomBytes(32).toString('base64url'), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'), INTERNAL_API_URL: 'http://127.0.0.1:9', APP_ORIGIN: 'http://localhost:3000', TOKAI_NATIVE_AUTH: '0' };
    await writeFile(path.join(directory, 'server.env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 });
    const backendNames = ['TOKAI_SERVICE_JWKS', 'TOKAI_SERVICE_ISSUER', 'TOKAI_JOB_SECRET', 'INTERNAL_API_URL', 'BETTER_AUTH_SECRET', 'APP_ORIGIN'];
    await writeFile(path.join(directory, 'backend.env'), backendNames.map(name => `${name}=${env[name]}`).join('\n') + '\n', { mode: 0o600 });
    await command(['env', 'set', '--from-file', 'backend.env']);
    await command(['dev', '--once', '--typecheck', 'disable', '--tail-logs', 'disable']);
    return { env, directory, close, command };
  } catch (error) { await close(); throw error; }
}
