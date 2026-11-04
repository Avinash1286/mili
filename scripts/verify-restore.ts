import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { restoreProbeFunctions } from './restore-probe-fixtures';

const root = path.resolve(__dirname, '..');
const base = path.resolve(root, '.tokai/restore-probe');
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), directory = path.join(base, stamp);
const sourceUrl: string = 'http://127.0.0.1:3210', targetUrl: string = 'http://127.0.0.1:3212';
const cli = path.join(root, 'node_modules/convex/bin/main.js');
const require = createRequire(path.join(root, 'node_modules/convex/package.json'));
type ZipEntry = { entryName: string; isDirectory: boolean; getData(): Buffer };
const AdmZip = require('adm-zip') as new (file: string) => { getEntries(): ZipEntry[] };
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const progress = (stage: string) => process.stdout.write(JSON.stringify({ stage }) + '\n');
const cleanEnv = () => { const env = { ...process.env, CONVEX_AGENT_MODE: 'anonymous', CONVEX_NO_TELEMETRY: '1' }; for (const key of Object.keys(env)) if (key.startsWith('CONVEX_') && !['CONVEX_AGENT_MODE', 'CONVEX_NO_TELEMETRY'].includes(key)) delete (env as Record<string, string | undefined>)[key]; return env; };
let sequence = 0, backend: ChildProcess | undefined;
async function command(args: string[], cwd: string, secret?: { url: string; adminKey: string }) {
  if (secret?.url === sourceUrl && args[0] !== 'export') throw new Error('Only read-only export is permitted against the main deployment.');
  if (args[0] === 'import' && (secret?.url !== targetUrl || !cwd.startsWith(directory + path.sep) && cwd !== directory)) throw new Error('Import destination is outside the isolated restore instance.');
  const env = cleanEnv();
  const child = spawn(process.execPath, [cli, ...args, ...(secret ? ['--url', secret.url, '--admin-key', secret.adminKey] : [])], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stdout = ''; child.stdout?.on('data', data => { output += data; stdout += data; }); child.stderr?.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 180000);
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timer);
  const log = path.join(directory, `command-${++sequence}.log`); await writeFile(log, output, { mode: 0o600 });
  if (code !== 0) throw new Error(`Convex ${args[0]} failed; inspect ignored command-${sequence}.log locally. No provider calls were made.`);
  return stdout;
}
async function portAvailable(port: number) {
  await new Promise<void>((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`Port ${port} is already occupied; no process was stopped.`))); server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve())); });
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (backend?.exitCode !== null) throw new Error('The isolated native backend exited before becoming ready.');
    try { if ((await fetch(`${targetUrl}/version`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The isolated native backend did not start within its deadline.');
}
function archive(file: string) {
  const tables = new Map<string, { count: number; sha256: string }>(), files = new Map<string, string>();
  for (const entry of new AdmZip(file).getEntries()) {
    if (entry.isDirectory) continue;
    if (entry.entryName.endsWith('/documents.jsonl')) {
      const rows = entry.getData().toString('utf8').split(/\r?\n/).filter(Boolean).map(line => canonical(JSON.parse(line))).sort();
      tables.set(entry.entryName, { count: rows.length, sha256: digest(rows.join('\n')) });
    } else if (/(^|\/)\_storage\//.test(entry.entryName) && !entry.entryName.endsWith('/generated_schema.jsonl')) files.set(entry.entryName, digest(entry.getData()));
  }
  return { tables, files };
}
function compare(expected: ReturnType<typeof archive>, actual: ReturnType<typeof archive>) {
  for (const [table, value] of expected.tables) if (canonical(actual.tables.get(table)) !== canonical(value)) throw new Error(`Restored table mismatch (${table}); private rows remain only in ignored archives.`);
  for (const [file, hash] of expected.files) if (actual.files.get(file) !== hash) throw new Error('Restored native file hash mismatch.');
  if (actual.tables.size !== expected.tables.size || actual.files.size !== expected.files.size) throw new Error('Restored archive contains an unexpected table or file.');
}
async function main() {
  if (path.relative(root, directory).startsWith('..') || directory === root || targetUrl === sourceUrl) throw new Error('Unsafe restore destination.');
  await portAvailable(3212); await portAvailable(3213); await mkdir(directory, { recursive: true });
  const source = JSON.parse(await readFile(path.join(root, '.convex/local/default/config.json'), 'utf8'));
  if (source.ports.cloud !== 3210 || source.ports.site !== 3211) throw new Error('The main deployment is not on the expected3210/3211 ports.');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'tokai-isolated-restore-probe', private: true, type: 'module', dependencies: { convex: '1.49.0', '@convex-dev/better-auth': '0.12.7', 'better-auth': '1.6.34' } }));
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  await cp(path.join(root, 'convex'), path.join(directory, 'convex'), { recursive: true });
  await writeFile(path.join(directory, 'convex/restoreProbe.ts'), restoreProbeFunctions);
  await mkdir(path.join(directory, 'packages/contracts'), { recursive: true });
  await cp(path.join(root, 'packages/contracts/src'), path.join(directory, 'packages/contracts/src'), { recursive: true });
  await mkdir(path.join(directory, 'packages/db/src'), { recursive: true });
  await cp(path.join(root, 'packages/db/src/transfer-validation.ts'), path.join(directory, 'packages/db/src/transfer-validation.ts'));
  await symlink(path.join(root, 'packages/contracts/node_modules'), path.join(directory, 'packages/contracts/node_modules'), 'junction');
  // Restored jobs must not call the main API or a provider; cron recovery is tested explicitly below.
  await writeFile(path.join(directory, 'convex/crons.ts'), "import { cronJobs } from 'convex/server'; export default cronJobs();\n");
  progress('initialize-isolated-anonymous-instance');
  await command(['dev', '--once', '--skip-push', '--local-cloud-port', '3212', '--local-site-port', '3213', '--local-backend-version', source.backendVersion, '--tail-logs', 'disable'], directory);
  const target = JSON.parse(await readFile(path.join(directory, '.convex/local/default/config.json'), 'utf8'));
  if (target.ports.cloud !== 3212 || target.ports.site !== 3213 || target.adminKey === source.adminKey || target.instanceSecret === source.instanceSecret) throw new Error('The restore instance was not independently initialized.');
  const binary = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE!, 'AppData/Local'), 'convex/binaries', target.backendVersion, process.platform === 'win32' ? 'convex-local-backend.exe' : 'convex-local-backend');
  await stat(binary);
  // The CLI-generated instance secret is private; fallback is the official local-development default.
  const utils = await readFile(path.join(root, 'node_modules/convex/src/cli/lib/localDeployment/utils.ts'), 'utf8');
  const fallback = utils.match(/LOCAL_BACKEND_INSTANCE_SECRET\s*=\s*["']([^"']+)["']/)?.[1];
  if (!target.instanceSecret && !fallback) throw new Error('Cannot resolve the local backend instance secret.');
  const state = path.join(directory, '.convex/local/default');
  backend = spawn(binary, ['--port', '3212', '--site-proxy-port', '3213', '--instance-name', target.deploymentName, '--instance-secret', target.instanceSecret ?? fallback!, '--local-storage', path.join(state, 'convex_local_storage'), path.join(state, 'convex_local_backend.sqlite3')], { cwd: directory, env: { ...cleanEnv(), RUST_LOG: 'error' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let backendLog = ''; backend.stdout?.on('data', data => { backendLog += data; }); backend.stderr?.on('data', data => { backendLog += data; });
  await ready();
  const admin = { url: targetUrl, adminKey: target.adminKey };
  const values = (await readFile(path.join(root, '.tokai/convex.env'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => line.startsWith('INTERNAL_API_URL=') ? 'INTERNAL_API_URL=http://127.0.0.1:9' : line);
  await writeFile(path.join(directory, 'restore.env'), values.join('\n') + '\n', { mode: 0o600 });
  await command(['env', 'set', '--from-file', 'restore.env'], directory, admin);
  progress('deploy-isolated-code-with-background-execution-disabled');
  await command(['dev', '--once', '--typecheck', 'disable', '--tail-logs', 'disable'], directory, admin);
  progress('export-main-read-only-with-files-and-components');
  const original = path.join(directory, 'main-export.zip'), restored = path.join(directory, 'restored-export.zip');
  await command(['export', '--path', original, '--include-file-storage'], root, { url: sourceUrl, adminKey: source.adminKey });
  progress('import-into-empty-isolated-instance');
  await command(['import', original, '--yes'], directory, admin);
  await command(['export', '--path', restored, '--include-file-storage'], directory, admin);
  const expected = archive(original), actual = archive(restored);
  compare(expected, actual);
  progress('verify-native-file-loss-and-restoration-with-isolated-fixture');
  await command(['run', 'restoreProbe:addFile', '{}'], directory, admin);
  const withFile = path.join(directory, 'with-private-file.zip'), fileRestored = path.join(directory, 'file-restored.zip');
  await command(['export', '--path', withFile, '--include-file-storage'], directory, admin);
  const fixture = archive(withFile); if (fixture.files.size < 1) throw new Error('The native file fixture was not exported.');
  await command(['run', 'restoreProbe:removeFile', '{}'], directory, admin);
  await command(['import', withFile, '--replace-all', '--yes'], directory, admin);
  await command(['export', '--path', fileRestored, '--include-file-storage'], directory, admin);
  compare(fixture, archive(fileRestored));
  progress('verify-native-job-recovery-fences-and-idempotency');
  const recovery = JSON.parse(await command(['run', 'restoreProbe:verifyRecovery', '{}'], directory, admin)) as Record<string, boolean>;
  progress('verify-native-retention-with-isolated-owners');
  const retention = JSON.parse(await command(['run', 'restoreProbe:verifyRetention', '{}'], directory, admin)) as Record<string, boolean>;
  const report = { checkedAt: new Date().toISOString(), source: 'native-local-3210-read-only-export', target: 'isolated-native-local-3212', files: expected.files.size, rows: [...expected.tables.values()].reduce((sum, row) => sum + row.count, 0), tables: expected.tables.size, componentTables: [...expected.tables.keys()].filter(key => key.includes('_components/')).length, equalTableHashes: true, equalFileHashes: true, nativeFixtureFilesRestored: fixture.files.size, recovery, retention, mainExportSha256: digest(await readFile(original)), restoredExportSha256: digest(await readFile(restored)), providerCalls: 0 };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(directory, 'backend.log'), backendLog, { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
}
void main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Restore verification failed.') + '\n'); process.exitCode = 1; }).finally(async () => { if (backend && backend.exitCode === null) { backend.kill(); await new Promise<void>(resolve => { backend!.once('close', () => resolve()); setTimeout(resolve, 3000).unref(); }); } });
