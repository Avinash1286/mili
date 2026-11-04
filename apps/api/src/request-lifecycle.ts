import type { FastifyInstance, FastifyRequest } from 'fastify';

const requests = new WeakMap<FastifyRequest, AbortController>();
/** Signals client departure after body receipt as well as during upload. */
export function requestSignal(request: FastifyRequest): AbortSignal {
  const controller = requests.get(request);
  if (!controller) throw new Error('Request cancellation is not initialized.');
  return controller.signal;
}
export function registerRequestLifecycle(app: FastifyInstance) {
  const active = new Set<AbortController>();
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController(); requests.set(request, controller); active.add(controller);
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); active.delete(controller); };
    reply.raw.once('close', close);
    reply.raw.once('finish', () => { reply.raw.off('close', close); active.delete(controller); });
  });
  app.addHook('preClose', async () => { for (const controller of active) controller.abort(); active.clear(); });
}
