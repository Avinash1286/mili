import { z } from 'zod';
import { SpatialSelectionSchema } from './spatial';

// IDs are opaque data, including persisted Phase 2 IDs containing spaces or Unicode.
// Renderers compare these values directly; they are never selectors or file paths.
const id = z.string().min(1).max(100);
const coordinate = z.number().finite().min(-5000).max(5000);
const revision = z.number().int().nonnegative();
const actor = z.enum(['student', 'tutor']);
const refs = z.array(id).max(24);
export const PointSchema = z.object({ x: coordinate, y: coordinate }).strict();
export const PlotSchema = z.object({ points: z.array(PointSchema).min(2).max(200), xLabel: z.string().min(1).max(80), yLabel: z.string().min(1).max(80) }).strict();
export const FractionSchema = z.object({ numerator: z.number().int().min(0).max(24), denominator: z.number().int().min(1).max(24) }).strict().refine(v => v.numerator <= v.denominator, 'A fraction model must fit within one whole');
export const NumberRangeSchema = z.object({ min: z.number().finite().min(-10000), max: z.number().finite().max(10000), value: z.number().finite().optional() }).strict().refine(v => v.min < v.max && (v.value === undefined || (v.value >= v.min && v.value <= v.max)), 'Invalid number line range');
export const BoardFrameSchema = z.object({ id, title: z.string().min(1).max(120), x: coordinate, y: coordinate, width: z.number().min(100).max(5000), height: z.number().min(100).max(5000), author: actor.optional() }).strict();
export const BoardNodeSchema = z.object({
  id, label: z.string().min(1).max(120), detail: z.string().max(1000), x: coordinate, y: coordinate,
  kind: z.enum(['root', 'concept', 'detail', 'question']),
  shape: z.enum(['card', 'rectangle', 'ellipse', 'text', 'equation', 'fraction', 'number-line', 'annotation', 'graph']).optional(),
  width: z.number().finite().min(20).max(1200).optional(), height: z.number().finite().min(20).max(1200).optional(),
  author: actor.optional(), revision: revision.optional(), conceptIds: refs.optional(), sourceRefs: z.array(z.string().max(200)).max(12).optional(),
  description: z.string().max(1000).optional(), frameId: id.optional(), points: z.array(PointSchema).min(1).max(2000).optional(),
  fraction: FractionSchema.optional(), range: NumberRangeSchema.optional(), plot: PlotSchema.optional(),
}).strict().superRefine((node, ctx) => {
  if (node.shape === 'annotation' && !node.points?.length) ctx.addIssue({ code: 'custom', message: 'Annotations need points' });
  if (node.shape === 'fraction' && !node.fraction) ctx.addIssue({ code: 'custom', message: 'Fraction shapes need a fraction' });
  if (node.shape === 'number-line' && !node.range) ctx.addIssue({ code: 'custom', message: 'Number lines need a range' });
  if (node.shape === 'graph' && !node.plot) ctx.addIssue({ code: 'custom', message: 'Graphs need explicit points and axes' });
});
export const BoardEdgeSchema = z.object({ id, from: id, to: id, label: z.string().max(80).optional(), author: actor.optional(), revision: revision.optional(), conceptIds: refs.optional() }).strict();
export const BoardSchema = z.object({ revision: revision.optional(), nodes: z.array(BoardNodeSchema).max(120), edges: z.array(BoardEdgeSchema).max(240), frames: z.array(BoardFrameSchema).max(12).optional() }).strict().superRefine((board, ctx) => {
  const nodes = new Set(board.nodes.map(n => n.id)), frames = new Set(board.frames?.map(f => f.id));
  if (nodes.size !== board.nodes.length) ctx.addIssue({ code: 'custom', message: 'Board node IDs must be unique', path: ['nodes'] });
  if (new Set(board.edges.map(e => e.id)).size !== board.edges.length) ctx.addIssue({ code: 'custom', message: 'Board edge IDs must be unique', path: ['edges'] });
  if (frames.size !== (board.frames?.length ?? 0)) ctx.addIssue({ code: 'custom', message: 'Frame IDs must be unique', path: ['frames'] });
  for (const [i, edge] of board.edges.entries()) if (!nodes.has(edge.from) || !nodes.has(edge.to)) ctx.addIssue({ code: 'custom', message: 'Edges must reference existing nodes', path: ['edges', i] });
  for (const [i, node] of board.nodes.entries()) if (node.frameId && !frames.has(node.frameId)) ctx.addIssue({ code: 'custom', message: 'Node frame must exist', path: ['nodes', i, 'frameId'] });
});
export type Board = z.infer<typeof BoardSchema>;
export type BoardNode = z.infer<typeof BoardNodeSchema>;
export type BoardEdge = z.infer<typeof BoardEdgeSchema>;
export type BoardFrame = z.infer<typeof BoardFrameSchema>;

export const BoardCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upsert_node'), node: BoardNodeSchema }).strict(),
  z.object({ type: z.literal('remove_node'), id }).strict(),
  z.object({ type: z.literal('upsert_edge'), edge: BoardEdgeSchema }).strict(),
  z.object({ type: z.literal('remove_edge'), id }).strict(),
  z.object({ type: z.literal('upsert_frame'), frame: BoardFrameSchema }).strict(),
  z.object({ type: z.literal('remove_frame'), id }).strict(),
]);
export type BoardCommand = z.infer<typeof BoardCommandSchema>;
export const BoardTransactionSchema = z.object({ operationId: id, expectedRevision: revision, commands: z.array(BoardCommandSchema).min(1).max(100) }).strict();
export type BoardTransaction = z.infer<typeof BoardTransactionSchema>;

export class SceneError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SceneError'; }
}

/** Atomic pure reducer: rejection never changes its input. The server owns transaction dedupe. */
export function applyBoardTransaction(input: Board, raw: BoardTransaction, origin: 'student' | 'tutor'): Board {
  const parsed = BoardTransactionSchema.safeParse(raw);
  if (!parsed.success) throw new SceneError('INVALID_BOARD_OPERATION', 'The visual change contains invalid shapes or commands.');
  const tx = parsed.data;
  if (tx.expectedRevision !== (input.revision ?? 0)) throw new SceneError('BOARD_CONFLICT', 'The board changed. Refresh it before applying this change.');
  const board = structuredClone(BoardSchema.parse(input));
  const protect = (object: { author?: 'student' | 'tutor' } | undefined) => {
    if (origin === 'tutor' && object?.author === 'student') throw new SceneError('STUDENT_WORK_PROTECTED', 'Tutor changes cannot overwrite student work.');
  };
  for (const command of tx.commands) {
    if (command.type === 'upsert_node') {
      const i = board.nodes.findIndex(n => n.id === command.node.id), old = board.nodes[i]; protect(old);
      const value = { ...command.node, author: origin, revision: (old?.revision ?? 0) + 1 };
      if (i < 0) board.nodes.push(value); else board.nodes[i] = value;
    } else if (command.type === 'remove_node') {
      const old = board.nodes.find(n => n.id === command.id);
      if (!old) throw new SceneError('UNKNOWN_SHAPE', 'The shape no longer exists.');
      protect(old);
      for (const edge of board.edges.filter(e => e.from === command.id || e.to === command.id)) protect(edge);
      board.nodes = board.nodes.filter(n => n.id !== command.id); board.edges = board.edges.filter(e => e.from !== command.id && e.to !== command.id);
    } else if (command.type === 'upsert_edge') {
      const i = board.edges.findIndex(e => e.id === command.edge.id), old = board.edges[i]; protect(old);
      const value = { ...command.edge, author: origin, revision: (old?.revision ?? 0) + 1 };
      if (i < 0) board.edges.push(value); else board.edges[i] = value;
    } else if (command.type === 'remove_edge') {
      const old = board.edges.find(e => e.id === command.id);
      if (!old) throw new SceneError('UNKNOWN_CONNECTOR', 'The connector no longer exists.');
      protect(old); board.edges = board.edges.filter(e => e.id !== command.id);
    } else if (command.type === 'upsert_frame') {
      board.frames ??= [];
      const i = board.frames.findIndex(f => f.id === command.frame.id); protect(board.frames[i]);
      const frame = { ...command.frame, author: origin };
      if (i < 0) board.frames.push(frame); else board.frames[i] = frame;
    } else {
      const frame = board.frames?.find(f => f.id === command.id);
      if (!frame) throw new SceneError('UNKNOWN_FRAME', 'The frame no longer exists.');
      protect(frame);
      if (board.nodes.some(n => n.frameId === command.id)) throw new SceneError('FRAME_NOT_EMPTY', 'Remove or move the frame contents before deleting the frame.');
      board.frames = board.frames?.filter(f => f.id !== command.id);
    }
  }
  board.revision = (input.revision ?? 0) + 1;
  const valid = BoardSchema.safeParse(board);
  if (!valid.success) throw new SceneError('INVALID_BOARD_OPERATION', 'The visual change has missing references or exceeds board limits.');
  return valid.data;
}

export const SelectionContextSchema = z.object({ shapeIds: refs, conceptIds: refs, boardRevision: revision, viewport: z.object({ x: coordinate, y: coordinate, zoom: z.number().finite().min(.1).max(8) }).strict().optional(), capturedAt: z.string().datetime().optional(), spatial: SpatialSelectionSchema.optional() }).strict();
export type SelectionContext = z.infer<typeof SelectionContextSchema>;
export function resolveSelection(board: Board, selection?: SelectionContext): { status: 'none' | 'resolved' | 'ambiguous' | 'stale'; nodes: BoardNode[]; conceptIds: string[]; clarification?: string } {
  if (!selection || (!selection.shapeIds.length && !selection.conceptIds.length)) return { status: 'none', nodes: [], conceptIds: [] };
  const stale = () => ({ status: 'stale' as const, nodes: [], conceptIds: [], clarification: 'The board changed since that selection. Please select the object again.' });
  if (!SelectionContextSchema.safeParse(selection).success || selection.boardRevision !== (board.revision ?? 0)) return stale();
  const nodes = board.nodes.filter(n => selection.shapeIds.includes(n.id) || (!selection.shapeIds.length && (n.conceptIds ?? [n.id]).some(c => selection.conceptIds.includes(c))));
  if (selection.shapeIds.some(id => !nodes.some(n => n.id === id)) || !nodes.length) return stale();
  if (nodes.length !== 1) return { status: 'ambiguous', nodes, conceptIds: [], clarification: 'Several objects are selected. Which one should I explain?' };
  return { status: 'resolved', nodes, conceptIds: nodes[0]!.conceptIds ?? [nodes[0]!.id] };
}

export const MapNodeSchema = z.object({ id, label: z.string().min(1).max(120), description: z.string().max(1000).optional(), status: z.enum(['introduced', 'practicing', 'needs-help', 'understood', 'question']).default('introduced'), x: coordinate.optional(), y: coordinate.optional(), boardNodeIds: refs.optional(), messageIds: refs.optional(), cardIds: refs.optional(), author: actor.optional() }).strict();
export const MapEdgeSchema = z.object({ id, from: id, to: id, label: z.string().max(80).optional(), author: actor.optional() }).strict();
const mapFields = { topicId: z.string().min(1).max(100), revision, nodes: z.array(MapNodeSchema).max(80), edges: z.array(MapEdgeSchema).max(160) };
export const ConceptMapSchema = z.object(mapFields).strict().superRefine((map, ctx) => {
  const ids = new Set(map.nodes.map(n => n.id));
  if (ids.size !== map.nodes.length || new Set(map.edges.map(e => e.id)).size !== map.edges.length) ctx.addIssue({ code: 'custom', message: 'Map IDs must be unique' });
  if (map.edges.some(e => !ids.has(e.from) || !ids.has(e.to))) ctx.addIssue({ code: 'custom', message: 'Map edges must reference existing concepts' });
});
export type ConceptMap = z.infer<typeof ConceptMapSchema>;
export const MapUpdateSchema = z.object({ expectedRevision: revision, mode: z.enum(['merge', 'replace']), topicId: mapFields.topicId, nodes: mapFields.nodes, edges: mapFields.edges }).strict();
export type MapUpdate = z.infer<typeof MapUpdateSchema>;
export function emptyConceptMap(topicId: string): ConceptMap { return { topicId, revision: 0, nodes: [], edges: [] }; }
/** Remove only current board associations; keep the concepts, relationships and learning history. */
export function pruneMapBoardReferences(map: ConceptMap, board: Board): ConceptMap {
  const existing = new Set(board.nodes.map(node => node.id));
  if (!map.nodes.some(node => node.boardNodeIds?.some(id => !existing.has(id)))) return map;
  return { ...map, revision: map.revision + 1, nodes: map.nodes.map(node => node.boardNodeIds ? { ...node, boardNodeIds: node.boardNodeIds.filter(id => existing.has(id)) } : node) };
}
export function applyMapUpdate(input: ConceptMap, raw: MapUpdate, origin: 'student' | 'tutor'): ConceptMap {
  const parsed = MapUpdateSchema.safeParse(raw);
  if (!parsed.success) throw new SceneError('INVALID_MAP_UPDATE', 'The concept map update is invalid.');
  const update = parsed.data;
  if (input.topicId !== update.topicId) throw new SceneError('MAP_SCOPE', 'This update belongs to a different lesson.');
  if (input.revision !== update.expectedRevision) throw new SceneError('MAP_CONFLICT', 'The concept map changed. Refresh before applying this update.');
  if (new Set(update.nodes.map(n => n.id)).size !== update.nodes.length || new Set(update.edges.map(e => e.id)).size !== update.edges.length) throw new SceneError('INVALID_MAP_UPDATE', 'Duplicate map identifiers are not allowed.');
  if (origin === 'tutor' && update.mode === 'replace' && (input.nodes.some(n => n.author === 'student') || input.edges.some(e => e.author === 'student'))) throw new SceneError('STUDENT_WORK_PROTECTED', 'Tutor map replacement cannot erase student work.');
  const nodes = new Map((update.mode === 'merge' ? input.nodes : []).map(n => [n.id, structuredClone(n)]));
  for (const n of update.nodes) {
    const old = input.nodes.find(v => v.id === n.id);
    // A merge can add relationships around student concepts, but never rewrite their content.
    if (origin === 'tutor' && old?.author === 'student') { nodes.set(n.id, structuredClone(old)); continue; }
    if (origin === 'tutor' && n.status === 'understood' && old?.status !== 'understood') throw new SceneError('MASTERY_EVIDENCE_REQUIRED', 'A mention is not evidence of understanding.');
    const i = nodes.size;
    nodes.set(n.id, { ...n, author: old?.author === 'student' ? 'student' : origin, x: update.mode === 'merge' && origin === 'tutor' && old ? old.x : n.x ?? old?.x ?? (i % 3) * 260, y: update.mode === 'merge' && origin === 'tutor' && old ? old.y : n.y ?? old?.y ?? Math.floor(i / 3) * 170 });
  }
  const edges = new Map((update.mode === 'merge' ? input.edges : []).map(e => [e.id, structuredClone(e)]));
  for (const e of update.edges) {
    const old = input.edges.find(edge => edge.id === e.id);
    edges.set(e.id, origin === 'tutor' && old?.author === 'student' ? structuredClone(old) : { ...e, author: origin });
  }
  const result = ConceptMapSchema.safeParse({ topicId: input.topicId, revision: input.revision + 1, nodes: [...nodes.values()], edges: [...edges.values()] });
  if (!result.success) throw new SceneError('INVALID_MAP_UPDATE', 'The map has missing references or exceeds its limits.');
  return result.data;
}

export const DiagramSpecSchema = z.object({
  id, title: z.string().min(1).max(120), template: z.enum(['process', 'comparison', 'hierarchy', 'timeline', 'labeled-diagram', 'fraction', 'number-line', 'equation', 'graph']),
  nodes: z.array(z.object({ id, label: z.string().min(1).max(120), detail: z.string().max(1000).optional(), conceptIds: refs.optional(), fraction: FractionSchema.optional(), range: NumberRangeSchema.optional(), plot: PlotSchema.optional() }).strict()).min(1).max(12),
  edges: z.array(MapEdgeSchema).max(24),
}).strict().superRefine((spec, ctx) => {
  const ids = new Set(spec.nodes.map(n => n.id));
  if (ids.size !== spec.nodes.length || new Set(spec.edges.map(e => e.id)).size !== spec.edges.length || spec.edges.some(e => !ids.has(e.from) || !ids.has(e.to))) ctx.addIssue({ code: 'custom', message: 'Diagram references must be unique and complete' });
  if (spec.template === 'fraction' && spec.nodes.some(n => !n.fraction)) ctx.addIssue({ code: 'custom', message: 'Fraction diagrams need exact part counts' });
  if (spec.template === 'number-line' && spec.nodes.some(n => !n.range)) ctx.addIssue({ code: 'custom', message: 'Number lines need bounds' });
  if (spec.template === 'graph' && spec.nodes.some(n => !n.plot)) ctx.addIssue({ code: 'custom', message: 'Graphs need data points and axis labels' });
});
export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;
/** Semantic content in; bounded, deterministic editable geometry out. No model code or markup. */
export function layoutDiagram(raw: DiagramSpec, existingBoard?: Board): BoardCommand[] {
  const parsed = DiagramSpecSchema.safeParse(raw);
  if (!parsed.success) throw new SceneError('INVALID_DIAGRAM', 'The diagram needs valid concepts and relationships.');
  const spec = parsed.data, columns = spec.template === 'comparison' ? 2 : ['equation', 'number-line', 'timeline', 'graph'].includes(spec.template) ? 1 : 3;
  const width = columns === 1 ? 620 : 230, gap = 50, height = spec.template === 'graph' ? 310 : spec.template === 'fraction' ? 180 : 145, rowHeight = height + 60;
  const positions = spec.nodes.map((_n, i) => ({ x: 40 + (i % columns) * (width + gap), y: 70 + Math.floor(i / columns) * rowHeight }));
  if (spec.template === 'hierarchy') {
    // Stable breadth-first levels. Cycles/disconnected nodes occupy a final level, never loop.
    const levels = new Map<string, number>(), indegree = new Map(spec.nodes.map(n => [n.id, 0]));
    for (const edge of spec.edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const queue = spec.nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
    for (const root of queue) levels.set(root, 0);
    for (let i = 0; i < queue.length; i++) for (const edge of spec.edges.filter(e => e.from === queue[i])) {
      levels.set(edge.to, Math.max(levels.get(edge.to) ?? 0, (levels.get(edge.from) ?? 0) + 1));
      indegree.set(edge.to, indegree.get(edge.to)! - 1); if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
    const last = Math.max(0, ...levels.values()) + 1, occupied = new Map<number, number>();
    for (const [i, n] of spec.nodes.entries()) {
      const row = queue.includes(n.id) ? levels.get(n.id) ?? 0 : last, col = occupied.get(row) ?? 0;
      occupied.set(row, col + 1); positions[i] = { x: 40 + col * (width + gap), y: 70 + row * rowHeight };
    }
  }
  const frame: BoardFrame = { id: spec.id, title: spec.title, x: 0, y: 0, width: Math.max(...positions.map(p => p.x + width)) + 40, height: Math.max(...positions.map(p => p.y + height)) + 40, author: 'tutor' };
  if (existingBoard) {
    const prior = existingBoard.frames?.find(value => value.id === spec.id);
    const replacing = new Set(spec.nodes.map(node => node.id));
    const occupied = [
      ...(existingBoard.frames ?? []).filter(value => value.id !== spec.id),
      ...existingBoard.nodes.filter(node => !replacing.has(node.id)).map(node => ({ x: node.x, y: node.y, width: node.width ?? 190, height: node.height ?? 130 })),
    ];
    const fits = ({ x, y }: { x: number; y: number }) => x >= -5000 && y >= -5000 && x + frame.width <= 5000 && y + frame.height <= 5000
      && occupied.every(rect => x + frame.width + 40 <= rect.x || x >= rect.x + rect.width + 40 || y + frame.height + 40 <= rect.y || y >= rect.y + rect.height + 40);
    let placement = prior && fits(prior) ? { x: prior.x, y: prior.y } : undefined;
    // Search a fixed bounded grid, preferring the existing positive canvas area.
    // Stable input yields stable placement; a crowded board fails visibly instead
    // of covering the learner's work or accepting out-of-bounds coordinates.
    const coordinates = [0, ...Array.from({ length: 24 }, (_, i) => (i + 1) * 200), ...Array.from({ length: 25 }, (_, i) => -(i + 1) * 200)];
    for (const y of coordinates) {
      if (placement) break;
      for (const x of coordinates) if (fits({ x, y })) { placement = { x, y }; break; }
    }
    if (!placement) throw new SceneError('DIAGRAM_SPACE_UNAVAILABLE', 'There is no clear space for this diagram. Remove unused objects or start a new lesson.');
    frame.x = placement.x; frame.y = placement.y;
  }
  const commands: BoardCommand[] = [{ type: 'upsert_frame', frame }];
  for (const [i, node] of spec.nodes.entries()) commands.push({ type: 'upsert_node', node: {
    id: node.id, label: node.label, detail: node.detail ?? '', kind: i === 0 ? 'root' : 'concept', frameId: spec.id,
    x: positions[i]!.x + frame.x, y: positions[i]!.y + frame.y, width, height, author: 'tutor', conceptIds: node.conceptIds ?? [node.id],
    shape: spec.template === 'fraction' ? 'fraction' : spec.template === 'number-line' ? 'number-line' : spec.template === 'equation' ? 'equation' : spec.template === 'graph' ? 'graph' : 'card',
    ...(node.fraction ? { fraction: node.fraction } : {}), ...(node.range ? { range: node.range } : {}), ...(node.plot ? { plot: node.plot } : {}),
    description: `${node.label}. ${node.detail ?? ''}`.trim(),
  } });
  for (const edge of spec.edges) commands.push({ type: 'upsert_edge', edge: { ...edge, author: 'tutor' } });
  return commands;
}

export const LessonFocusSchema = z.object({ goal: z.string().max(500), currentConceptId: id.optional(), nextStep: z.string().max(500), phase: z.enum(['diagnose', 'explain', 'practice', 'reflect']).optional() }).strict();
export const TeachingBeatProposalSchema = z.object({ spokenText: z.string().trim().min(1).max(600), displayText: z.string().trim().min(1).max(900), conceptIds: refs.default([]), boardCommands: z.array(BoardCommandSchema).max(40).default([]), highlightNodeIds: refs.default([]), sourceRefs: z.array(z.string().max(200)).max(12).default([]), mapUpdate: MapUpdateSchema.optional(), focus: LessonFocusSchema.optional(), spatialUpdate: SpatialSelectionSchema.optional() }).strict();
export type TeachingBeatProposal = z.infer<typeof TeachingBeatProposalSchema>;
export const TeachingBeatSchema = TeachingBeatProposalSchema.extend({ beatId: id, turnId: z.string().min(1).max(150), messageId: id, outputEpoch: revision, status: z.enum(['planned', 'ready', 'playing', 'completed', 'interrupted', 'failed']), expectedBoardRevision: revision, boardRevision: revision.optional(), playedMs: z.number().nonnegative().optional(), warnings: z.array(z.string().max(300)).max(8).optional() });
export type TeachingBeat = z.infer<typeof TeachingBeatSchema>;
export interface BoardAdapter { getBoard(): Board; apply(board: Board): void; fitFrame(frameId?: string): void; exportSvg(): string; }
export const ExplainImageSchema = z.object({ text: z.string().trim().min(1).max(1000), selection: SelectionContextSchema.optional(), image: z.object({ mimeType: z.literal('image/png'), data: z.string().min(40).max(1_398_104).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict() }).strict();
