import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { SignJWT, importPKCS8 } from 'jose';
import { StoreError } from './types.js';
export type ConvexConnection = { url: string; privateKey: string; issuer?: string; keyId?: string };
export interface ConvexTransport { call<T>(kind: 'query' | 'mutation' | 'action', name: string, args: unknown): Promise<T>; }
export class ServiceTransport implements ConvexTransport {
  private client: ConvexHttpClient;
  private signingKey?: ReturnType<typeof importPKCS8>;
  private expiresAt = 0;
  constructor(private readonly config: ConvexConnection) {
    this.client = new ConvexHttpClient(config.url, { skipConvexDeploymentUrlCheck: true, logger: false,
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }),
    });
  }
  async call<T>(kind: 'query' | 'mutation' | 'action', name: string, args: unknown): Promise<T> {
    if (this.expiresAt < Date.now() + 30000) {
      const pem = this.config.privateKey.startsWith('-----') ? this.config.privateKey.replace(/\\n/g, '\n') : Buffer.from(this.config.privateKey, 'base64').toString('utf8');
      this.signingKey ??= importPKCS8(pem, 'RS256');
      const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.config.keyId ?? 'tokai-local-1' }).setIssuer(this.config.issuer ?? 'http://localhost:4000').setAudience('tokai-convex').setSubject('tokai-service').setIssuedAt().setExpirationTime('5m').sign(await this.signingKey);
      this.client.setAuth(token); this.expiresAt = Date.now() + 5 * 60000;
    }
    try {
      const values = JSON.parse(JSON.stringify(args));
      if (kind === 'query') return await this.client.query(makeFunctionReference<'query'>(name), values) as T;
      if (kind === 'mutation') return await this.client.mutation(makeFunctionReference<'mutation'>(name), values) as T;
      return await this.client.action(makeFunctionReference<'action'>(name), values) as T;
    } catch (error) {
      const data = error && typeof error === 'object' && 'data' in error ? (error as { data: any }).data : undefined;
      if (data && typeof data.code === 'string' && typeof data.status === 'number' && typeof data.message === 'string') throw new StoreError(data.status, data.code, data.message);
      throw new StoreError(503, 'DATABASE_UNAVAILABLE', 'Saved learning is temporarily unavailable. Please try again.');
    }
  }
  static fromEnv(env: Record<string, string | undefined>) {
    if (!env.CONVEX_URL || !env.TOKAI_SERVICE_PRIVATE_KEY) throw new Error('Local Convex configuration is incomplete.');
    return new ServiceTransport({ url: env.CONVEX_URL, privateKey: env.TOKAI_SERVICE_PRIVATE_KEY, issuer: env.TOKAI_SERVICE_ISSUER, keyId: env.TOKAI_SERVICE_KEY_ID });
  }
}
