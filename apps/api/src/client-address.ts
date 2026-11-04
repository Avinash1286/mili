import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Vercel overwrites X-Forwarded-For; other runtimes trust only the socket. */
export function clientAddress(request: Pick<FastifyRequest, 'headers' | 'ip'>, vercel: boolean): string {
  const value = request.headers['x-forwarded-for'];
  if (vercel && typeof value === 'string' && value.length <= 64 && isIP(value.trim())) return value.trim();
  return request.ip;
}
