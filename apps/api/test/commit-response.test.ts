import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileStore, StoreError } from '@tokai/db';
import { createApp } from '../src/app.js';
import { VoiceManager } from '../src/voice.js';

it('does not acknowledge lesson creation when the outer transaction commit fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-commit-response-'));
  class FailingCommitStore extends FileStore {
    override async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
      const value = await super.locked(key, work);
      if (key.startsWith('owner:')) throw new StoreError(409, 'REVISION_CONFLICT', 'A concurrent commit changed this owner.');
      return value;
    }
  }
  const store = new FailingCommitStore(directory), app = await createApp({ store, dataDir: directory, env: {}, rateLimit: false });
  try {
    const { token } = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json();
    const result = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { authorization: `Bearer ${token}` }, payload: { topic: 'fractions', mode: 'sample' } });
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe('REVISION_CONFLICT');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('never broadcasts board or map mutations whose final commit rejects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-commit-events-')); let reject = false;
  class FailingCommitStore extends FileStore {
    override async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
      const value = await super.locked(key, work);
      if (reject) throw new StoreError(409, 'REVISION_CONFLICT', 'A concurrent commit changed this owner.');
      return value;
    }
  }
  const store = new FailingCommitStore(directory), app = await createApp({ store, dataDir: directory, env: {}, rateLimit: false });
  const publish = vi.spyOn(VoiceManager.prototype, 'publishBoard');
  try {
    const { token } = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json(), headers = { authorization: `Bearer ${token}` };
    const { session } = (await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: { topic: 'fractions', mode: 'sample' } })).json();
    reject = true;
    const board = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers, payload: { operationId: 'commit-order', expectedRevision: session.board.revision ?? 0, commands: [{ type: 'upsert_node', node: { id: 'test-note', label: 'Private unsaved note', detail: '', kind: 'detail', x: 0, y: 0 } }] } });
    expect(board.statusCode, board.body).toBe(409); expect(publish).not.toHaveBeenCalled();
    const map = await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/map`, headers, payload: { expectedRevision: session.conceptMap?.revision ?? 0, mode: 'merge', topicId: session.topic, nodes: [], edges: [] } });
    expect(map.statusCode, map.body).toBe(409); expect(publish).not.toHaveBeenCalled();
  } finally { publish.mockRestore(); reject = false; await app.close(); await rm(directory, { recursive: true, force: true }); }
});
