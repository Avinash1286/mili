import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createCanvas } from '../../packages/grounding/node_modules/@napi-rs/canvas/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url)), runtime = resolve(root, '.tokai-runtime');
const canvas = createCanvas(1400, 400), context = canvas.getContext('2d');
context.fillStyle = 'white'; context.fillRect(0, 0, 1400, 400); context.fillStyle = 'black'; context.font = '40px Arial';
context.fillText('Photosynthesis uses light energy to make sugar.', 40, 90);
context.fillText('Plants take in carbon dioxide from the air.', 40, 170);
const result = await new Promise<{ pages: number; chunks: { text: string; embedding: number[] }[]; metrics: unknown }>((done, reject) => {
  const child = fork(resolve(runtime, 'packages/grounding/src/child.ts'), [], { cwd: runtime,
    execArgv: ['--import', new URL('./runtime-guard.mjs', import.meta.url).href, '--import', 'tsx', '--max-old-space-size=768'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR', 'PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])), TOKAI_RUNTIME_VERIFY_ROOT: runtime },
  });
  let completed = false, diagnostic = ''; const finish = (error?: Error, value?: unknown) => { if (completed) return; completed = true; clearTimeout(timer); child.kill(); error ? reject(error) : done(value as never); };
  const timer = setTimeout(() => finish(new Error('Native bundle verification timed out.')), 120000);
  child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  child.once('error', error => finish(error)); child.once('exit', () => finish(new Error(`Native bundle failed: ${diagnostic}`)));
  child.once('message', (value: { error?: string }) => finish(value.error ? new Error(value.error) : undefined, value));
  child.send({ bytes: canvas.toBuffer('image/png'), mime: 'image/png', sourceId: 'bundle-verification', revision: 0 });
});
if (!result.chunks.some(chunk => /photosynthesis/i.test(chunk.text)) || result.chunks.some(chunk => chunk.embedding.length !== 384)) throw new Error('The native bundle did not return actual OCR and embeddings.');
console.info(JSON.stringify({ nativeBundleVerified: true, platform: process.platform, pages: result.pages, chunks: result.chunks.length, dimensions: 384, metrics: result.metrics }));
