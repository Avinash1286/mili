import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Session } from '@milli/contracts';
import { StoreError, type Store, type Principal, type Resources, type Resource, type Outbox, type JobRecord, type MutationGuard, type Mutation, type StoredEvent, type DomainEvent, type Chunks, type VoiceTickets, type VoiceTicket } from './types.js';
import { assertPrincipal, boundedJson, conflict, duration, identifier, normalizeSession, notFound, revision, tokenHash } from './validation.js';
import { ServiceTransport, type ConvexConnection, type ConvexTransport } from './transport.js';
type BufferState = { principal?: Principal; ownerRevision?: number; operations: any[]; sessions: Map<string, Session | null>; resources: Map<string, Resource | null>; jobs: Map<string, JobRecord> };
export type ConvexStoreOptions = { transport: ConvexTransport; now?: () => number } | (ConvexConnection & { now?: () => number });
export class ConvexStore implements Store {
  readonly transport: ConvexTransport;
  readonly resources: Resources;
  readonly outbox: Outbox;
  readonly chunks: Chunks;
  readonly voiceTickets: VoiceTickets = {
    issue: async (principal, input) => { this.assertPrincipal(principal); await this.transport.call('mutation', 'tickets:issue', { principal, ...input }); },
    consumeAndAcquire: async (hash, leaseTtlMs = 30000) => {
      const result = await this.transport.call<VoiceTicket | { error: { status: number; code: string; message: string } }>('mutation', 'tickets:consume', { hash, leaseTtlMs: duration(leaseTtlMs) });
      if ('error' in result) throw new StoreError(result.error.status, result.error.code, result.error.message);
      return result;
    },
    revoke: async scope => { await this.transport.call('mutation', 'tickets:revoke', scope); }
  };
  private readonly now: () => number;
  private readonly transaction = new AsyncLocalStorage<BufferState>();
  private readonly localLocks = new Map<string, Promise<void>>();
  constructor(options: ConvexStoreOptions) { this.transport = 'transport' in options ? options.transport : new ServiceTransport(options); this.now = options.now ?? Date.now; this.resources = this.makeResources(); this.outbox = this.makeOutbox(); this.chunks = this.makeChunks(); }
  static fromEnv(env: Record<string, string | undefined>) { return new ConvexStore({ transport: ServiceTransport.fromEnv(env) }); }
  async initialize() { await this.transport.call('query', 'store:read', { operation: 'health', input: {} }); }
  async close() {}
  async health() { try { await this.initialize(); return true; } catch { return false; } }
  assertPrincipal(principal: Principal) { assertPrincipal(principal, this.now()); }
  private stamp() { return new Date(this.now()).toISOString(); }
  private async read<T>(operation: string, principal: Principal | undefined, input: unknown): Promise<T> {
    if (principal) this.assertPrincipal(principal);
    const result = await this.transport.call<{ value: T; ownerRevision?: number }>('query', 'store:read', { operation, principal, input });
    const transaction = this.transaction.getStore();
    if (transaction && principal && result.ownerRevision !== undefined) {
      if (transaction.principal && transaction.principal.ownerId !== principal.ownerId) throw new StoreError(500, 'MIXED_OWNER_TRANSACTION', 'A transaction cannot mix owners.');
      if (transaction.ownerRevision !== undefined && transaction.ownerRevision !== result.ownerRevision) throw conflict();
      transaction.principal = principal; transaction.ownerRevision = result.ownerRevision;
    }
    return result.value;
  }
  async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) return work();
    const previous = this.localLocks.get(key) ?? Promise.resolve(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }); this.localLocks.set(key, pending); await previous;
    const buffer: BufferState = { operations: [], sessions: new Map(), resources: new Map(), jobs: new Map() };
    try {
      const result = await this.transaction.run(buffer, work);
      if (buffer.operations.length) {
        if (!buffer.principal || buffer.ownerRevision === undefined) throw new StoreError(500, 'MISSING_TRANSACTION_OWNER', 'A transaction requires an authenticated owner.');
        await this.transport.call('mutation', 'store:commit', { principal: buffer.principal, ownerRevision: buffer.ownerRevision, operations: buffer.operations });
      }
      return result;
    } finally { release(); if (this.localLocks.get(key) === pending) this.localLocks.delete(key); }
  }
  private async stage(principal: Principal, operation: any) {
    const buffer = this.transaction.getStore(); if (!buffer) throw new StoreError(500, 'MISSING_TRANSACTION', 'A storage mutation requires a transaction.');
    if (buffer.ownerRevision === undefined) await this.read('version', principal, {});
    if (buffer.principal?.ownerId !== principal.ownerId) throw new StoreError(500, 'MIXED_OWNER_TRANSACTION', 'A transaction cannot mix owners.');
    boundedJson(operation, 900000); buffer.operations.push(structuredClone(operation));
  }
  async createGuest() {
    const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + 7 * 86400000;
    await this.transport.call('mutation', 'store:identity', { operation: 'guest', input: { ownerId: randomUUID(), authId: randomUUID(), tokenHash: tokenHash(token), expiresAt } });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }
  async authenticate(token: string | undefined) { if (!token || !/^[\w-]{43}$/.test(token)) throw new StoreError(401, 'UNAUTHORIZED', 'A valid session is required.'); return this.read<Principal>('authenticate', undefined, { tokenHash: tokenHash(token) }); }
  async principalForOwner(ownerId: string) { return this.read<Principal>('principalForOwner', undefined, { ownerId: identifier(ownerId) }); }
  async createUser(input: { issuer: string; subject: string; displayName?: string }) {
    if (!input.issuer || input.issuer.length > 500 || !input.subject || input.subject.length > 500) throw new StoreError(400, 'INVALID_IDENTITY', 'Invalid account identity.');
    const token = randomBytes(32).toString('base64url');
    const principal = await this.transport.call<Principal>('mutation', 'store:identity', { operation: 'user', input: { ...input, displayName: input.displayName?.slice(0, 80), ownerId: randomUUID(), authId: randomUUID(), tokenHash: tokenHash(token), expiresAt: this.now() + 7 * 86400000 } }); return { token, principal };
  }
  async revoke(principal: Principal) { await this.transport.call('mutation', 'store:identity', { operation: 'revoke', input: { principal } }); }
  async claimGuest(guest: Principal, user: Principal) { await this.transport.call('mutation', 'store:identity', { operation: 'claim', input: { principal: guest, user } }); }
  async deleteOwner(principal: Principal) { await this.transport.call('mutation', 'store:identity', { operation: 'delete', input: { principal } }); }
  async resolveShare(hash: string) { if (!/^[a-f0-9]{64}$/.test(hash)) return undefined; return await this.read<{ principal: Principal; record: Resource } | null>('resolveShare', undefined, { hash }) ?? undefined; }
  async assertJob(job: { id: string; workerId: string; fence: number }) {
    const current = await this.outbox.get(job.id); if (!current || current.state !== 'running' || current.workerId !== job.workerId || current.fence !== job.fence || Date.parse(current.lockedUntil ?? '') <= this.now()) throw new StoreError(409, 'JOB_LEASE_LOST', 'This worker no longer owns the job.');
    const principal = this.transaction.getStore()?.principal ?? await this.principalForOwner(current.ownerId);
    await this.locked(`job:${job.id}`, () => this.stage(principal, { type: 'job.guard', job }));
  }
  async get(principal: Principal, id: string): Promise<Session> {
    this.assertPrincipal(principal); identifier(id); const buffer = this.transaction.getStore();
    if (buffer?.principal && buffer.principal.ownerId !== principal.ownerId) throw notFound();
    if (buffer?.sessions.has(id)) { const value = buffer.sessions.get(id); if (!value) throw notFound(); return normalizeSession(value); }
    const value = normalizeSession(await this.read('session', principal, { id })); buffer?.sessions.set(id, value); return normalizeSession(value);
  }
  async list(principal: Principal): Promise<Session[]> {
    const values = (await this.read<Session[]>('sessions', principal, {})).map(normalizeSession), buffer = this.transaction.getStore();
    const byId = new Map(values.map(value => [value.id, value])); for (const [id, value] of buffer?.sessions ?? []) { if (value) byId.set(id, normalizeSession(value)); else byId.delete(id); }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async create(principal: Principal, session: Session) { await this.locked(session.id, async () => { const value = normalizeSession(session); await this.stage(principal, { type: 'session.create', session: value }); this.transaction.getStore()!.sessions.set(value.id, value); }); }
  async save(principal: Principal, session: Session, guard: MutationGuard = {}) {
    await this.locked(session.id, async () => { const previous = await this.get(principal, session.id), value = normalizeSession(session); if (previous.revision !== (guard.expectedRevision ?? value.revision - 1) || value.revision !== previous.revision + 1) throw conflict(); await this.stage(principal, { type: 'session.save', session: value, expectedRevision: previous.revision, lease: guard.lease }); this.transaction.getStore()!.sessions.set(value.id, value); });
  }
  async delete(principal: Principal, id: string) { await this.locked(id, async () => { await this.get(principal, id); await this.stage(principal, { type: 'session.delete', id }); this.transaction.getStore()!.sessions.set(id, null); }); }
  async mutate<T>(principal: Principal, id: string, guard: MutationGuard, reduce: (session: Session) => Mutation<T>): Promise<T> {
    return this.locked(id, async () => {
      const current = await this.get(principal, id);
      if (guard.idempotencyKey) { if (!guard.requestHash) throw new StoreError(400, 'MISSING_REQUEST_HASH', 'An idempotent request requires a hash.'); const prior = await this.read<any>('receipt', principal, { id, key: identifier(guard.idempotencyKey) }); if (prior) { if (prior.hash !== guard.requestHash) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'That request identifier was already used.'); return prior.result as T; } }
      if (guard.expectedRevision !== undefined && current.revision !== guard.expectedRevision) throw conflict();
      const change = reduce(current); if (change && typeof (change as any).then === 'function') throw new StoreError(500, 'ASYNC_REDUCER', 'Persistence reducers must be synchronous.');
      await this.save(principal, change.session, guard); for (const event of change.events ?? []) await this.appendEvent(principal, id, event); for (const intent of change.jobs ?? []) await this.outbox.enqueue(principal, intent);
      if (guard.idempotencyKey) await this.stage(principal, { type: 'receipt', id, key: guard.idempotencyKey, hash: guard.requestHash, result: change.result }); return change.result;
    });
  }
  async appendEvent(principal: Principal, id: string, event: DomainEvent) { await this.locked(id, async () => { await this.get(principal, id); identifier(event.id); identifier(event.type); await this.stage(principal, { type: 'event', id, event }); }); }
  async events(principal: Principal, id: string, after = 0, limit = 100) { return this.read<StoredEvent[]>('events', principal, { id, after, limit }); }
  async nextFence(key: string, ttlMs: number) { return this.transport.call<number>('mutation', 'store:fence', { operation: 'next', key: identifier(key), ttlMs: duration(ttlMs) }); }
  async acquireFence(key: string, ttlMs: number) { const fence = await this.transport.call<number | null>('mutation', 'store:fence', { operation: 'acquire', key: identifier(key), ttlMs: duration(ttlMs) }); if (fence === null) throw new StoreError(409, 'VOICE_ACTIVE', 'An active connection already owns this lesson.'); return fence; }
  async fenceActive(key: string) { return this.read<boolean>('fenceActive', undefined, { key: identifier(key) }); }
  async renewFence(key: string, fence: number, ttlMs: number) { return this.transport.call<boolean>('mutation', 'store:fence', { operation: 'renew', key: identifier(key), fence, ttlMs: duration(ttlMs) }); }
  async releaseFence(key: string, fence: number) { await this.transport.call('mutation', 'store:fence', { operation: 'release', key: identifier(key), fence }); }
  private makeResources(): Resources {
    const keyOf = (p: Principal, kind: string, id: string) => `${p.ownerId}:${kind}:${id}`;
    return {
      get: async <T>(p: Principal, kind: string, id: string): Promise<Resource<T>> => {
        identifier(kind); identifier(id); const buffer = this.transaction.getStore(), key = keyOf(p, kind, id);
        if (buffer?.resources.has(key)) { const item = buffer.resources.get(key); if (!item) throw notFound(); if (item.sessionId) await this.get(p, item.sessionId); return structuredClone(item) as Resource<T>; }
        const value = await this.read<Resource<T>>('resource', p, { kind, id }); buffer?.resources.set(key, value); return structuredClone(value);
      },
      list: async <T>(p: Principal, kind: string, options: { sessionId?: string; limit?: number } = {}): Promise<Resource<T>[]> => {
        const values = await this.read<Resource<T>[]>('resources', p, { kind: identifier(kind), ...options }), map = new Map(values.map(value => [value.id, value]));
        for (const [key, value] of this.transaction.getStore()?.resources ?? []) { if (!key.startsWith(`${p.ownerId}:${kind}:`)) continue; if (value && (!options.sessionId || value.sessionId === options.sessionId)) map.set(value.id, structuredClone(value) as Resource<T>); else if (!value) map.delete(key.slice(`${p.ownerId}:${kind}:`.length)); }
        return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(1000, options.limit ?? 100));
      },
      put: async <T>(p: Principal, kind: string, id: string, data: T, options: { expectedRevision: number; sessionId?: string }): Promise<Resource<T>> => this.locked(`resource:${id}`, async () => {
        identifier(kind); identifier(id); revision(options.expectedRevision); boundedJson(data, 850000); if (options.sessionId) await this.get(p, options.sessionId);
        const old = options.expectedRevision >= 0 ? await this.resources.get<T>(p, kind, id) : undefined;
        if (old && (old.revision !== options.expectedRevision || options.sessionId !== undefined && old.sessionId !== options.sessionId)) throw conflict();
        const value: Resource<T> = { id, kind, ownerId: p.ownerId, sessionId: old?.sessionId ?? options.sessionId, revision: options.expectedRevision + 1, data: structuredClone(data), createdAt: old?.createdAt ?? this.stamp(), updatedAt: this.stamp() };
        await this.stage(p, { type: 'resource.put', kind, id, data, ...options }); this.transaction.getStore()!.resources.set(keyOf(p, kind, id), value); return structuredClone(value);
      }),
      delete: async (p, kind, id) => this.locked(`resource:${id}`, async () => { await this.resources.get(p, kind, id); await this.stage(p, { type: 'resource.delete', kind, id }); this.transaction.getStore()!.resources.set(keyOf(p, kind, id), null); })
    };
  }
  private makeOutbox(): Outbox {
    return {
      enqueue: async (p, intent) => this.locked(`job:${intent.id}`, async () => {
        identifier(intent.id); identifier(intent.kind); if (Boolean(intent.resourceId) !== Boolean(intent.resourceKind)) throw new StoreError(400, 'INVALID_JOB', 'A resource job requires kind and ID.');
        if (intent.sessionId) await this.get(p, intent.sessionId); if (intent.resourceId) { const value = await this.resources.get(p, intent.resourceKind!, intent.resourceId); if (intent.expectedRevision !== undefined && intent.expectedRevision !== value.revision) throw conflict(); }
        const previous = await this.outbox.get(intent.id);
        if (previous) { for (const key of ['ownerId', 'kind', 'sessionId', 'resourceKind', 'resourceId', 'expectedRevision'] as const) if (previous[key] !== (key === 'ownerId' ? p.ownerId : intent[key])) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'That job identifier was already used.'); return previous; }
        const value: JobRecord = { ...intent, ownerId: p.ownerId, state: 'pending', attempts: 0, fence: 0, availableAt: intent.availableAt ?? this.stamp(), createdAt: this.stamp(), updatedAt: this.stamp() };
        await this.stage(p, { type: 'job', intent }); this.transaction.getStore()!.jobs.set(intent.id, value); return value;
      }),
      get: async id => this.transaction.getStore()?.jobs.get(id) ?? await this.read<JobRecord | null>('job', undefined, { id }) ?? undefined,
      claim: async (workerId, limit = 10, leaseMs = 30000) => this.transport.call('mutation', 'store:jobControl', { operation: 'claim', input: { workerId, limit, leaseMs } }),
      renew: async (id, workerId, fence, leaseMs = 30000) => this.transport.call('mutation', 'store:jobControl', { operation: 'renew', input: { jobId: id, workerId, fence, leaseMs } }),
      complete: async (id, workerId, fence) => { await this.transport.call('mutation', 'store:jobControl', { operation: 'complete', input: { jobId: id, workerId, fence } }); },
      fail: async (id, workerId, fence, failure) => { await this.transport.call('mutation', 'store:jobControl', { operation: 'fail', input: { jobId: id, workerId, fence, ...failure } }); }
    };
  }
  private makeChunks(): Chunks {
    return {
      replace: async (p, sourceId, sourceRevision, chunks) => this.locked(`source:${sourceId}`, async () => {
        const source = await this.resources.get(p, 'source', sourceId); if (source.revision !== sourceRevision) throw conflict();
        if (chunks.length > 150 || new Set(chunks.map(c => c.id)).size !== chunks.length || chunks.some(c => c.sourceId !== sourceId || c.revision !== sourceRevision || !c.text || c.text.length > 12000 || c.embedding && (c.embedding.length !== 384 || c.embedding.some(n => !Number.isFinite(n))))) throw new StoreError(400, 'INVALID_CHUNKS', 'Invalid source chunks.');
        for (let offset = 0; offset < Math.max(1, chunks.length); offset += 10) await this.stage(p, { type: offset === 0 ? 'chunks.replace' : 'chunks.append', sourceId, sourceRevision, chunks: chunks.slice(offset, offset + 10) });
      }),
      search: async (p, input) => {
        if (!input.sourceIds.length || input.sourceIds.length > 20) throw new StoreError(400, 'INVALID_SOURCE_FILTER', 'Choose one to twenty sources.');
        if (input.embedding) { const result = await this.transport.call<{ value: any[] }>('action', 'store:vectorSearch', { principal: p, sourceIds: input.sourceIds, embedding: input.embedding, limit: input.limit }); return result.value; }
        if (!input.text || input.text.length > 2000) throw new StoreError(400, 'INVALID_SEARCH', 'A bounded search query is required.');
        return this.read('chunks', p, input);
      },
      delete: async (p, sourceId) => this.locked(`source:${sourceId}`, async () => { await this.resources.get(p, 'source', sourceId); await this.stage(p, { type: 'chunks.delete', sourceId }); })
    };
  }
}
export type Lease = { key: string; token: string; fence: number; ttlMs: number };
export class ConvexLeaseManager {
  constructor(private readonly transport: ConvexTransport) {}
  async acquire(key: string, ttlMs = 15000): Promise<Lease | undefined> { const token = randomBytes(24).toString('base64url'), fence = await this.transport.call<number | null>('mutation', 'store:fence', { operation: 'acquire', key: identifier(key), token, ttlMs: duration(ttlMs) }); return fence === null ? undefined : { key, token, fence, ttlMs }; }
  async renew(lease: Lease) { return this.transport.call<boolean>('mutation', 'store:fence', { operation: 'renew', ...lease }); }
  async release(lease: Lease) { await this.transport.call('mutation', 'store:fence', { operation: 'release', ...lease }); }
}
