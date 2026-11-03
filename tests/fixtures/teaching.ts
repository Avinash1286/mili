import { TeachingBeatProposalSchema, type Session } from '../../packages/contracts/src/index.js';

export const VISUAL_REQUEST = 'Show a two-step sunlight diagram.';
export const DELAYED_VISUAL_REQUEST = 'Wait, then show a sunlight diagram.';
export const VISUAL_FRAME_ID = 'fixture-process-frame';

/** Deterministic proposals pass through the same production validator and transaction executor. */
export function visualReply(session: Session) {
  const first = TeachingBeatProposalSchema.parse({
    spokenText: 'Sunlight supplies the energy that chlorophyll absorbs.',
    displayText: 'Step one: sunlight supplies energy.',
    conceptIds: ['light'],
    boardCommands: [{ type: 'upsert_frame', frame: { id: VISUAL_FRAME_ID, title: 'From sunlight to sugar', x: 1100, y: 0, width: 800, height: 400 } }, { type: 'upsert_node', node: {
      id: 'fixture-energy', label: 'Light energy step', detail: 'Chlorophyll absorbs light energy.',
      x: 1140, y: 80, width: 230, height: 155, kind: 'concept', shape: 'rectangle', frameId: VISUAL_FRAME_ID, conceptIds: ['light'],
    } }],
    highlightNodeIds: ['fixture-energy'],
    mapUpdate: { expectedRevision: session.conceptMap?.revision ?? 0, mode: 'merge', topicId: session.topic,
      nodes: [{ id: 'fixture-light-map', label: 'Light energy', boardNodeIds: ['fixture-energy'], messageIds: session.messages.slice(-1).map(message => message.id) }], edges: [] },
  });
  const second = TeachingBeatProposalSchema.parse({
    spokenText: 'Plants use that energy to build sugars from carbon dioxide and water.',
    displayText: 'Step two: build sugar from material inputs.',
    conceptIds: ['sugar'],
    boardCommands: [
      { type: 'upsert_node', node: { id: 'fixture-sugar', label: 'Sugar building step', detail: 'Sugar stores chemical energy.', x: 1460, y: 80, width: 230, height: 155, kind: 'concept', shape: 'rectangle', frameId: VISUAL_FRAME_ID, conceptIds: ['sugar'] } },
      { type: 'upsert_edge', edge: { id: 'fixture-energy-to-sugar', from: 'fixture-energy', to: 'fixture-sugar', label: 'energy powers' } },
    ],
    highlightNodeIds: ['fixture-sugar'],
    mapUpdate: { expectedRevision: (session.conceptMap?.revision ?? 0) + 1, mode: 'merge', topicId: session.topic,
      nodes: [{ id: 'fixture-sugar-map', label: 'Sugar building', boardNodeIds: ['fixture-sugar'], cardIds: session.flashcards.filter(card => card.conceptId === 'sugar').map(card => card.id) }],
      edges: [{ id: 'fixture-map-link', from: 'fixture-light-map', to: 'fixture-sugar-map', label: 'powers' }] },
  });
  return { text: `${first.displayText} ${second.displayText}`, beats: [first, second] };
}
