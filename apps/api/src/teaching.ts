import { randomUUID } from 'node:crypto';
import { applyMapUpdate, emptyConceptMap, pruneMapBoardReferences, type TeachingBeat, type Session } from '@milli/contracts';
import { normalizeTeachingReply, validateTeachingPlan, projectTeachingProposal, type TutorReply } from '@milli/tutor-core';
import { applySessionBoardTransaction, sceneFailure } from './board-operations.js';
import { ApiError } from './store.js';

export function planTeachingBeats(session: Session, reply: TutorReply, turnId: string, outputEpoch: number): TeachingBeat[] {
  const proposals = normalizeTeachingReply(session, reply);
  if ((session.teachingBeats?.length ?? 0) + proposals.length > 200 || session.messages.length + proposals.length > 201) throw new ApiError(429, 'TURN_LIMIT', 'Finish this lesson before starting another conversation.');
  let revision = session.board.revision ?? 0;
  return proposals.map(proposal => {
    const beat: TeachingBeat = { ...proposal, beatId: randomUUID(), turnId, messageId: randomUUID(), outputEpoch, status: 'planned', expectedBoardRevision: revision, playedMs: 0, ...(reply.warnings?.length ? { warnings: reply.warnings.slice(0, 8).map(value => value.slice(0, 300)) } : {}) };
    if (proposal.boardCommands.length) revision++;
    return beat;
  });
}
export function appendTeachingBeats(session: Session, beats: TeachingBeat[], createdAt: string, voice: boolean) {
  session.teachingBeats = [...(session.teachingBeats ?? []), ...beats];
  for (const beat of beats) session.messages.push({ id: beat.messageId, role: 'tutor', text: beat.displayText, turnId: beat.turnId, createdAt, ...(voice ? { delivery: 'generated' as const, playedMs: 0 } : {}) });
}
/** Commits all visual tools for one beat atomically; a rejected visual leaves student work intact. */
export function commitBeatVisuals(session: Session, beatId: string) {
  const beat = session.teachingBeats?.find(value => value.beatId === beatId);
  if (!beat) throw new ApiError(404, 'BEAT_NOT_FOUND', 'The teaching step no longer exists.');
  if (beat.status !== 'planned') return { beat, applied: false };
  try {
    if ((beat.boardCommands.length || beat.highlightNodeIds.length) && beat.expectedBoardRevision !== (session.board.revision ?? 0)) throw new ApiError(409, 'BOARD_CONFLICT', 'The board changed while the tutor was preparing this step.');
    validateTeachingPlan(session, [projectTeachingProposal(beat)]);
    const next = structuredClone(session);
    if (beat.boardCommands.length) applySessionBoardTransaction(next, { operationId: `beat:${beat.beatId}`, expectedRevision: beat.expectedBoardRevision, commands: beat.boardCommands }, 'tutor', false);
    if (beat.mapUpdate) next.conceptMap = applyMapUpdate(next.conceptMap ?? emptyConceptMap(next.topic), beat.mapUpdate, 'tutor');
    if (next.conceptMap) next.conceptMap = pruneMapBoardReferences(next.conceptMap, next.board);
    if (beat.focus) next.lessonFocus = beat.focus;
    if (beat.spatialUpdate) { next.spatialState = structuredClone(beat.spatialUpdate); next.visualSurface = 'spatial'; }
    else if (beat.boardCommands.length || beat.highlightNodeIds.length) next.visualSurface = 'board';
    session.board = next.board; session.boardOperations = next.boardOperations; session.conceptMap = next.conceptMap; session.lessonFocus = next.lessonFocus; session.spatialState = next.spatialState; session.visualSurface = next.visualSurface;
    beat.status = 'ready'; beat.boardRevision = session.board.revision ?? 0;
    return { beat, applied: Boolean(beat.boardCommands.length || beat.spatialUpdate) };
  } catch (error) {
    const safe = sceneFailure(error);
    beat.status = 'ready'; beat.boardRevision = session.board.revision ?? 0;
    beat.warnings = [...(beat.warnings ?? []), `Visual update unavailable: ${safe.message}`.slice(0, 300)].slice(-8);
    return { beat, applied: false, warning: `The visual update could not be applied. ${safe.message}` };
  }
}
export function markTeachingInterrupted(session: Session, outputEpoch?: number) {
  for (const beat of session.teachingBeats ?? []) if (beat.outputEpoch !== 0 && ['planned', 'ready', 'playing'].includes(beat.status) && (outputEpoch === undefined || beat.outputEpoch === outputEpoch)) {
    beat.status = 'interrupted';
    const message = session.messages.find(value => value.id === beat.messageId);
    if (message?.delivery && message.delivery !== 'completed' && message.delivery !== 'failed') { message.delivery = 'interrupted'; beat.playedMs = message.playedMs ?? 0; }
  }
}
