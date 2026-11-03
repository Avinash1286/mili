import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
type Asset = { path: string; url: string; bytes: number; sha256: string };
async function main() {
  const root = resolve(__dirname, '..'), targetRoot = resolve(root, '.tokai-models');
  const manifest = JSON.parse(await readFile(resolve(root, 'content/models/learning-assets.json'), 'utf8')) as { assets: Asset[] };
  const check = process.argv.includes('--check');
  for (const asset of manifest.assets) {
    const target = resolve(targetRoot, asset.path);
    if (relative(targetRoot, target).startsWith('..') || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.bytes > 120_000_000) throw new Error('Invalid learning asset manifest.');
    const valid = (bytes: Uint8Array) => bytes.byteLength === asset.bytes && createHash('sha256').update(bytes).digest('hex') === asset.sha256;
    const existing = await readFile(target).catch(() => undefined);
    if (existing && valid(existing)) { console.info(`Verified ${asset.path}`); continue; }
    if (check) throw new Error(`Missing or changed ${asset.path}; run pnpm models:sync.`);
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || !['huggingface.co', 'raw.githubusercontent.com'].includes(url.hostname)) throw new Error('Unexpected model source.');
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Model download returned HTTP ${response.status}.`);
    const chunks: Uint8Array[] = [], reader = response.body.getReader(); let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > asset.bytes) throw new Error('Model download exceeded its pinned size.'); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks); if (!valid(bytes)) throw new Error(`Checksum mismatch for ${asset.path}.`);
    await mkdir(dirname(target), { recursive: true }); const temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, target); } finally { await rm(temp, { force: true }); }
    console.info(`Installed ${asset.path}`);
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Model installation failed.'); process.exitCode = 1; });
