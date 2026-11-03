import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLegacyImport, applyLegacyImport, ServiceTransport } from '../../packages/db/src/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url)); loadEnvFile(path.join(root, '.env.local'));
const plan = await prepareLegacyImport(path.join(root, '.tokai'));
process.stdout.write(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', ...plan.counts, validated: true }) + '\n');
if (process.argv.includes('--apply')) {
  const result = await applyLegacyImport(plan, ServiceTransport.fromEnv(process.env));
  process.stdout.write(JSON.stringify({ imported: result.imported, skipped: result.skipped, backup: result.backup }) + '\n');
} else process.stdout.write('No records changed. Run with --apply after stopping the legacy FileStore API.\n');
