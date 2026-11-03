import { layoutDiagram, SPATIAL_CATALOG, type DiagramSpec, type Session, type SelectionContext, type SpatialSelection } from '@tokai/contracts';
import { LESSONS, sampleReply } from './lessons.js';
import { plainTeachingBeat, splitTeachingText, validateTeachingPlan } from './teaching.js';
import type { TutorReply } from './types.js';
import { groundSpatialSelection } from './spatial.js';

function sampleSpatialReply(session: Session, text: string, selection?: SelectionContext): TutorReply | undefined {
  if (/\b(diagram|draw|whiteboard|board)\b/i.test(text)) return undefined;
  let spatial: SpatialSelection | undefined = selection?.spatial;
  if (!spatial && /\b(3d|model|spatial)\b/i.test(text)) {
    const named = /\b(dna|double helix)\b/i.test(text) ? 'dna' : /\b(heart|blood flow)\b/i.test(text) ? 'heart' : /\b(chloroplast)\b/i.test(text) ? 'chloroplast' : /\b(solar|planet)\b/i.test(text) ? 'solar-system' : undefined;
    const model = SPATIAL_CATALOG.find(value => named ? value.id === named : value.topicIds.includes(session.topic));
    if (!model) return { text: 'This prepared sample lesson has no matching 3D model. The model library offers the solar system, DNA, a chloroplast and the heart. Choose a model there, or keep exploring this lesson on the board.' };
    spatial = { modelId: model.id, assetVersion: model.assetVersion, partIds: [] };
  }
  const selected = groundSpatialSelection(spatial);
  if (!selected || !spatial) return undefined;
  const display = selected.parts.length > 1
    ? `Prepared sample model: you selected ${selected.parts.map(part => part.label).join(', ')}. Choose one part and ask about it so we can explain one idea at a time.`
    : `Prepared sample model: ${selected.parts[0] ? `${selected.parts[0].label}. ${selected.parts[0].description}` : `${selected.model.title}. ${selected.model.description}`} ${selected.model.scaleNote} ${selected.parts.length ? 'How would you describe this part’s role in your own words?' : 'Select a part to explore its role.'}`;
  const beats = splitTeachingText(display).map(plainTeachingBeat);
  beats[0]!.spatialUpdate = spatial;
  beats[0]!.conceptIds = selected.parts.flatMap(part => part.conceptIds);
  return { text: display, beats: validateTeachingPlan(session, beats) };
}

/** Explicitly authored sample behavior; never used as a live-provider fallback. */
export function sampleTeachingReply(session: Session, text: string, selectedNodeId?: string, selection?: SelectionContext): TutorReply {
  const spatial = sampleSpatialReply(session, text, selection);
  if (spatial) return spatial;
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
