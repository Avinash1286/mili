import { TeachingBeatProposalSchema, applyBoardTransaction, applyMapUpdate, emptyConceptMap, pruneMapBoardReferences, type TeachingBeatProposal, type Session } from '@tokai/contracts';
import { TutorError, type TutorReply } from './types.js';
import { groundSpatialSelection } from './spatial.js';

export function splitTeachingText(text: string): string[] {
  const value = text.trim();
  if (!value) return [];
  if (value.length <= 600) return [value];
  if (value.length > 1200) throw new TutorError('TUTOR_INVALID_RESPONSE', 'The tutor response was too long for one teaching step. Please try again.');
  // A preferred boundary is usable only if the remaining text fits the second
  // beat. An early sentence ending must not consume an entire beat by itself.
  let sentenceBoundary = 0, wordBoundary = 0;
  for (let index = 1; index <= 600; index++) {
    if (!/\s/.test(value[index] ?? '') || value.slice(index).trim().length > 600) continue;
    wordBoundary = index;
    if (/[.!?]/.test(value[index - 1]!)) sentenceBoundary = index;
  }
  const boundary = sentenceBoundary || wordBoundary || 600;
  return [value.slice(0, boundary).trim(), value.slice(boundary).trim()];
}
export function plainTeachingBeat(text: string): TeachingBeatProposal {
  return TeachingBeatProposalSchema.parse({ spokenText: text, displayText: text, conceptIds: [], boardCommands: [], highlightNodeIds: [], sourceRefs: [] });
}
export function projectTeachingProposal(beat: TeachingBeatProposal): TeachingBeatProposal {
  return { spokenText: beat.spokenText, displayText: beat.displayText, conceptIds: beat.conceptIds, boardCommands: beat.boardCommands, highlightNodeIds: beat.highlightNodeIds, sourceRefs: beat.sourceRefs, ...(beat.mapUpdate ? { mapUpdate: beat.mapUpdate } : {}), ...(beat.focus ? { focus: beat.focus } : {}), ...(beat.spatialUpdate ? { spatialUpdate: beat.spatialUpdate } : {}) };
}
/** Validates all planned states without committing or trusting model-provided references. */
export function validateTeachingPlan(session: Session, proposals: TeachingBeatProposal[]): TeachingBeatProposal[] {
  if (!proposals.length || proposals.length > 2) throw new TutorError('INVALID_TEACHING_PLAN', 'A response must contain one or two short teaching steps.');
  let board = structuredClone(session.board), map = structuredClone(session.conceptMap ?? emptyConceptMap(session.topic));
  let spatial = groundSpatialSelection(session.spatialState);
  const sources = new Set(session.board.nodes.flatMap(node => node.sourceRefs ?? []));
  const messages = new Set(session.messages.map(message => message.id)), cards = new Set(session.flashcards.map(card => card.id));
  return proposals.map((raw, index) => {
    const beat = TeachingBeatProposalSchema.parse(raw);
    if (beat.spatialUpdate) spatial = groundSpatialSelection(beat.spatialUpdate);
    if (beat.boardCommands.some(command => command.type === 'upsert_node' && command.node.sourceRefs?.some(source => !sources.has(source)))) throw new TutorError('INVALID_SOURCE_REFERENCE', 'Visuals cannot invent source references.');
    if (beat.boardCommands.length) board = applyBoardTransaction(board, { operationId: `validation:${index}`, expectedRevision: board.revision ?? 0, commands: beat.boardCommands }, 'tutor');
    if (beat.mapUpdate) {
      if (beat.mapUpdate.nodes.some(node => node.boardNodeIds?.some(id => !board.nodes.some(shape => shape.id === id)) || node.messageIds?.some(id => !messages.has(id)) || node.cardIds?.some(id => !cards.has(id)))) throw new TutorError('INVALID_MAP_REFERENCE', 'The concept map references an unavailable lesson item.');
      map = applyMapUpdate(map, beat.mapUpdate, 'tutor');
    }
    map = pruneMapBoardReferences(map, board);
    const concepts = new Set([...session.concepts.map(concept => concept.id), ...board.nodes.flatMap(node => node.conceptIds ?? [node.id]), ...map.nodes.map(node => node.id), ...(spatial?.model.parts.flatMap(part => part.conceptIds) ?? [])]);
    if (beat.conceptIds.some(id => !concepts.has(id)) || (beat.focus?.currentConceptId && !concepts.has(beat.focus.currentConceptId))) throw new TutorError('INVALID_CONCEPT_REFERENCE', 'The teaching step references an unavailable concept.');
    if (beat.highlightNodeIds.some(id => !board.nodes.some(node => node.id === id))) throw new TutorError('INVALID_HIGHLIGHT', 'The highlighted shape no longer exists.');
    if (beat.sourceRefs.some(source => !sources.has(source))) throw new TutorError('INVALID_SOURCE_REFERENCE', 'The tutor cannot invent source references.');
    return beat;
  });
}
export function normalizeTeachingReply(session: Session, reply: TutorReply): TeachingBeatProposal[] {
  if (reply.beats?.length) return validateTeachingPlan(session, reply.beats);
  if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 1200) throw new TutorError('TUTOR_INVALID_RESPONSE', 'The tutor returned an invalid teaching step.');
  return splitTeachingText(reply.text).map(plainTeachingBeat);
}
