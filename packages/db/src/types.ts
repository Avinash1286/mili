import type { Session } from '@milli/contracts';

export class StoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'StoreError'; }
}
/** hash is a compatibility alias of the stable ownerId, never an OIDC token. */
export type Principal = { ownerId: string; hash: string; kind: 'guest' | 'user'; authSessionId: string; expiresAt: string; internal?: true };
export type Resource<T = unknown> = { id: string; kind: string; ownerId: string; sessionId?: string; revision: number; data: T; createdAt: string; updatedAt: string };
export type ResourceWrite = { expectedRevision: number; sessionId?: string };
export interface Resources {
  get<T = unknown>(principal: Principal, kind: string, id: string): Promise<Resource<T>>;
  list<T = unknown>(principal: Principal, kind: string, options?: { sessionId?: string; limit?: number }): Promise<Resource<T>[]>;
  put<T>(principal: Principal, kind: string, id: string, data: T, options: ResourceWrite): Promise<Resource<T>>;
  delete(principal: Principal, kind: string, id: string): Promise<void>;
}
export type DomainEvent = { id: string; type: string; data?: unknown };
export type StoredEvent = DomainEvent & { sequence: number; ownerId: string; sessionId: string; createdAt: string };
/** Queue envelopes contain identifiers and revision metadata, not uploaded text or credentials. */
export type JobIntent = { id: string; kind: string; sessionId?: string; resourceKind?: string; resourceId?: string; expectedRevision?: number; availableAt?: string };
export type JobRecord = JobIntent & { ownerId: string; state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; attempts: number; fence: number; workerId?: string; lockedUntil?: string; code?: string; createdAt: string; updatedAt: string };
export interface Outbox {
  enqueue(principal: Principal, intent: JobIntent): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | undefined>;
  claim(workerId: string, limit?: number, leaseMs?: number): Promise<JobRecord[]>;
  renew(id: string, workerId: string, fence: number, leaseMs?: number): Promise<boolean>;
  complete(id: string, workerId: string, fence: number): Promise<void>;
  fail(id: string, workerId: string, fence: number, failure: { retryAt?: string; code: string }): Promise<void>;
}
export type MutationGuard = { expectedRevision?: number; lease?: { key: string; fence: number }; idempotencyKey?: string; requestHash?: string };
export type Mutation<T> = { session: Session; result: T; events?: DomainEvent[]; jobs?: JobIntent[] };
export type SourceChunk = { id: string; sourceId: string; revision: number; ordinal: number; text: string; page?: number; anchor?: string; embedding?: number[] };
export type SearchHit = Omit<SourceChunk, 'embedding'> & { score: number };
export type VoiceTicket = { principal: Principal; sessionId: string; expiresAt: number; fence: number };
export interface VoiceTickets {
  issue(principal: Principal, input: { hash: string; sessionId: string; expiresAt: number }): Promise<void>;
  consumeAndAcquire(hash: string, leaseTtlMs?: number): Promise<VoiceTicket>;
  revoke(scope: { ownerId?: string; sessionId?: string }): Promise<void>;
}
export interface Chunks {
  replace(principal: Principal, sourceId: string, sourceRevision: number, chunks: SourceChunk[]): Promise<void>;
  search(principal: Principal, input: { sourceIds: string[]; text?: string; embedding?: number[]; limit?: number }): Promise<SearchHit[]>;
  delete(principal: Principal, sourceId: string): Promise<void>;
}
export interface Store {
  readonly resources: Resources;
  readonly outbox: Outbox;
  readonly chunks: Chunks;
  readonly voiceTickets: VoiceTickets;
  initialize(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<boolean>;
  createGuest(): Promise<{ token: string; expiresAt: string }>;
  authenticate(token: string | undefined): Promise<Principal>;
  assertPrincipal(principal: Principal): void;
  principalForOwner(ownerId: string): Promise<Principal>;
  createUser(input: { issuer: string; subject: string; displayName?: string }): Promise<{ token: string; principal: Principal }>;
  revoke(principal: Principal): Promise<void>;
  claimGuest(guest: Principal, user: Principal): Promise<void>;
  deleteOwner(principal: Principal): Promise<void>;
  resolveShare(tokenHash: string): Promise<{ principal: Principal; record: Resource } | undefined>;
  assertJob(job: { id: string; workerId: string; fence: number }): Promise<void>;
  get(principal: Principal, id: string): Promise<Session>;
  list(principal: Principal): Promise<Session[]>;
  create(principal: Principal, session: Session): Promise<void>;
  save(principal: Principal, session: Session, guard?: MutationGuard): Promise<void>;
  delete(principal: Principal, id: string): Promise<void>;
  /** Only DB operations and pure reducers belong inside this short transaction. */
  locked<T>(key: string, work: () => Promise<T>): Promise<T>;
  mutate<T>(principal: Principal, id: string, guard: MutationGuard, reduce: (session: Session) => Mutation<T>): Promise<T>;
  events(principal: Principal, id: string, after?: number, limit?: number): Promise<StoredEvent[]>;
  appendEvent(principal: Principal, id: string, event: DomainEvent): Promise<void>;
  nextFence(key: string, ttlMs: number): Promise<number>;
  acquireFence(key: string, ttlMs: number): Promise<number>;
  fenceActive(key: string): Promise<boolean>;
  renewFence(key: string, fence: number, ttlMs: number): Promise<boolean>;
  releaseFence(key: string, fence: number): Promise<void>;
}
