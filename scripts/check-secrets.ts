import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

// Never print matched content. Local credentials are compared in memory only.
async function main() {
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const known = new Map<string, string>();
const cloudFiles = (await readdir(path.join(root, '.tokai', 'cloud')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })).filter(name => /^[a-z0-9-]+\.env$/.test(name)).map(name => path.join('.tokai', 'cloud', name));
for (const name of ['.env', '.env.local', ...cloudFiles]) {
  let content: string;
  try { content = await readFile(path.join(root, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !/(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|DEPLOY_KEY)$/.test(match[1]!)) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 12 && !/^(?:replace|your[-_]|example|change[-_])/i.test(value)) known.set(`${match[1]!}@${path.basename(name)}`, value);
  }
}
const staged = process.argv.includes('--staged');
const manifestIndex = process.argv.indexOf('--manifest'), manifestFile = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
if (manifestIndex >= 0 && (!manifestFile || staged)) throw new Error('Choose either a deployment manifest or the staged index.');
const git = (args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 30 * 1024 * 1024 });
const names: string[] = manifestFile ? (JSON.parse(await readFile(path.resolve(root, manifestFile), 'utf8')) as { files: { path: string }[] }).files.map(item => item.path) : git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
const findings: { file: string; rule: string }[] = [];
for (const file of names) {
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Manifest path is outside the workspace.');
  if (manifestFile && /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.tokai(?:-models|-runtime)?|\.convex|\.vercel|\.git|node_modules|test-results|playwright-report|backups|coverage|\.next)(?:[\\/]|$)/.test(file)) { findings.push({ file, rule: 'private-or-generated-upload-path' }); continue; }
  if (manifestFile && (await lstat(path.join(root, file))).isDirectory()) continue;
  if (/(^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('.env.example')) { findings.push({ file, rule: 'private-environment-file' }); continue; }
  const content = staged ? git(['show', `:${file}`]) : await readFile(path.join(root, file));
  for (const [name, value] of known) if (content.includes(Buffer.from(value))) findings.push({ file, rule: `configured-${name}` });
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{30}/.test(content.toString('utf8'))) findings.push({ file, rule: 'private-key-material' });
}
console.info(JSON.stringify({ scope: manifestFile ? 'vercel-upload-manifest' : staged ? 'staged-index' : 'tracked-working-tree', files: names.length, configuredCredentials: known.size, findings }, null, 2));
if (findings.length) process.exitCode = 1;
}
void main().catch(() => { console.error('Secret scan could not complete. No credential values were printed.'); process.exitCode = 1; });
