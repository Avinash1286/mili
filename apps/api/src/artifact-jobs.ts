import { randomUUID } from 'node:crypto';
import { ArtifactSchema, AssessmentDefinitionSchema, LearningCardSchema, LearningSourceRefSchema, StudyPackSchema, type Artifact, type AssessmentDefinition, type LearningCard, type LearningSourceRef, type Session, type Source, type StudyPack } from '@milli/contracts';
import { StoreError, type JobRecord, type Principal, type Resource } from '@milli/db';
import { buildStudyPack, createCardSchedule, instantiatePackCards } from '@milli/learning';
import { createSynthesizer, TTS_SAMPLE_RATE, type Synthesizer, type SynthesisBoundaries } from '@milli/speech';
import { generateAssessment, generateLearningCards, generateRecapDialogue, type RecapDialogue } from '@milli/tutor-core/learning';
import { TUTOR_VOICES } from '@milli/contracts';
import { liveModels, liveModelsConfigured } from './live-models.js';
import { authoredPack, bumpSession, optionalResource, metered, type AttemptRecord, type ProductContext } from './product-context.js';
import { pcmToWav, renderArtifactExport, renderCardsJson, type ArtifactBytes } from './artifact-export.js';
import type { ArtifactFile } from './artifact-routes.js';

type LearningSnapshot = { attempts: Resource<AttemptRecord>[]; cards: Resource<LearningCard>[]; assessments: Resource<AssessmentDefinition>[]; study?: Resource<StudyPack> };
const fingerprint = (records: Resource[]) => JSON.stringify(records.map(record => [record.id, record.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
async function snapshot(context: ProductContext, p: Principal, sessionId: string): Promise<LearningSnapshot> {
  const [attempts, cards, assessments, study] = await Promise.all([
    context.store.resources.list<AttemptRecord>(p, 'attempt', { sessionId, limit: 200 }),
    context.store.resources.list<LearningCard>(p, 'card', { sessionId, limit: 200 }),
    context.store.resources.list<AssessmentDefinition>(p, 'assessment', { sessionId, limit: 30 }),
    optionalResource<StudyPack>(context.store, p, 'study-pack', sessionId),
  ]); return { attempts, cards, assessments, study };
}
export async function sources(context: ProductContext, p: Principal, session: Session): Promise<{ refs: LearningSourceRef[]; resources: Resource<Source>[] }> {
  const references: LearningSourceRef[] = [], resources = new Map<string, Resource<Source>>();
  for (const citation of (session.citations ?? []).slice(-80)) {
    const source = resources.get(citation.sourceId) ?? await optionalResource<Source>(context.store, p, 'source', citation.sourceId);
    if (!source || source.data.status !== 'ready' || source.revision !== citation.sourceVersion) continue;
    resources.set(source.id, source);
    references.push(LearningSourceRefSchema.parse({ sourceId: source.id, sourceVersion: String(source.revision), title: source.data.title, ...(citation.page ? { page: citation.page } : {}), ...(citation.section ? { section: citation.section } : {}), chunkId: citation.chunkId, snippet: citation.snippet.slice(0, 500) }));
  }
  return { refs: references, resources: [...resources.values()] };
}
function makeStudyPack(session: Session, records: LearningSnapshot, cards: LearningCard[], refs: LearningSourceRef[], now: string): StudyPack {
  return buildStudyPack({ session, pack: authoredPack(session), attempts: records.attempts.map(item => ({ attempt: item.data.attempt, evaluation: item.data.evaluation })), evidence: records.attempts.flatMap(item => item.data.evidence), cards,
    notes: session.notes, unresolvedQuestions: (session.conceptMap?.nodes ?? []).filter(node => node.status === 'question' || node.status === 'needs-help').slice(0, 30).map(node => node.description || node.label),
    sourceRefs: refs, now, id: records.study?.data.id ?? randomUUID(), version: (records.study?.data.version ?? 0) + 1 });
}
function recapText(study: StudyPack): string {
  const text = study.recap.text.trim();
  if ([...text].length <= 1800) return text;
  const clipped = [...text].slice(0, 1750).join(''), sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('? '), clipped.lastIndexOf('! '));
  return `${sentenceEnd > 200 ? clipped.slice(0, sentenceEnd + 1) : clipped.slice(0, clipped.lastIndexOf(' '))} More reference material is available in your text study pack.`;
}
/** Uses provider word boundaries, normalized from its session timeline; no guessed word durations. */
export function captionWords(frame: SynthesisBoundaries, durationMs: number): NonNullable<Artifact['captions']> {
  if (!frame.words.length) throw new StoreError(502, 'RECAP_TIMINGS_UNAVAILABLE', 'The speech provider did not return word timing data. The text study pack remains available.');
  let lastStart = -1;
  const captions = frame.words.map(word => {
    const startMs = word.startMs - frame.audioStartMs, rawEnd = word.endMs - frame.audioStartMs, endMs = Math.min(durationMs, rawEnd);
    if (!word.word.trim() || word.word.length > 200 || startMs < 0 || endMs < startMs || startMs < lastStart || rawEnd > durationMs + 100 || !Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new StoreError(502, 'INVALID_RECAP_TIMINGS', 'The recap timing data could not be validated.');
    lastStart = startMs; return { text: word.word, startMs, endMs };
  });
  if (captions.length > 1500) throw new StoreError(502, 'RECAP_TIMING_LIMIT', 'The recap returned too many word timings.');
  return captions;
}
export async function synthesizeRecap(context: ProductContext, session: Session, text: string, signal: AbortSignal): Promise<ArtifactBytes & { durationMs: number; captions: NonNullable<Artifact['captions']> }> {
  const result = await synthesizePcm(context, session, text, session.settings?.preferences.voiceId, signal);
  return { body: pcmToWav(result.pcm), contentType: 'audio/wav', extension: 'wav', durationMs: result.durationMs, captions: result.captions };
}
const PAUSE_MS = 280;
/** Two voices read a dialogue rewritten from the same recap; captions mark each speaker. */
export async function synthesizeDialogue(context: ProductContext, session: Session, dialogue: RecapDialogue, signal: AbortSignal): Promise<ArtifactBytes & { durationMs: number; captions: NonNullable<Artifact['captions']> }> {
  const language = session.settings?.preferences.language ?? 'english', milli = session.settings?.preferences.voiceId ?? 'aai-audrey';
  const sam = TUTOR_VOICES.find(voice => voice.language === language && voice.id !== milli)?.id ?? (milli === 'aai-titus' ? 'aai-sara' : 'aai-titus');
  const parts: Buffer[] = [], captions: NonNullable<Artifact['captions']> = [], silence = Buffer.alloc(Math.round(TTS_SAMPLE_RATE * PAUSE_MS / 1000) * 2);
  let offsetMs = 0;
  for (const line of dialogue.lines) {
    const spoken = await synthesizePcm(context, session, line.text, line.speaker === 'milli' ? milli : sam, signal);
    captions.push({ text: line.speaker === 'milli' ? 'milli:' : 'Sam:', startMs: offsetMs, endMs: offsetMs });
    for (const word of spoken.captions) captions.push({ text: word.text, startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs });
    parts.push(spoken.pcm, silence); offsetMs += spoken.durationMs + PAUSE_MS;
    if (offsetMs > 120_000) throw new StoreError(502, 'INVALID_RECAP_AUDIO', 'The recap exceeded its audio limit.');
  }
  if (captions.length > 1500) throw new StoreError(502, 'RECAP_TIMING_LIMIT', 'The recap returned too many word timings.');
  return { body: pcmToWav(Buffer.concat(parts)), contentType: 'audio/wav', extension: 'wav', durationMs: offsetMs, captions };
}
async function synthesizePcm(context: ProductContext, session: Session, text: string, voiceId: string | undefined, signal: AbortSignal): Promise<{ pcm: Buffer; durationMs: number; captions: NonNullable<Artifact['captions']> }> {
  if (!session.settings?.preferences.retainRecapAudio) throw new StoreError(409, 'AUDIO_CONSENT_REQUIRED', 'Enable saved recap audio for this lesson before generating it.');
  if (!context.env.ASSEMBLYAI_API_KEY) throw new StoreError(503, 'SPEECH_UNAVAILABLE', 'AssemblyAI speech is not configured.');
  const chunks: Buffer[] = []; let byteLength = 0, boundaries: SynthesisBoundaries | undefined, synthesizer: Synthesizer | undefined, failure: Error | undefined;
  const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
  const timer = setTimeout(() => abort.abort(), 90_000);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new StoreError(503, 'RECAP_CANCELLED', 'Recap generation was cancelled or reached its deadline.')); combined.addEventListener('abort', onAbort, { once: true }); if (combined.aborted) onAbort(); });
  try {
    synthesizer = await Promise.race([(context.providers?.recap ?? createSynthesizer)({ apiKey: context.env.ASSEMBLYAI_API_KEY, voiceId, language: session.settings.preferences.language, signal: combined,
      onAudio(pcm) { if (combined.aborted) return; byteLength += pcm.byteLength; if (byteLength > TTS_SAMPLE_RATE * 2 * 120 || pcm.byteLength % 2) { abort.abort(); throw new StoreError(502, 'INVALID_RECAP_AUDIO', 'The recap exceeded its audio limit.'); } chunks.push(Buffer.from(pcm)); },
      onBoundaries(frame) { if (!combined.aborted) boundaries = frame; }, onError(error) { failure = error; },
    }).then(value => { if (combined.aborted) value.close(); return value; }), aborted]);
    await Promise.race([synthesizer.speak(text, { signal: combined }), aborted]); combined.throwIfAborted();
    if (failure) throw failure;
    if (!boundaries) throw new StoreError(502, 'RECAP_TIMINGS_UNAVAILABLE', 'The provider returned no word timings. The text study pack remains available.');
    const pcm = Buffer.concat(chunks, byteLength), durationMs = byteLength * 1000 / (TTS_SAMPLE_RATE * 2), captions = captionWords(boundaries, durationMs);
    return { pcm, durationMs, captions };
  } finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); synthesizer?.close(); }
}

/** Provider work and file upload happen before the short, fenced publication transaction. */
export async function runArtifact(context: ProductContext, p: Principal, job: JobRecord, signal: AbortSignal): Promise<void> {
  const { store, objects, env, now } = context;
  signal.throwIfAborted();
  if (!job.resourceId || job.resourceKind !== 'artifact' || !job.sessionId || !job.workerId || job.ownerId !== p.ownerId) throw new StoreError(400, 'INVALID_ARTIFACT_JOB', 'The artifact job envelope is invalid.');
  await store.assertJob({ id: job.id, workerId: job.workerId, fence: job.fence });
  const record = await store.resources.get<Artifact>(p, 'artifact', job.resourceId), artifact = ArtifactSchema.parse(record.data);
  if (artifact.status === 'ready') return;
  if (record.revision !== job.expectedRevision || record.sessionId !== job.sessionId || artifact.sessionId !== job.sessionId) throw new StoreError(409, 'STALE_JOB', 'This artifact job has been superseded.');
  const session = await store.get(p, job.sessionId), initial = await snapshot(context, p, session.id), sourceInput = await sources(context, p, session);
  const pack = authoredPack(session), covered = [...new Set((session.teachingBeats ?? []).filter(beat => beat.status === 'completed' && (beat.playedMs ?? 0) > 0).flatMap(beat => beat.conceptIds))];
  const provider = { ...liveModels(env), signal };
  let nextCards = initial.cards.map(item => item.data), newCards: LearningCard[] = [], assessment: AssessmentDefinition | undefined;
  if (artifact.kind === 'cards') {
    if (session.mode === 'sample') {
      if (!pack) throw new StoreError(400, 'SAMPLE_UNAVAILABLE', 'Choose a supported authored sample lesson.');
      newCards = instantiatePackCards(pack, { sessionId: session.id, coveredConceptIds: covered, createId: randomUUID, now: now(), includeReference: true }).filter(card => !initial.cards.some(existing => existing.data.templateId === card.templateId));
    } else {
      const templates = await metered(context, p, 'model', 1, onUsage => (context.providers?.cards ?? generateLearningCards)({ ...provider, session, sourceRefs: sourceInput.refs.slice(-12), rubricAssessments: [...(pack?.assessments ?? []), ...initial.assessments.map(item => item.data)], onUsage }), { sessionId: session.id, traceId: job.id });
      newCards = templates.map(template => {
        const { id: templateId, ...fields } = template;
        const originBeat = [...(session.teachingBeats ?? [])].reverse().find(beat => beat.status === 'completed' && (beat.playedMs ?? 0) > 0 && fields.conceptIds.some(id => beat.conceptIds.includes(id)));
        return LearningCardSchema.parse({ ...fields, id: randomUUID(), templateId, packId: `session:${session.id}`, revision: 1, originSessionId: session.id, ...(originBeat ? { originTurnId: originBeat.turnId } : {}), originKind: originBeat ? 'covered-concept' : 'lesson-reference', status: 'active', createdAt: now(), updatedAt: now(), schedule: createCardSchedule(now()) });
      }).filter(card => !initial.cards.some(existing => existing.data.status === 'active' && existing.data.kind === card.kind && existing.data.front === card.front && existing.data.back === card.back));
    }
    if (nextCards.length + newCards.length > 200) throw new StoreError(429, 'CARD_LIMIT', 'This lesson has reached its 200-card limit.');
    nextCards = [...nextCards, ...newCards];
  } else if (artifact.kind === 'assessment') {
    if (session.mode === 'sample') throw new StoreError(409, 'SAMPLE_ASSESSMENTS', 'All eight prepared sample questions are already available. Use live mode to generate another question.');
    if (initial.assessments.length >= 30) throw new StoreError(429, 'ASSESSMENT_LIMIT', 'This lesson has reached its 30 generated-question limit.');
    const kinds = ['multiple-choice', 'short-answer', 'numeric', 'diagram-label', 'spoken-explanation'] as const;
    assessment = AssessmentDefinitionSchema.parse(await metered(context, p, 'model', 1, onUsage => (context.providers?.assessment ?? generateAssessment)({ ...provider, session, id: randomUUID(), kind: kinds[initial.assessments.length % kinds.length], sourceRefs: sourceInput.refs.slice(-12), onUsage }), { sessionId: session.id, traceId: job.id }));
  }
  signal.throwIfAborted();
  let study = makeStudyPack(session, initial, nextCards, sourceInput.refs, now());
  const clearTranscript = session.status === 'ended' && session.settings?.preferences.retainTranscript === false && Boolean(session.messages.length || session.teachingBeats?.length) && artifact.kind !== 'assessment';
  if (session.settings?.preferences.retainTranscript === false) {
    const referenceRecap = ['Here is reference material from your study pack. It is not a record of what you heard.', ...study.referenceConcepts.slice(0, 4).map(concept => concept.explanation)].join(' ').slice(0, 4000);
    study = StudyPackSchema.parse({ ...study, sessionRevision: session.revision + (clearTranscript ? 1 : 0), completedNarration: [], partialNarration: [], recap: { text: referenceRecap, status: 'not-requested', completedBeatIds: [] } });
  }
  let bytes: ArtifactBytes | undefined, durationMs: number | undefined, captions: Artifact['captions'];
  if (artifact.kind === 'recap') {
    const text = recapText(study), language = session.settings?.preferences.language ?? 'english';
    // Injected test recap providers keep the deterministic single-voice path.
    const dialogue = session.mode === 'live' && !context.providers?.recap && liveModelsConfigured(env)
      ? await metered(context, p, 'model', 1, onUsage => generateRecapDialogue({ ...provider, recap: text, language, onUsage }), { sessionId: session.id, traceId: job.id }).catch(() => undefined) : undefined;
    signal.throwIfAborted();
    const units = dialogue ? [...dialogue.lines.map(line => line.text).join(' ')].length : [...text.trim()].length;
    const result = await metered(context, p, 'speech', units, async observe => { const audio = dialogue ? await synthesizeDialogue(context, session, dialogue, signal) : await synthesizeRecap(context, session, text, signal); observe({ audioMs: audio.durationMs }); return audio; }, { sessionId: session.id, traceId: job.id }); bytes = result; durationMs = result.durationMs; captions = result.captions;
    study = StudyPackSchema.parse({ ...study, recap: { ...study.recap, text, status: 'ready' } });
  } else if (artifact.kind === 'cards') bytes = renderCardsJson(study);
  else if (artifact.kind !== 'assessment') bytes = await renderArtifactExport(study, artifact.kind === 'export' ? artifact.format : 'markdown');
  // A delivery can be duplicated under the same lease; each execution owns its temporary bytes.
  const storageKey = `artifact/${artifact.id}/${job.id}-${job.fence}-${randomUUID()}`;
  let uploaded = false, published = false, fileExpiresAt: string | undefined;
  try {
    if (bytes) { signal.throwIfAborted(); const stored = await objects.put(storageKey, bytes.body, bytes.contentType, { principal: p, sessionId: session.id, signal }); fileExpiresAt = stored.expiresAt; uploaded = true; }
    signal.throwIfAborted();
    await store.locked(session.id, async () => {
      signal.throwIfAborted(); await store.assertJob({ id: job.id, workerId: job.workerId!, fence: job.fence });
      const currentSession = await store.get(p, session.id), currentArtifact = await store.resources.get<Artifact>(p, 'artifact', artifact.id), current = await snapshot(context, p, session.id);
      if (currentSession.revision !== session.revision || currentArtifact.revision !== record.revision || currentArtifact.data.status === 'ready'
        || fingerprint(current.attempts) !== fingerprint(initial.attempts) || fingerprint(current.cards) !== fingerprint(initial.cards) || fingerprint(current.assessments) !== fingerprint(initial.assessments) || current.study?.revision !== initial.study?.revision) throw new StoreError(409, 'ARTIFACT_CONTEXT_CHANGED', 'The lesson changed while generating this artifact. Retry against the current lesson.');
      for (const source of sourceInput.resources) if ((await store.resources.get(p, 'source', source.id)).revision !== source.revision) throw new StoreError(409, 'SOURCE_CHANGED', 'A cited source changed during generation.');
      for (const card of newCards) await store.resources.put(p, 'card', card.id, card, { expectedRevision: -1, sessionId: session.id });
      if (assessment) await store.resources.put(p, 'assessment', assessment.id, assessment, { expectedRevision: -1, sessionId: session.id });
      if (artifact.kind !== 'assessment') await store.resources.put(p, 'study-pack', session.id, study, { expectedRevision: initial.study?.revision ?? -1, sessionId: session.id });
      if (clearTranscript) await store.save(p, { ...bumpSession(currentSession, now()), messages: [], teachingBeats: [], summary: study.referenceConcepts.slice(0, 4).map(concept => `${concept.label}: ${concept.explanation}`).join('\n').slice(0, 4000) }, { expectedRevision: currentSession.revision });
      if (bytes) {
        const previous = await optionalResource<ArtifactFile>(store, p, 'artifact-file', artifact.id);
        await store.resources.put(p, 'artifact-file', artifact.id, { storageKey, contentType: bytes.contentType, filename: `milli-${artifact.kind}-${artifact.id}.${bytes.extension}` } satisfies ArtifactFile, { expectedRevision: previous?.revision ?? -1, sessionId: session.id });
      }
      const ready = ArtifactSchema.parse({ ...artifact, status: 'ready', format: artifact.kind === 'recap' ? 'wav' : artifact.kind === 'cards' ? 'json' : artifact.format, revision: artifact.revision + 1, updatedAt: now(), fileExpiresAt, ...(durationMs !== undefined ? { durationMs, captions } : {}), error: undefined });
      await store.resources.put(p, 'artifact', artifact.id, ready, { expectedRevision: record.revision, sessionId: session.id });
      await store.appendEvent(p, session.id, { id: randomUUID(), type: 'artifact.ready', data: { artifactId: artifact.id, kind: artifact.kind } });
    });
    published = true;
  } finally { if (uploaded && !published) await objects.delete(storageKey).catch(() => undefined); }
}
