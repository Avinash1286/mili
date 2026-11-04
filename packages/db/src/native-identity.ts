import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { StoreError, type Principal } from './types.js';
import { ServiceTransport } from './transport.js';
export type NativeIdentity = { subject: string; sessionId: string; displayName: string; emailVerified: boolean; expiresAt: number };
export interface NativeIdentityProvider {
  verify(token: string): Promise<NativeIdentity>;
  active(identity: Pick<NativeIdentity, 'subject' | 'sessionId'>): Promise<boolean>;
  deleteAccount(principal: Principal): Promise<void>;
}
export class ConvexNativeIdentity implements NativeIdentityProvider {
  private service: ServiceTransport;
  constructor(private env: Record<string, string | undefined>) { this.service = ServiceTransport.fromEnv(env); }
  async verify(token: string): Promise<NativeIdentity> {
    if (!token || token.length > 20000) throw new StoreError(401, 'INVALID_LOGIN', 'Sign in again.');
    const client = new ConvexHttpClient(this.env.CONVEX_URL!, { skipConvexDeploymentUrlCheck: true, logger: false, auth: token,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) });
    try {
      const value = await client.query(makeFunctionReference<'query'>('nativeAuth:current'), {}) as NativeIdentity;
      if (!value || typeof value.subject !== 'string' || value.subject.length > 200 || typeof value.sessionId !== 'string' || value.sessionId.length > 200 || typeof value.displayName !== 'string' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error('Invalid identity');
      return value;
    } catch { throw new StoreError(401, 'INVALID_LOGIN', 'The account session could not be verified. Sign in again.'); }
  }
  active(identity: Pick<NativeIdentity, 'subject' | 'sessionId'>) { return this.service.call<boolean>('query', 'nativeAuth:sessionActive', { subject: identity.subject, sessionId: identity.sessionId }); }
  deleteAccount(principal: Principal) { return this.service.call<void>('mutation', 'nativeAuth:deleteAccount', { principal }); }
}
