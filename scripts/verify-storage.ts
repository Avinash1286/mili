import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIsolatedConvex } from './isolated-convex';

/** Real private transfers against fresh data and keys; no provider or main DB calls. */
async function main() {
  const isolated = await createIsolatedConvex({ name: 'storage-probe', cloudPort: 3218, sitePort: 3219 });
  try {
    const root = path.resolve(__dirname, '..');
    const env = { ...process.env, ...isolated.env, TOKAI_TEST_CONVEX: '1' };
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/convex.integration.test.ts'], {
      cwd: path.join(root, 'packages/db'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 120000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
    await writeFile(path.join(isolated.directory, 'integration.log'), output, { mode: 0o600 });
    if (code !== 0) throw new Error('Isolated storage integration failed; inspect its ignored integration.log.');
    const report = { checkedAt: new Date().toISOString(), isolated: true, providerCalls: 0, nativeOwnerChecks: true, privateSixMiBTransfer: true, oneUseTransfer: true, revisionRevocation: true, storageAndEgressMetering: true, deletionInventory: true };
    await writeFile(path.join(isolated.directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await isolated.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Isolated storage verification failed.'); process.exitCode = 1; });
