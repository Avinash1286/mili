import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLegacyImport, ConvexStore } from '../../packages/db/src/index.js';
const root = fileURLToPath(new URL('../../', import.meta.url)); loadEnvFile(path.join(root, '.env.local'));
const store = ConvexStore.fromEnv(process.env), plan = await prepareLegacyImport(path.join(root, '.tokai'));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
let verified = 0;
for (const { batch } of plan.batches) {
  if (batch.owner.deletedAt !== undefined || batch.owner.expiresAt !== undefined && batch.owner.expiresAt <= Date.now()) continue;
  const principal = await store.principalForOwner(batch.owner.id);
  for (const old of batch.sessions) {
    if (old.deletedAt !== undefined) continue; const current = await store.get(principal, old.id);
    if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(old.snapshot))) throw new Error('An imported lesson differs from its validated legacy snapshot.'); verified++;
  }
}
process.stdout.write(JSON.stringify({ verifiedLegacySessions: verified, exactSnapshotMatch: true }) + '\n');
