import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIsolatedConvex } from './isolated-convex';
import { ConvexStore, NativeObjectStore, ServiceTransport } from '../packages/db/src/index';
import { UsageMeter } from '../apps/api/src/usage';
import { lesson } from '../packages/db/test/fixtures';

async function main() {
  const isolated = await createIsolatedConvex({ name: 'usage-probe', cloudPort: 3216, sitePort: 3217 });
  try {
    const rates = { effectiveDate: '2026-11-04', models: { fixture: { inputPerMillion: 2, outputPerMillion: 8 } }, speechPerMillionCharacters: 10000, storagePerGiBDay: .1, egressPerGiB: .1 };
    const config = { TOKAI_OWNER_DAILY_USD: '0.04', TOKAI_GLOBAL_DAILY_USD: '0.05', TOKAI_STORAGE_MAX_RETENTION_DAYS: '30', TOKAI_USAGE_RATES_JSON: JSON.stringify(rates) };
    await writeFile(path.join(isolated.directory, 'budget.env'), Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n'));
    await isolated.command(['env', 'set', '--from-file', 'budget.env']);
    const env = { ...isolated.env, ...config, GEMINI_MODEL: 'fixture' }, transport = ServiceTransport.fromEnv(env), store = ConvexStore.fromEnv(env);
    const p = await store.authenticate((await store.createGuest()).token), q = await store.authenticate((await store.createGuest()).token);
    const modelLookup = async () => ({ model: 'fixture', inputTokenLimit: 10000, outputTokenLimit: 1000, verifiedAt: Date.now() });
    const a = new UsageMeter(store, env, Date.now, modelLookup), b = new UsageMeter(ConvexStore.fromEnv(env), env, Date.now, modelLookup);
    const attempts = await Promise.allSettled([a.begin(p, 'model', 1), b.begin(q, 'model', 1)]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    const loser = attempts.find(item => item.status === 'rejected') as PromiseRejectedResult; assert.equal(loser.reason.code, 'DAILY_USD_LIMIT');
    const winIndex = attempts.findIndex(item => item.status === 'fulfilled'), principal = winIndex === 0 ? p : q, other = winIndex === 0 ? q : p;
    const lease = (attempts[winIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof a.begin>>>).value;
    await assert.rejects(a.begin(principal, 'speech', 2), { code: 'DAILY_USD_LIMIT' });
    const independentOwner = await b.begin(other, 'speech', 2); await independentOwner.finish(true, 0);
    await lease.finish(true, 1, { models: ['fixture'], inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
    assert.equal((await a.summary(principal)).budget?.globalUsedUsd, .0028);
    await lease.finish(true, 0); assert.equal((await a.summary(principal)).budget?.globalUsedUsd, .0028);
    const failed = await b.begin(other, 'model', 1); await failed.finish(false);
    assert.equal((await a.summary(principal)).budget?.globalUsedUsd, .0308);
    await assert.rejects(a.begin(principal, 'speech', 2), { code: 'DAILY_USD_LIMIT' });
    const { principal: account } = await store.createUser({ issuer: 'urn:tokai:usage-probe', subject: randomUUID() });
    await store.claimGuest(principal, account);
    assert.equal((await a.summary(account)).budget?.ownerUsedUsd, .0028);
    assert.equal((await a.summary(account)).budget?.globalUsedUsd, .0308);
    const files = NativeObjectStore.fromEnv(env), value = lesson(); await store.create(account, value);
    const id = randomUUID(), bytes = Buffer.from('A private bounded storage fixture.\n'), checksum = createHash('sha256').update(bytes).digest('hex');
    await store.resources.put(account, 'source', id, { status: 'awaiting-upload', filename: 'fixture.txt', mimeType: 'text/plain', bytes: bytes.length, checksum }, { expectedRevision: -1 });
    await files.put(`source/${id}`, bytes, 'text/plain', { principal: account });
    const saved = await a.summary(account); assert.deepEqual(saved.storage, { bytes: bytes.length, objects: 1 });
    assert.equal(saved.kinds.find(item => item.kind === 'storage')?.totals.storageBytesWritten, bytes.length);
    const fetched = await files.get(`source/${id}`, { principal: account }); assert.equal(fetched.body.toString(), bytes.toString());
    const afterDownload = await a.summary(account); assert.equal(afterDownload.kinds.find(item => item.kind === 'egress')?.totals.egressBytesPrepared, bytes.length);
    await assert.rejects(files.get(`source/${id}`, { principal: other }), { status: 404 });
    await files.delete(`source/${id}`); assert.deepEqual((await a.summary(account)).storage, { bytes: 0, objects: 0 });
    const history = await a.summary(account); await store.deleteOwner(account); await assert.rejects(a.summary(account));
    assert.equal((await a.summary(other)).budget?.globalUsedUsd, history.budget?.globalUsedUsd);
    await isolated.command(['env', 'unset', 'TOKAI_USAGE_RATES_JSON']);
    await assert.rejects(a.begin(other, 'egress', 1), { code: 'USD_BOUND_UNAVAILABLE' });
    const report = { checkedAt: new Date().toISOString(), isolated: true, providerCalls: 0, atomicGlobalAdmission: true, ownerAdmission: true, exactSettlement: true, unknownFailureRetained: true, claimPreservesSpend: true, storageInventory: true, privateDownloadMetered: true, deletionPreservesGlobal: true, missingRatesFailClosed: true };
    await writeFile(path.join(isolated.directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await isolated.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Usage probe failed.'); process.exitCode = 1; });
