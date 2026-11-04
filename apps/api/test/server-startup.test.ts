import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

test('server entrypoint completes import before Vercel starts its captured listener', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'milli-server-startup-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const entrypoint = new URL('../src/server.ts', import.meta.url).href;
  // Keep the child isolated from developer credentials and local dotenv files.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { NODE_ENV: 'test', VERCEL: '0', TOKAI_FILE_STORE: '1', TOKAI_DATA_DIR: directory, PORT: '4000' });
  const source = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { once } from 'node:events';
    const watchdog = setTimeout(() => {
      console.error('Server entrypoint did not finish importing before listener startup');
      process.exit(1);
    }, 5000);
    const originalListen = http.Server.prototype.listen;
    let captured, serverFound;
    const capture = new Promise(resolve => { serverFound = resolve; });
    // Vercel captures listen() during module evaluation and binds the server
    // only after import resolves; it does not invoke the listening callback yet.
    http.Server.prototype.listen = function () {
      captured = this;
      http.Server.prototype.listen = originalListen;
      serverFound();
      return this;
    };
    const { default: app } = await import(${JSON.stringify(entrypoint)});
    await capture;
    assert.equal(app.server, captured);
    assert.equal(captured.listening, false);
    const listening = once(captured, 'listening');
    originalListen.call(captured, { port: 0, host: '127.0.0.1' });
    await listening;
    const response = await fetch('http://127.0.0.1:' + captured.address().port + '/health/live');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', providers: { tutor: false, speech: false, voice: false } });
    await app.close();
    clearTimeout(watchdog);
    console.log('serverless-startup-ok');
  `;
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: root, env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /serverless-startup-ok/);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('milli-server-startup-'));
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
