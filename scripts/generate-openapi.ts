import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app.js';
import { generateOpenApi, type DocumentedRoute } from '../apps/api/src/openapi.js';
async function main() {
const directory = await mkdtemp(path.join(tmpdir(), 'tokai-contracts-')), routes: DocumentedRoute[] = [];
if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('tokai-contracts-')) throw new Error('Unexpected temporary contract directory.');
const app = await createApp({ dataDir: directory, env: {}, rateLimit: false, routeObserver: route => routes.push(route) });
try {
  await app.ready();
  const document = JSON.stringify(generateOpenApi(routes), null, 2) + '\n';
  const destination = path.resolve('docs/openapi.json');
  if (process.argv.includes('--check')) {
    if ((await readFile(destination, 'utf8')).replace(/\r\n/g, '\n') !== document) throw new Error('docs/openapi.json is stale. Run pnpm api:spec and commit the result.');
  } else await writeFile(destination, document);
  console.info(`OpenAPI ${process.argv.includes('--check') ? 'checked' : 'generated'} from registered routes and shared contracts; no provider requests made.`);
} finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'OpenAPI generation failed.'); process.exitCode = 1; });
