import { nodeFileTrace } from '@vercel/nft';
import ts from 'typescript';
import { copyFile, lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url)), runtime = resolve(root, '.tokai-runtime');
if (relative(root, runtime) !== '.tokai-runtime') throw new Error('Invalid runtime output directory.');
const synced = spawnSync('pnpm', ['models:sync'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (synced.error || synced.status !== 0) process.exit(synced.status ?? 1);
const trace = await nodeFileTrace(['packages/grounding/src/child.ts', 'node_modules/tsx/dist/loader.mjs'], {
  base: root, processCwd: root, ts: true,
  readFile: async filename => {
    const bytes = await readFile(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EISDIR') return null; throw error; });
    if (bytes && /\.tsx?$/.test(filename) && !filename.endsWith('.d.ts')) return ts.transpileModule(bytes.toString('utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: filename }).outputText;
    return bytes;
  },
});
// Emscripten selects these WASM sidecars dynamically from the matching JS filename.
for (const name of [...trace.fileList]) if (name.includes('tesseract.js-core') && /\.js$/.test(name)) {
  const directory = dirname(resolve(root, name));
  for (const file of await readdir(directory)) if (file.endsWith('.wasm')) trace.fileList.add(relative(root, resolve(directory, file)));
}
const contained = (base: string, item: string) => { const name = relative(base, item); if (name.startsWith('..' + sep) || name === '..' || isAbsolute(name)) throw new Error('Runtime dependency escapes workspace.'); return name; };
await rm(runtime, { recursive: true, force: true }); await mkdir(runtime, { recursive: true });
let bytes = 0, count = 0;
// Native package emitters can add physical files without their pnpm resolution links.
const dependencyDirectories = new Set<string>();
for (const name of trace.fileList) {
  const segments = name.split(/[\\/]/);
  for (let index = 0; index < segments.length; index++) if (segments[index] === 'node_modules') dependencyDirectories.add(resolve(root, ...segments.slice(0, index + 1)));
}
for (const directory of dependencyDirectories) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const children = entry.name.startsWith('@') ? (await readdir(resolve(directory, entry.name))).map(name => resolve(directory, entry.name, name)) : [resolve(directory, entry.name)];
    for (const candidate of children) {
      if (!(await lstat(candidate)).isSymbolicLink()) continue;
      const target = resolve(dirname(candidate), await readlink(candidate)), prefix = contained(root, target) + sep;
      if ([...trace.fileList].some(name => name.startsWith(prefix))) trace.fileList.add(contained(root, candidate));
    }
  }
}
for (const name of [...trace.fileList].sort((a, b) => a.length - b.length)) {
  const from = resolve(root, name), to = resolve(runtime, contained(root, from)); contained(runtime, to);
  const info = await lstat(from); await mkdir(dirname(to), { recursive: true });
  if (info.isSymbolicLink()) {
    const actual = resolve(dirname(from), await readlink(from)), target = resolve(runtime, contained(root, actual));
    await symlink(process.platform === 'win32' ? target : relative(dirname(to), target), to, process.platform === 'win32' ? 'junction' : 'dir');
  } else if (info.isFile()) { await copyFile(from, to); bytes += info.size; count++; }
}
async function copyTree(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Model assets cannot be symbolic links.');
    const source = resolve(from, entry.name), destination = resolve(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination); else { await copyFile(source, destination); bytes += (await lstat(source)).size; count++; }
  }
}
await copyTree(resolve(root, '.tokai-models'), resolve(runtime, '.tokai-models'));
// PDF exports select fonts at runtime, outside the grounding child trace.
for (const [file, checksum] of [['NotoSans-Regular.ttf', 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'], ['NotoSansMath-Regular.ttf', '80b61fd613d3519197e64fff6f7e71fdc7f3e6526440ea4115b554ef7fd59af7']] as const) {
  const data = await readFile(resolve(root, 'content/fonts', file));
  if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error('PDF font checksum does not match the release asset.');
  await mkdir(resolve(runtime, 'content/fonts'), { recursive: true }); await writeFile(resolve(runtime, 'content/fonts', file), data); bytes += data.length; count++;
}
if (bytes > 4_000_000_000) throw new Error('The native runtime exceeds its 4GB packaging budget.');
await writeFile(resolve(runtime, 'manifest.json'), JSON.stringify({ version: 1, platform: process.platform, architecture: process.arch, files: count, bytes, warnings: trace.warnings.size }, null, 2));
console.info(JSON.stringify({ nativeBundle: true, files: count, bytes, traceWarnings: trace.warnings.size, note: 'Native execution verification is required; alternate-platform optional imports can produce trace warnings.' }));
const verified = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, 'infra/deploy/verify-native.ts')], { cwd: root, stdio: 'inherit' });
if (verified.error || verified.status !== 0) throw new Error('The packaged native runtime failed its actual OCR and embedding build check.');
