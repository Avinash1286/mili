import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import type { SourceChunk } from '@tokai/db';
import type { SourceMime } from './content.js';
export * from './content.js';
export type ProcessingMetrics = { elapsedMs: number; peakRssBytes: number; cpuMs: number };

/** Terminated child process bounds parser/native-model work independently of the API event loop. */
function child<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Source processing cancelled.')); return; }
    const runtime = process.env.VERCEL ? resolvePath(process.cwd(), '.tokai-runtime') : undefined;
    const worker = fork(runtime ? resolvePath(runtime, 'packages/grounding/src/child.ts') : fileURLToPath(new URL('./child.ts', import.meta.url)), [], {
      ...(runtime ? { cwd: runtime } : {}),
      execArgv: ['--import', 'tsx', '--max-old-space-size=768'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','WINDIR','PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
    });
    let done = false;
    const finish = (error?: Error, result?: T) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.kill(); error ? reject(error) : resolve(result!); };
    const abort = () => finish(new Error('Source processing cancelled.'));
    const timer = setTimeout(() => finish(new Error('Document processing exceeded its two-minute limit. Split the source and retry.')), 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', () => finish(new Error('The document processing worker could not start.')));
    worker.once('exit', () => finish(new Error('The document processing worker stopped before completing.')));
    worker.once('message', (result: T & { error?: string }) => finish(result.error ? new Error(result.error) : undefined, result));
    worker.send(input);
  });
}
export function ingestSource(input: { bytes: Uint8Array; mime: SourceMime; sourceId: string; revision: number }, signal?: AbortSignal) {
  return child<{ pages: number; chunks: SourceChunk[]; metrics: ProcessingMetrics }>(input, signal);
}
export async function embedQuery(text: string, signal?: AbortSignal) { return (await child<{ embeddings: number[][] }>({ texts: [text.slice(0, 4000)] }, signal)).embeddings[0]!; }
