import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url)), args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1], target = option('--environment'), project = option('--project'), scope = option('--scope');
if (!['preview', 'production'].includes(target) || !/^prj_[A-Za-z0-9]+$/.test(project) || !/^[a-z0-9-]+$/.test(scope)) throw new Error('Explicit environment, project ID and team scope are required.');
const content = await readFile(resolve(root, '.tokai/cloud', `${target}-api.env`), 'utf8');
const variables: { key: string; value: string; type: 'sensitive' | 'plain'; target: string[] }[] = [];
for (const line of content.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); if (!match) continue;
  const name = match[1]!, value = match[2]!.startsWith('"') ? JSON.parse(match[2]!) : match[2]!;
  const sensitive = /(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|DEPLOY_KEY)$/.test(name);
  variables.push({ key: name, value, type: sensitive ? 'sensitive' : 'plain', target: [target] });
}
async function add(item: typeof variables[number]) {
  const call = [resolve(root, 'node_modules/vercel/dist/index.js'), 'env', 'add', item.key, '--environment', target, '--project', project, '--scope', scope, '--yes', item.type === 'sensitive' ? '--sensitive' : '--no-sensitive'];
  if (args.includes('--replace')) call.push('--force');
  await new Promise<void>((done, reject) => {
    // Official CLI credential handling, no shell interpolation or value logging.
    const child = spawn(process.execPath, call, { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000); });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Could not configure ${item.key}: ${diagnostic.replaceAll(item.value, '[redacted]').slice(-600)}`)));
    child.stdin.end(item.value);
  });
  console.info(`Configured ${target} variable ${item.key}.`);
}
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => { while (next < variables.length) { const item = variables[next++]!; await add(item); } }));
