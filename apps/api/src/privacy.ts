import type { Artifact, Session, StudyPack } from '@milli/contracts';
import type { Principal } from '@milli/db';
import type { ArtifactFile } from './artifact-routes.js';
import { optionalResource, type ProductContext } from './product-context.js';

/** Synchronous metadata revocation in the caller's transaction; byte deletion follows commit. */
export async function revokeSavedTranscript(context: ProductContext, p: Principal, session: Session): Promise<string[]> {
  const { store, now } = context, files: string[] = [];
  session.messages = []; session.teachingBeats = [];
  const study = await optionalResource<StudyPack>(store, p, 'study-pack', session.id);
  if (study) await store.resources.put(p, 'study-pack', session.id, { ...study.data, completedNarration: [], partialNarration: [], recap: { text: '', status: 'not-requested', completedBeatIds: [] } }, { expectedRevision: study.revision, sessionId: session.id });
  for (const artifact of await store.resources.list<Artifact>(p, 'artifact', { sessionId: session.id, limit: 100 })) if (['recap', 'study-pack', 'export'].includes(artifact.data.kind)) {
    const file = await optionalResource<ArtifactFile>(store, p, 'artifact-file', artifact.id); if (file) files.push(file.data.storageKey);
    await store.resources.put(p, 'artifact', artifact.id, { ...artifact.data, status: 'failed', revision: artifact.data.revision + 1, updatedAt: now(), error: 'Transcript retention was disabled. Regenerate a reference-only artifact.', captions: undefined, durationMs: undefined }, { expectedRevision: artifact.revision, sessionId: session.id });
  }
  return files;
}
