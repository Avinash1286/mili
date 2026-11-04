import { createHash } from 'node:crypto';
import { SessionSchema, type Session } from '@milli/contracts';
import { StoreError, type Principal } from './types.js';
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function identifier(value: string, name = 'identifier') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(value)) throw new StoreError(400, 'INVALID_IDENTIFIER', `Invalid ${name}.`);
  return value;
}
export function normalizeSession(value: unknown): Session {
  const session = SessionSchema.parse(value);
  for (const node of session.board.nodes) node.author ??= 'student';
  for (const edge of session.board.edges) edge.author ??= 'student';
  for (const frame of session.board.frames ?? []) frame.author ??= 'student';
  session.board.revision ??= 0;
  return session;
}
export function assertPrincipal(principal: Principal, now: number) {
  if (!principal || !Number.isFinite(Date.parse(principal.expiresAt)) || Date.parse(principal.expiresAt) <= now) throw new StoreError(401, 'TOKEN_EXPIRED', 'Your session expired. Sign in or start a new guest session.');
  if (principal.hash !== principal.ownerId) throw new StoreError(401, 'UNAUTHORIZED', 'A valid session is required.');
}
export const notFound = () => new StoreError(404, 'NOT_FOUND', 'The requested item is not available.');
export const conflict = () => new StoreError(409, 'REVISION_CONFLICT', 'This item changed. Reload it and try again.');
export function boundedJson(value: unknown, maxBytes = 2_000_000): string {
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result) > maxBytes) throw new StoreError(413, 'RESOURCE_TOO_LARGE', 'This saved item is too large.');
  return result;
}
export function revision(value: number) { if (!Number.isSafeInteger(value) || value < -1) throw conflict(); return value; }
export function safeCode(value: string) { return /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'JOB_FAILED'; }
export function duration(value: number, min = 1000, max = 120000) { if (!Number.isInteger(value) || value < min || value > max) throw new StoreError(400, 'INVALID_LEASE', 'Invalid work lease.'); return value; }
