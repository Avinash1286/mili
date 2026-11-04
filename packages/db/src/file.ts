import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '@milli/contracts';
import { StoreError, type Store, type Principal, type Resources, type Resource, type Outbox, type JobRecord, type MutationGuard, type Mutation, type StoredEvent, type DomainEvent, type Chunks, type SourceChunk, type VoiceTickets } from './types.js';
import { assertPrincipal, boundedJson, conflict, duration, identifier, normalizeSession, notFound, revision, safeCode, tokenHash } from './validation.js';
type Owner = { id: string; kind: 'guest' | 'user'; expiresAt?: string; deletedAt?: string; issuer?: string; subject?: string };
type Auth = { id: string; ownerId: string; tokenHash: string; expiresAt: string; revoked?: boolean };
type FileState = { version: 1; owners: Owner[]; auth: Auth[]; sessions: { ownerId: string; session: Session; deleted?: boolean }[]; resources: (Resource & { deleted?: boolean })[]; jobs: JobRecord[]; events: StoredEvent[]; receipts: { ownerId: string; sessionId: string; key: string; hash: string; result: unknown }[]; fences: { key: string; fence: number; expiresAt: number }[]; chunks: (SourceChunk & { ownerId: string })[]; voiceTickets: { hash: string; principal: Principal; sessionId: string; sessionRevision: number; expiresAt: number }[] };
const empty = (): FileState => ({ version: 1, owners: [], auth: [], sessions: [], resources: [], jobs: [], events: [], receipts: [], fences: [], chunks: [], voiceTickets: [] });
const week = 7 * 86400000;
/** Explicit single-process compatibility adapter. Full local mode uses Convex. */
export class FileStore implements Store {
  private state = empty();
  private queue = Promise.resolve();
  private transaction = new AsyncLocalStorage<boolean>();
  readonly resources: Resources;
  readonly outbox: Outbox;
  readonly chunks: Chunks;
  readonly voiceTickets: VoiceTickets = {
    issue: async (principal, input) => this.locked('voice-tickets', async () => {
      this.authorize(principal); const lesson = await this.get(principal, input.sessionId);
      if (principal.internal || !/^[a-f0-9]{64}$/.test(input.hash) || input.expiresAt <= this.now() || input.expiresAt > this.now() + 60000 || input.expiresAt > Date.parse(principal.expiresAt)) throw new StoreError(400, 'INVALID_TICKET', 'Invalid voice ticket.');
      if (lesson.mode !== 'live' || lesson.status !== 'active') throw new StoreError(409, 'LIVE_REQUIRED', 'An active live lesson is required.');
      this.state.voiceTickets = this.state.voiceTickets.filter(ticket => ticket.expiresAt > this.now() && ticket.principal.ownerId !== principal.ownerId);
      this.state.voiceTickets.push({ ...input, principal, sessionRevision: lesson.revision });
    }),
    consumeAndAcquire: async (hash, leaseTtlMs = 30000) => {
      duration(leaseTtlMs);
      const result = await this.locked('voice-tickets', async () => {
        const index = this.state.voiceTickets.findIndex(ticket => ticket.hash === hash), ticket = this.state.voiceTickets[index];
        if (ticket) this.state.voiceTickets.splice(index, 1);
        const invalid = new StoreError(401, 'INVALID_TICKET', 'The voice ticket expired, changed or was already used.');
        if (!ticket || ticket.expiresAt <= this.now()) return invalid;
        try {
          const lesson = await this.get(ticket.principal, ticket.sessionId);
          if (lesson.revision !== ticket.sessionRevision || lesson.status !== 'active' || lesson.mode !== 'live') return invalid;
        } catch { return invalid; }
        if (await this.fenceActive(`voice:${ticket.principal.ownerId}`)) return new StoreError(409, 'VOICE_ACTIVE', 'An active connection already owns this lesson.');
        const fence = await this.nextFence(`voice:${ticket.principal.ownerId}`, leaseTtlMs);
        return { principal: ticket.principal, sessionId: ticket.sessionId, expiresAt: ticket.expiresAt, fence };
      });
      if (result instanceof StoreError) throw result;
      return result;
    },
    revoke: async scope => this.locked('voice-tickets', async () => {
      if (!scope.ownerId && !scope.sessionId) throw new StoreError(400, 'INVALID_SCOPE', 'A ticket scope is required.');
      this.state.voiceTickets = this.state.voiceTickets.filter(ticket => !(scope.ownerId === undefined || scope.ownerId === ticket.principal.ownerId) || !(scope.sessionId === undefined || scope.sessionId === ticket.sessionId));
    })
  };
  constructor(public readonly directory: string, private readonly now: () => number = Date.now) { this.resources = this.makeResources(); this.outbox = this.makeOutbox(); this.chunks = this.makeChunks(); }
  private stamp() { return new Date(this.now()).toISOString(); }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try { this.state = JSON.parse(await readFile(path.join(this.directory, 'database.json'), 'utf8')) as FileState; if (this.state.version !== 1) throw new Error('Unsupported file database version.'); this.state.voiceTickets ??= []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.importLegacy(); await this.persist(); }
  }
  private async importLegacy() {
    const entries = async (directory: string) => readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    for (const name of await entries(path.join(this.directory, 'guests'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const old = JSON.parse(await readFile(path.join(this.directory, 'guests', name), 'utf8')) as { expiresAt: string }, hash = name.slice(0, -5);
      if (!Number.isFinite(Date.parse(old.expiresAt))) throw new Error('Invalid legacy guest record; import left unchanged.');
      this.state.owners.push({ id: hash, kind: 'guest', expiresAt: old.expiresAt }); this.state.auth.push({ id: hash, ownerId: hash, tokenHash: hash, expiresAt: old.expiresAt });
    }
    for (const name of await entries(path.join(this.directory, 'sessions'))) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const old = JSON.parse(await readFile(path.join(this.directory, 'sessions', name), 'utf8')) as { ownerHash: string; session: unknown };
      if (!this.state.owners.some(owner => owner.id === old.ownerHash)) throw new Error('Legacy lesson owner is missing; import left unchanged.');
      this.state.sessions.push({ ownerId: old.ownerHash, session: normalizeSession(old.session) });
    }
  }
  private async persist() {
    const target = path.join(this.directory, 'database.json'), temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async close() { await this.queue; }
  async health() { return true; }
  async locked<T>(_key: string, work: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) return work();
    const previous = this.queue; let release!: () => void; this.queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    const backup = structuredClone(this.state);
    try { const result = await this.transaction.run(true, work); await this.persist(); return result; }
    catch (error) { this.state = backup; throw error; }
    finally { release(); }
  }
  assertPrincipal(principal: Principal) { assertPrincipal(principal, this.now()); }
  private authorize(principal: Principal) {
    this.assertPrincipal(principal);
    const owner = this.state.owners.find(value => value.id === principal.ownerId && !value.deletedAt);
    if (!owner || owner.expiresAt && Date.parse(owner.expiresAt) <= this.now() || !principal.internal && !this.state.auth.some(auth => auth.id === principal.authSessionId && auth.ownerId === owner.id && !auth.revoked && Date.parse(auth.expiresAt) > this.now())) throw new StoreError(401, 'UNAUTHORIZED', 'A valid session is required.');
    return owner;
  }
  async createGuest() {
    return this.locked('guests', async () => {
      const token = randomBytes(32).toString('base64url'), id = randomUUID(), expiresAt = new Date(this.now() + week).toISOString();
      this.state.owners.push({ id, kind: 'guest', expiresAt }); this.state.auth.push({ id: randomUUID(), ownerId: id, tokenHash: tokenHash(token), expiresAt }); return { token, expiresAt };
    });
  }
  async authenticate(token: string | undefined) {
    if (!token || !/^[\w-]{43}$/.test(token)) throw new StoreError(401, 'UNAUTHORIZED', 'A valid session is required.');
    const auth = this.state.auth.find(value => value.tokenHash === tokenHash(token));
    if (!auth) throw new StoreError(401, 'UNAUTHORIZED', 'A valid session is required.');
    const owner = this.state.owners.find(value => value.id === auth.ownerId)!;
    const principal: Principal = { ownerId: owner.id, hash: owner.id, kind: owner.kind, authSessionId: auth.id, expiresAt: auth.expiresAt }; this.authorize(principal); return principal;
  }
  async principalForOwner(ownerId: string): Promise<Principal> {
    const owner = this.state.owners.find(value => value.id === ownerId && !value.deletedAt); if (!owner) throw notFound();
    const principal: Principal = { ownerId, hash: ownerId, kind: owner.kind, authSessionId: '', expiresAt: owner.expiresAt ?? new Date(this.now() + week).toISOString(), internal: true }; this.authorize(principal); return principal;
  }
  async createUser(input: { issuer: string; subject: string; displayName?: string }) {
    return this.locked('identities', async () => {
      if (!input.issuer || !input.subject) throw new StoreError(400, 'INVALID_IDENTITY', 'Invalid account identity.');
      let owner = this.state.owners.find(value => value.issuer === input.issuer && value.subject === input.subject);
      if (owner?.deletedAt) throw new StoreError(410, 'ACCOUNT_DELETED', 'This account has been deleted.');
      if (!owner) { owner = { id: randomUUID(), kind: 'user', issuer: input.issuer, subject: input.subject }; this.state.owners.push(owner); }
      const token = randomBytes(32).toString('base64url'), auth = { id: randomUUID(), ownerId: owner.id, tokenHash: tokenHash(token), expiresAt: new Date(this.now() + week).toISOString() }; this.state.auth.push(auth);
      return { token, principal: await this.authenticate(token) };
    });
  }
  async revoke(principal: Principal) { await this.locked('auth', async () => { this.authorize(principal); const auth = this.state.auth.find(value => value.id === principal.authSessionId); if (auth) auth.revoked = true; }); }
  async claimGuest(guest: Principal, user: Principal) {
    await this.locked('claim', async () => {
      this.authorize(guest); this.authorize(user); if (guest.kind !== 'guest' || user.kind !== 'user') throw new StoreError(400, 'INVALID_CLAIM', 'Only a guest can be claimed by an account.');
      this.state.resources = this.state.resources.filter(item => !(item.ownerId === guest.ownerId && item.kind === 'preferences' && this.state.resources.some(value => value.ownerId === user.ownerId && value.kind === 'preferences' && value.id === user.ownerId)));
      for (const item of this.state.resources.filter(value => value.ownerId === guest.ownerId)) { if (item.kind === 'preferences' && item.id === guest.ownerId) item.id = user.ownerId; if (this.state.resources.some(value => value.ownerId === user.ownerId && value.id === item.id && value.kind === item.kind)) throw conflict(); }
      for (const items of [this.state.sessions, this.state.resources, this.state.jobs, this.state.events, this.state.receipts, this.state.chunks]) for (const item of items) if (item.ownerId === guest.ownerId) item.ownerId = user.ownerId;
      this.state.owners.find(value => value.id === guest.ownerId)!.deletedAt = this.stamp(); for (const auth of this.state.auth) if (auth.ownerId === guest.ownerId) auth.revoked = true;
    });
  }
  async deleteOwner(principal: Principal) { await this.locked('delete-owner', async () => { const owner = this.authorize(principal); owner.deletedAt = this.stamp(); for (const auth of this.state.auth) if (auth.ownerId === owner.id) auth.revoked = true; for (const session of this.state.sessions) if (session.ownerId === owner.id) session.deleted = true; for (const item of this.state.resources) if (item.ownerId === owner.id) item.deleted = true; for (const job of this.state.jobs) if (job.ownerId === owner.id && ['pending', 'running'].includes(job.state)) job.state = 'cancelled'; this.state.chunks = this.state.chunks.filter(value => value.ownerId !== owner.id); }); }
  async resolveShare(hash: string) { if (!/^[a-f0-9]{64}$/.test(hash)) return undefined; const row = this.state.resources.find(value => value.kind === 'share' && value.id === hash && !value.deleted); const data = row?.data as { expiresAt?: string; revoked?: boolean } | undefined; if (!row || data?.revoked !== false || !data.expiresAt || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= this.now()) return undefined; try { const principal = await this.principalForOwner(row.ownerId); return { principal, record: await this.resources.get(principal, 'share', hash) }; } catch { return undefined; } }
  async assertJob(job: { id: string; workerId: string; fence: number }) { const item = this.state.jobs.find(value => value.id === job.id && value.workerId === job.workerId && value.fence === job.fence && value.state === 'running' && Date.parse(value.lockedUntil ?? '') > this.now()); if (!item) throw new StoreError(409, 'JOB_LEASE_LOST', 'This worker no longer owns the job.'); const p = await this.principalForOwner(item.ownerId); if (item.sessionId) await this.get(p, item.sessionId); if (item.resourceId) await this.resources.get(p, item.resourceKind!, item.resourceId); }
  async get(principal: Principal, id: string) { this.authorize(principal); const record = this.state.sessions.find(value => value.ownerId === principal.ownerId && value.session.id === id && !value.deleted); if (!record) throw notFound(); return normalizeSession(record.session); }
  async list(principal: Principal) { this.authorize(principal); return this.state.sessions.filter(value => value.ownerId === principal.ownerId && !value.deleted).map(value => normalizeSession(value.session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async create(principal: Principal, session: Session) { await this.locked(session.id, async () => { this.authorize(principal); if (this.state.sessions.some(value => value.session.id === session.id)) throw conflict(); this.state.sessions.push({ ownerId: principal.ownerId, session: normalizeSession(session) }); }); }
  private checkFence(guard: MutationGuard) { if (guard.lease && !this.state.fences.some(value => value.key === guard.lease!.key && value.fence === guard.lease!.fence && value.expiresAt > this.now())) throw new StoreError(409, 'LEASE_LOST', 'This connection no longer owns the lesson.'); }
  async save(principal: Principal, session: Session, guard: MutationGuard = {}) { await this.locked(session.id, async () => { const current = await this.get(principal, session.id); this.checkFence(guard); if (current.revision !== (guard.expectedRevision ?? session.revision - 1) || session.revision !== current.revision + 1) throw conflict(); this.state.sessions.find(value => value.session.id === session.id)!.session = normalizeSession(session); }); }
  async delete(principal: Principal, id: string) { await this.locked(id, async () => { await this.get(principal, id); this.state.sessions.find(value => value.session.id === id)!.deleted = true; for (const resource of this.state.resources) if (resource.ownerId === principal.ownerId && resource.sessionId === id) resource.deleted = true; for (const job of this.state.jobs) if (job.ownerId === principal.ownerId && job.sessionId === id && ['pending', 'running'].includes(job.state)) job.state = 'cancelled'; this.state.chunks = this.state.chunks.filter(chunk => !this.state.resources.some(value => value.ownerId === principal.ownerId && value.kind === 'source' && value.sessionId === id && value.id === chunk.sourceId)); }); }
  async mutate<T>(principal: Principal, id: string, guard: MutationGuard, reduce: (session: Session) => Mutation<T>): Promise<T> {
    return this.locked(id, async () => {
      const current = await this.get(principal, id); this.checkFence(guard);
      if (guard.idempotencyKey) { if (!guard.requestHash) throw new StoreError(400, 'MISSING_REQUEST_HASH', 'A request hash is required.'); const prior = this.state.receipts.find(value => value.ownerId === principal.ownerId && value.sessionId === id && value.key === guard.idempotencyKey); if (prior) { if (prior.hash !== guard.requestHash) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'That request identifier was already used.'); return structuredClone(prior.result) as T; } }
      if (guard.expectedRevision !== undefined && current.revision !== guard.expectedRevision) throw conflict();
      const change = reduce(current); if (change && typeof (change as any).then === 'function') throw new StoreError(500, 'ASYNC_REDUCER', 'Persistence reducers must be synchronous.');
      await this.save(principal, change.session, guard); for (const event of change.events ?? []) await this.appendEvent(principal, id, event); for (const intent of change.jobs ?? []) await this.outbox.enqueue(principal, intent);
      if (guard.idempotencyKey) this.state.receipts.push({ ownerId: principal.ownerId, sessionId: id, key: guard.idempotencyKey, hash: guard.requestHash!, result: structuredClone(change.result) }); return change.result;
    });
  }
  async appendEvent(principal: Principal, id: string, event: DomainEvent) { await this.locked(id, async () => { await this.get(principal, id); if (!this.state.events.some(value => value.ownerId === principal.ownerId && value.sessionId === id && value.id === event.id)) this.state.events.push({ ...structuredClone(event), ownerId: principal.ownerId, sessionId: id, sequence: this.state.events.length + 1, createdAt: this.stamp() }); }); }
  async events(principal: Principal, id: string, after = 0, limit = 100) { await this.get(principal, id); return structuredClone(this.state.events.filter(value => value.ownerId === principal.ownerId && value.sessionId === id && value.sequence > after).slice(0, Math.min(500, limit))); }
  async nextFence(key: string, ttlMs: number) { return this.locked('fences', async () => { let value = this.state.fences.find(item => item.key === key); if (!value) { value = { key, fence: 0, expiresAt: 0 }; this.state.fences.push(value); } value.fence++; value.expiresAt = this.now() + duration(ttlMs); return value.fence; }); }
  async acquireFence(key: string, ttlMs: number) { return this.locked('fences', async () => { if (await this.fenceActive(key)) throw new StoreError(409, 'VOICE_ACTIVE', 'An active connection already owns this lesson.'); return this.nextFence(key, ttlMs); }); }
  async fenceActive(key: string) { return this.state.fences.some(value => value.key === key && value.expiresAt > this.now()); }
  async renewFence(key: string, fence: number, ttlMs: number) { return this.locked('fences', async () => { const item = this.state.fences.find(value => value.key === key && value.fence === fence && value.expiresAt > this.now()); if (!item) return false; item.expiresAt = this.now() + duration(ttlMs); return true; }); }
  async releaseFence(key: string, fence: number) { await this.locked('fences', async () => { const item = this.state.fences.find(value => value.key === key && value.fence === fence); if (item) item.expiresAt = this.now(); }); }
  private makeResources(): Resources {
    return {
      get: async <T>(p: Principal, kind: string, id: string): Promise<Resource<T>> => { this.authorize(p); const value = this.state.resources.find(value => value.ownerId === p.ownerId && value.kind === kind && value.id === id && !value.deleted); if (!value) throw notFound(); if (value.sessionId) await this.get(p, value.sessionId); const { deleted: _, ...result } = structuredClone(value); return result as Resource<T>; },
      list: async <T>(p: Principal, kind: string, options: { sessionId?: string; limit?: number } = {}): Promise<Resource<T>[]> => { this.authorize(p); if (options.sessionId) await this.get(p, options.sessionId); const result: Resource<T>[] = []; for (const value of this.state.resources.filter(value => value.ownerId === p.ownerId && value.kind === kind && !value.deleted && (!options.sessionId || value.sessionId === options.sessionId))) { try { result.push(await this.resources.get<T>(p, kind, value.id)); } catch (error) { if (!(error instanceof StoreError && error.status === 404)) throw error; } } return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(1000, options.limit ?? 100)); },
      put: async <T>(p: Principal, kind: string, id: string, data: T, options: { expectedRevision: number; sessionId?: string }): Promise<Resource<T>> => this.locked('resources', async () => {
        this.authorize(p); identifier(kind); identifier(id); revision(options.expectedRevision); boundedJson(data); if (options.sessionId) await this.get(p, options.sessionId);
        const value = this.state.resources.find(value => value.ownerId === p.ownerId && value.kind === kind && value.id === id);
        if (value) { if (value.deleted) throw notFound(); if (value.sessionId) await this.get(p, value.sessionId); if (value.revision !== options.expectedRevision || options.sessionId !== undefined && options.sessionId !== value.sessionId) throw conflict(); value.data = structuredClone(data); value.revision++; value.updatedAt = this.stamp(); return structuredClone(value) as Resource<T>; }
        if (options.expectedRevision !== -1) throw notFound(); const created: Resource<T> = { id, kind, ownerId: p.ownerId, sessionId: options.sessionId, data: structuredClone(data), revision: 0, createdAt: this.stamp(), updatedAt: this.stamp() }; this.state.resources.push(created); return structuredClone(created);
      }),
      delete: async (p, kind, id) => this.locked('resources', async () => { await this.resources.get(p, kind, id); this.state.resources.find(value => value.ownerId === p.ownerId && value.kind === kind && value.id === id)!.deleted = true; for (const job of this.state.jobs) if (job.ownerId === p.ownerId && job.resourceKind === kind && job.resourceId === id && ['pending', 'running'].includes(job.state)) job.state = 'cancelled'; if (kind === 'source') this.state.chunks = this.state.chunks.filter(value => value.ownerId !== p.ownerId || value.sourceId !== id); })
    };
  }
  private makeOutbox(): Outbox {
    const failResource = (item: JobRecord) => {
      if (!['source', 'artifact'].includes(item.resourceKind ?? '') || !item.resourceId || item.expectedRevision === undefined) return;
      const record = this.state.resources.find(value => value.ownerId === item.ownerId && value.kind === item.resourceKind && value.id === item.resourceId && !value.deleted);
      const data = record?.data as Record<string, unknown> | undefined;
      if (!record || record.revision !== item.expectedRevision || !data || !['queued', 'processing', 'running'].includes(String(data.status))) return;
      record.revision++; record.updatedAt = this.stamp(); record.data = { ...data, status: 'failed', revision: record.revision, updatedAt: record.updatedAt, error: 'Background processing could not finish after bounded retries. Retry this item.' };
    };
    const valid = async (item: JobRecord) => { try { const p = await this.principalForOwner(item.ownerId); if (item.sessionId) await this.get(p, item.sessionId); if (item.resourceId) await this.resources.get(p, item.resourceKind!, item.resourceId); return true; } catch { return false; } };
    const owned = async (id: string, workerId: string, fence: number) => { const item = this.state.jobs.find(value => value.id === id && value.workerId === workerId && value.fence === fence && value.state === 'running' && Date.parse(value.lockedUntil ?? '') > this.now()); if (!item || !await valid(item)) throw new StoreError(409, 'JOB_LEASE_LOST', 'This worker no longer owns the job.'); return item; };
    return {
      enqueue: async (p, intent) => this.locked('outbox', async () => { this.authorize(p); identifier(intent.id); identifier(intent.kind); if (intent.sessionId) await this.get(p, intent.sessionId); if (Boolean(intent.resourceId) !== Boolean(intent.resourceKind)) throw new StoreError(400, 'INVALID_JOB', 'A resource job requires a kind and identifier.'); if (intent.resourceId) { const r = await this.resources.get(p, intent.resourceKind!, intent.resourceId); if (intent.expectedRevision !== undefined && r.revision !== intent.expectedRevision) throw conflict(); } const prior = this.state.jobs.find(value => value.id === intent.id); if (prior) { if (prior.ownerId !== p.ownerId || prior.kind !== intent.kind || prior.sessionId !== intent.sessionId || prior.resourceKind !== intent.resourceKind || prior.resourceId !== intent.resourceId || prior.expectedRevision !== intent.expectedRevision) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'That job identifier was already used.'); return structuredClone(prior); } const item: JobRecord = { ...intent, ownerId: p.ownerId, state: 'pending', attempts: 0, fence: 0, availableAt: intent.availableAt ?? this.stamp(), createdAt: this.stamp(), updatedAt: this.stamp() }; this.state.jobs.push(item); return structuredClone(item); }),
      get: async id => structuredClone(this.state.jobs.find(value => value.id === id)),
      claim: async (workerId, limit = 10, leaseMs = 30000) => this.locked('outbox', async () => { duration(leaseMs); const result: JobRecord[] = []; for (const item of this.state.jobs) { if (!['pending', 'running'].includes(item.state)) continue; if (!await valid(item)) { item.state = 'cancelled'; continue; } if (Date.parse(item.availableAt!) > this.now() || item.state === 'running' && Date.parse(item.lockedUntil!) > this.now()) continue; if (item.attempts >= 3) { item.state = 'failed'; item.code = 'RETRY_LIMIT'; item.workerId = undefined; item.lockedUntil = undefined; item.updatedAt = this.stamp(); failResource(item); continue; } item.attempts++; item.fence++; item.state = 'running'; item.workerId = workerId; item.lockedUntil = new Date(this.now() + leaseMs).toISOString(); item.updatedAt = this.stamp(); result.push(structuredClone(item)); if (result.length >= Math.min(100, Math.max(1, limit))) break; } return result; }),
      renew: async (id, workerId, fence, leaseMs = 30000) => this.locked('outbox', async () => { try { const item = await owned(id, workerId, fence); item.lockedUntil = new Date(this.now() + duration(leaseMs)).toISOString(); return true; } catch (error) { if (error instanceof StoreError && error.code === 'JOB_LEASE_LOST') return false; throw error; } }),
      complete: async (id, workerId, fence) => this.locked('outbox', async () => { const item = await owned(id, workerId, fence); item.state = 'completed'; item.lockedUntil = undefined; item.updatedAt = this.stamp(); }),
      fail: async (id, workerId, fence, failure) => this.locked('outbox', async () => { const item = await owned(id, workerId, fence); if (failure.retryAt && !Number.isFinite(Date.parse(failure.retryAt))) throw new StoreError(400, 'INVALID_JOB', 'Invalid retry schedule.'); item.state = failure.retryAt && item.attempts < 3 ? 'pending' : 'failed'; item.availableAt = failure.retryAt ?? item.availableAt; item.lockedUntil = undefined; item.workerId = undefined; item.code = safeCode(failure.code); item.updatedAt = this.stamp(); if (item.state === 'failed') failResource(item); })
    };
  }
  private makeChunks(): Chunks {
    return {
      replace: async (p, sourceId, sourceRevision, chunks) => this.locked('chunks', async () => { const source = await this.resources.get(p, 'source', sourceId); if (source.revision !== sourceRevision) throw conflict(); if (chunks.length > 2000 || chunks.some(chunk => chunk.sourceId !== sourceId || chunk.revision !== sourceRevision || !chunk.text || chunk.text.length > 12000)) throw new StoreError(400, 'INVALID_CHUNKS', 'Invalid source chunks.'); this.state.chunks = this.state.chunks.filter(value => value.ownerId !== p.ownerId || value.sourceId !== sourceId); this.state.chunks.push(...structuredClone(chunks).map(value => ({ ...value, ownerId: p.ownerId }))); }),
      search: async (p, input) => { this.authorize(p); if (!input.sourceIds.length || input.sourceIds.length > 20) throw new StoreError(400, 'INVALID_SOURCE_FILTER', 'Choose one to twenty sources.'); for (const id of input.sourceIds) await this.resources.get(p, 'source', id); if (input.embedding) throw new StoreError(503, 'VECTOR_REQUIRES_CONVEX', 'Vector search requires the Convex local backend.'); const terms = (input.text ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean); return this.state.chunks.filter(value => value.ownerId === p.ownerId && input.sourceIds.includes(value.sourceId)).map(({ embedding: _, ownerId: __, ...value }) => ({ ...value, score: terms.filter(term => value.text.toLocaleLowerCase().includes(term)).length / Math.max(1, terms.length) })).filter(value => value.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(20, input.limit ?? 8)); },
      delete: async (p, sourceId) => this.locked('chunks', async () => { await this.resources.get(p, 'source', sourceId); this.state.chunks = this.state.chunks.filter(value => value.ownerId !== p.ownerId || value.sourceId !== sourceId); })
    };
  }
}
