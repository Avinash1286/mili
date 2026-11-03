import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const envPath = path.join(root, '.env.local');
const text = await readFile(envPath, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
const entries = new Map(text.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')] as const; }));
const additions: string[] = [];
const setMissing = (name: string, value: string) => { if (!entries.get(name)) { entries.set(name, value); additions.push(`${name}=${value}`); } };
if (!entries.get('TOKAI_SERVICE_PRIVATE_KEY')) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...publicKey, kid: 'tokai-local-1', alg: 'RS256', use: 'sig' }] };
  setMissing('TOKAI_SERVICE_PRIVATE_KEY', Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'));
  setMissing('TOKAI_SERVICE_JWKS', Buffer.from(JSON.stringify(jwks)).toString('base64'));
}
setMissing('CONVEX_URL', 'http://127.0.0.1:3210'); setMissing('TOKAI_SERVICE_ISSUER', 'http://localhost:4000'); setMissing('TOKAI_SERVICE_KEY_ID', 'tokai-local-1');
setMissing('TOKAI_JOB_SECRET', randomBytes(32).toString('base64url')); setMissing('SESSION_SECRET', randomBytes(32).toString('base64url')); setMissing('INTERNAL_API_URL', 'http://127.0.0.1:4000');
if (!entries.get('TOKAI_SERVICE_JWKS')) throw new Error('Private service key exists without its matching public JWKS. Restore both configuration values together.');
if (additions.length) await writeFile(envPath, text.trimEnd() + '\n' + additions.join('\n') + '\n', { mode: 0o600 });
await mkdir(path.join(root, '.tokai'), { recursive: true });
const backendNames = ['TOKAI_SERVICE_JWKS', 'TOKAI_SERVICE_ISSUER', 'TOKAI_JOB_SECRET', 'INTERNAL_API_URL'];
await writeFile(path.join(root, '.tokai', 'convex.env'), backendNames.map(name => `${name}=${entries.get(name)!}`).join('\n') + '\n', { mode: 0o600 });
process.stdout.write('Local Convex service credentials are ready in ignored files. No existing provider settings were changed.\n');
