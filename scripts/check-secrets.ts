import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Never print matched content. Local credentials are compared in memory only.
async function main() {
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const known = new Map<string, string>();
for (const name of ['.env', '.env.local']) {
  let content: string;
  try { content = await readFile(path.join(root, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !/(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY)$/.test(match[1]!)) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 12 && !/^(?:replace|your[-_]|example|change[-_])/i.test(value)) known.set(match[1]!, value);
  }
}
const staged = process.argv.includes('--staged');
const git = (args: string[]) => execFileSync('git', args, { cwd: root, maxBuffer: 30 * 1024 * 1024 });
const names = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
const findings: { file: string; rule: string }[] = [];
for (const file of names) {
  if (/(^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('.env.example')) { findings.push({ file, rule: 'private-environment-file' }); continue; }
  const content = staged ? git(['show', `:${file}`]) : await readFile(path.join(root, file));
  for (const [name, value] of known) if (content.includes(Buffer.from(value))) findings.push({ file, rule: `configured-${name}` });
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{30}/.test(content.toString('utf8'))) findings.push({ file, rule: 'private-key-material' });
}
console.info(JSON.stringify({ scope: staged ? 'staged-index' : 'tracked-working-tree', files: names.length, configuredCredentials: known.size, findings }, null, 2));
if (findings.length) process.exitCode = 1;
}
void main().catch(() => { console.error('Secret scan could not complete. No credential values were printed.'); process.exitCode = 1; });
