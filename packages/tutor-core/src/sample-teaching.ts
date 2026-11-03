import { layoutDiagram, type DiagramSpec, type Session } from '@tokai/contracts';
import { LESSONS, sampleReply } from './lessons.js';
import { plainTeachingBeat, splitTeachingText, validateTeachingPlan } from './teaching.js';
import type { TutorReply } from './types.js';

/** Explicitly authored sample behavior; never used as a live-provider fallback. */
export function sampleTeachingReply(session: Session, text: string, selectedNodeId?: string): TutorReply {
  const explanation = sampleReply(session, text, selectedNodeId);
  if (!/\b(diagram|draw|visual|show me)\b/i.test(text)) return { text: explanation };
  const lesson = LESSONS[session.topic], prefix = `sample-${session.topic}`;
  const spec: DiagramSpec = session.topic === 'fractions' ? {
    id: `${prefix}-frame`, title: 'Prepared sample: equivalent fractions', template: 'fraction',
    nodes: [
      { id: `${prefix}-half`, label: 'One half', detail: 'One of two equal parts of the same whole.', conceptIds: ['numerator', 'denominator'], fraction: { numerator: 1, denominator: 2 } },
      { id: `${prefix}-quarters`, label: 'Two quarters', detail: 'Two of four equal parts cover the same amount.', conceptIds: ['equivalent'], fraction: { numerator: 2, denominator: 4 } }
    ], edges: [{ id: `${prefix}-equal`, from: `${prefix}-half`, to: `${prefix}-quarters`, label: 'same amount' }]
  } : {
    id: `${prefix}-frame`, title: `Prepared sample: ${session.title}`, template: session.topic === 'solar-system' ? 'hierarchy' : 'process',
    nodes: lesson.nodes.map(node => ({ ...node, id: `${prefix}-${node.id}`, conceptIds: [node.id] })),
    edges: lesson.links.map(([from, to, label], index) => ({ id: `${prefix}-edge-${index}`, from: `${prefix}-${from}`, to: `${prefix}-${to}`, label }))
  };
  const display = `Here is a prepared sample diagram. ${explanation}`;
  const beats = splitTeachingText(display).map(plainTeachingBeat);
  beats[0]!.boardCommands = layoutDiagram(spec, session.board);
  beats[0]!.conceptIds = spec.nodes.flatMap(node => node.conceptIds ?? []);
  beats[0]!.highlightNodeIds = [spec.nodes[0]!.id];
  try { return { text: display, beats: validateTeachingPlan(session, beats) }; }
  catch { return { text: explanation, warnings: ['The prepared sample diagram could not replace edited student shapes. Your work was preserved.'] }; }
}
