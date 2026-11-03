import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)); loadEnvFile(path.join(root, '.env.local'));
if (!process.env.KEYCLOAK_ADMIN_PASSWORD) throw new Error('Run the local identity setup first.');
const home = path.join(root, '.tokai', 'tools', 'keycloak-26.8.1');
const command = path.join(home, 'bin', process.platform === 'win32' ? 'kc.bat' : 'kc.sh');
const environment: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'Path', 'PATHEXT', 'OS', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'JAVA_HOME']) if (process.env[key]) environment[key] = process.env[key];
Object.assign(environment, { KC_BOOTSTRAP_ADMIN_USERNAME: 'tokai-admin', KC_BOOTSTRAP_ADMIN_PASSWORD: process.env.KEYCLOAK_ADMIN_PASSWORD, JAVA_OPTS_APPEND: '-Xms64m -Xmx512m' });
const args = ['start-dev', '--http-host=127.0.0.1', '--http-port=8088', '--hostname=http://localhost:8088', '--import-realm'];
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], { cwd: home, env: environment, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit' })
  : spawn(command, args, { cwd: home, env: environment, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.stderr.write('Local identity server could not start. Check Java25 and the verified Keycloak archive.\n'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal); });
