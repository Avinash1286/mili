import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)), target = path.join(root, '.env.local');
const original = await readFile(target, 'utf8'), values = new Map(original.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')] as const; }));
const additions: string[] = [];
function setMissing(name: string, value: string) { if (!values.get(name)) { values.set(name, value); additions.push(`${name}=${value}`); } }
setMissing('OIDC_ISSUER', 'http://localhost:8088/realms/tokai-local'); setMissing('OIDC_CLIENT_ID', 'tokai-web'); setMissing('OIDC_CLIENT_SECRET', randomBytes(32).toString('base64url')); setMissing('KEYCLOAK_ADMIN_PASSWORD', randomBytes(32).toString('base64url'));
if (values.get('OIDC_ISSUER') !== 'http://localhost:8088/realms/tokai-local') throw new Error('An existing OIDC issuer is configured; local setup will not replace it.');
if (additions.length) await writeFile(target, original.trimEnd() + '\n' + additions.join('\n') + '\n', { mode: 0o600 });
const directory = path.join(root, '.tokai', 'tools', 'keycloak-26.8.1', 'data', 'import'); await mkdir(directory, { recursive: true });
const realm = { realm: 'tokai-local', enabled: true, displayName: 'Tokai local accounts', sslRequired: 'none', registrationAllowed: true, resetPasswordAllowed: false, rememberMe: false, verifyEmail: false, loginWithEmailAllowed: true, duplicateEmailsAllowed: false,
  clients: [{ clientId: values.get('OIDC_CLIENT_ID'), name: 'Tokai local web', enabled: true, protocol: 'openid-connect', publicClient: false, secret: values.get('OIDC_CLIENT_SECRET'), standardFlowEnabled: true, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
    redirectUris: ['http://localhost:4000/auth/callback'], webOrigins: ['http://localhost:3000'], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': 'http://localhost:3000/*' } }] };
await writeFile(path.join(directory, 'tokai-local-realm.json'), JSON.stringify(realm, null, 2), { mode: 0o600 });
process.stdout.write('Local OIDC realm/client configuration is ready in ignored files. Account registration is available on the local identity server.\n');
