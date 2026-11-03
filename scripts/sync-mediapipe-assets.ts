import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type Asset = { path: string; bytes: number; sha256: string; kind: 'package' | 'model' | 'license'; source: string; packagePath?: string };
type Manifest = { schemaVersion: number; package: { name: string; version: string; license: string }; model: { license: string; licenseNote: string }; files: Asset[] };
const root = resolve(__dirname, '..'), publicRoot = resolve(root, 'apps/web/public/vendor/mediapipe'), packageRoot = resolve(root, 'apps/web/node_modules/@mediapipe/tasks-vision');
function within(base: string, path: string) {
  const destination = resolve(base, path), rel = relative(base, destination);
  if (!rel || isAbsolute(path) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Unsafe asset path: ${path}`);
  return destination;
}
function verify(bytes: Uint8Array, asset: Asset) {
  if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`${asset.path}: checksum or byte count does not match the pinned manifest.`);
}
async function download(asset: Asset) {
  const url = new URL(asset.source);
  if (url.protocol !== 'https:' || !['storage.googleapis.com', 'raw.githubusercontent.com'].includes(url.hostname)) throw new Error(`Unexpected source for ${asset.path}.`);
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: 'error', credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error(`${asset.path}: upstream returned HTTP ${response.status}.`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength; if (count > asset.bytes) throw new Error(`${asset.path}: upstream exceeded the pinned byte count.`); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks); verify(bytes, asset); return bytes;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--sync'].includes(arg)) || (args.includes('--check') && args.includes('--sync'))) throw new Error('Usage: pnpm exec tsx scripts/sync-mediapipe-assets.ts [--check | --sync]');
  const sync = args.includes('--sync'), manifest = JSON.parse(await readFile(resolve(publicRoot, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.package.name !== '@mediapipe/tasks-vision' || manifest.package.version !== '1.2.0') throw new Error('Unexpected MediaPipe manifest version.');
  const installed = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as { name: string; version: string; license: string };
  if (installed.name !== manifest.package.name || installed.version !== manifest.package.version || installed.license !== manifest.package.license) throw new Error('Install the pinned MediaPipe package with pnpm install --frozen-lockfile before syncing or checking.');
  for (const asset of manifest.files) {
    const destination = within(publicRoot, asset.path);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid manifest identity: ${asset.path}`);
    let source: Buffer | undefined;
    if (asset.kind === 'package') {
      if (!asset.packagePath) throw new Error(`Missing package path for ${asset.path}`);
      source = await readFile(within(packageRoot, asset.packagePath)); verify(source, asset);
    }
    if (sync) {
      const bytes = source ?? await download(asset); verify(bytes, asset);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, destination); }
      finally { await rm(temporary, { force: true }); }
    }
    verify(await readFile(destination), asset);
    process.stdout.write(`Verified ${asset.path} (${asset.bytes} bytes)\n`);
  }
  process.stdout.write(`${manifest.files.length} pinned assets verified${sync ? ' after sync' : ' offline'}. Runtime license: ${manifest.package.license}; model weight license: ${manifest.model.license}.\n`);
  if (manifest.model.license === 'NOASSERTION') process.stdout.write('Model license evidence remains explicitly unresolved; see NOTICE.txt. Verification does not grant distribution rights.\n');
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'MediaPipe asset verification failed.'}\n`); process.exitCode = 1; });
