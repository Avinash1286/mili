import { describe, expect, it } from 'vitest';
import { applyBoardTransaction, applyMapUpdate, BoardSchema, DiagramSpecSchema, emptyConceptMap, layoutDiagram, pruneMapBoardReferences, resolveSelection, type Board, type BoardCommand } from './scene';

const base = (): Board => ({ nodes: [{ id: 'sun', label: 'Sunlight', detail: 'Energy', kind: 'concept', x: 0, y: 0 }], edges: [] });
const tx = (commands: BoardCommand[], expectedRevision = 0) => ({ operationId: 'operation-1', expectedRevision, commands });
describe('semantic board transactions', () => {
  it('migrates legacy board data without losing its stable object IDs', () => {
    const board = BoardSchema.parse(base());
    const next = applyBoardTransaction(board, tx([{ type: 'upsert_node', node: { ...board.nodes[0]!, x: 50 } }]), 'student');
    expect(next.revision).toBe(1); expect(next.nodes[0]).toMatchObject({ id: 'sun', x: 50, author: 'student', revision: 1 });
    expect(board.nodes[0]!.x).toBe(0);
  });
  it('rejects a whole transaction when its last operation leaves a dangling edge', () => {
    const board = base(), snapshot = structuredClone(board);
    expect(() => applyBoardTransaction(board, tx([{ type: 'upsert_node', node: { ...board.nodes[0]!, x: 200 } }, { type: 'upsert_edge', edge: { id: 'bad', from: 'sun', to: 'missing' } }]), 'tutor')).toThrow();
    expect(board).toEqual(snapshot);
  });
  it('rejects stale versions without considering unrelated session state', () => {
    const board = { ...base(), revision: 3 };
    expect(() => applyBoardTransaction(board, tx([{ type: 'remove_node', id: 'sun' }], 2), 'student')).toThrow('board changed');
    expect(applyBoardTransaction(board, tx([{ type: 'remove_node', id: 'sun' }], 3), 'student').revision).toBe(4);
  });
  it('protects student nodes and attached student connectors from tutor deletion', () => {
    const board = base(); board.nodes[0]!.author = 'student';
    expect(() => applyBoardTransaction(board, tx([{ type: 'remove_node', id: 'sun' }]), 'tutor')).toThrow('student work');
    board.nodes[0]!.author = 'tutor'; board.nodes.push({ ...board.nodes[0]!, id: 'leaf' });
    board.edges.push({ id: 'edge', from: 'sun', to: 'leaf', author: 'student' });
    expect(() => applyBoardTransaction(board, tx([{ type: 'remove_node', id: 'sun' }]), 'tutor')).toThrow('student work');
    expect(applyBoardTransaction(board, tx([{ type: 'remove_node', id: 'sun' }]), 'student').edges).toEqual([]);
  });
  it('does not trust client-provided authorship or object revisions', () => {
    const board = base();
    const next = applyBoardTransaction(board, tx([{ type: 'upsert_node', node: { ...board.nodes[0]!, author: 'tutor', revision: 900 } }]), 'student');
    expect(next.nodes[0]).toMatchObject({ author: 'student', revision: 1 });
  });
  it('rejects invalid annotation bounds, invented commands and nonempty frame deletion', () => {
    expect(BoardSchema.safeParse({ nodes: [{ ...base().nodes[0], shape: 'annotation', points: [{ x: Infinity, y: 0 }] }], edges: [] }).success).toBe(false);
    expect(() => applyBoardTransaction(base(), tx([{ type: 'execute', script: 'alert(1)' } as unknown as BoardCommand]), 'tutor')).toThrow();
    const board = applyBoardTransaction(base(), tx([{ type: 'upsert_frame', frame: { id: 'frame', title: 'A frame', x: 0, y: 0, width: 800, height: 500 } }, { type: 'upsert_node', node: { ...base().nodes[0]!, frameId: 'frame' } }]), 'student');
    expect(() => applyBoardTransaction(board, tx([{ type: 'remove_frame', id: 'frame' }], 1), 'student')).toThrow('frame contents');
  });
});
describe('semantic selection', () => {
  it('resolves real semantics rather than trusting client concept labels', () => {
    const result = resolveSelection(base(), { shapeIds: ['sun'], conceptIds: ['invented'], boardRevision: 0 });
    expect(result.status).toBe('resolved'); expect(result.conceptIds).toEqual(['sun']);
  });
  it('asks clarification for stale, missing and ambiguous references', () => {
    const board = base(); board.nodes.push({ ...board.nodes[0]!, id: 'leaf' });
    expect(resolveSelection(board, { shapeIds: ['sun'], conceptIds: [], boardRevision: 1 }).status).toBe('stale');
    expect(resolveSelection(board, { shapeIds: ['missing'], conceptIds: [], boardRevision: 0 }).status).toBe('stale');
    expect(resolveSelection(board, { shapeIds: ['sun', 'leaf'], conceptIds: [], boardRevision: 0 }).status).toBe('ambiguous');
  });
});
describe('concept maps and deterministic layouts', () => {
  it('prunes deleted board links without deleting concepts, messages or card history', () => {
    const map = applyMapUpdate(emptyConceptMap('photosynthesis'), { topicId: 'photosynthesis', expectedRevision: 0, mode: 'merge', nodes: [{ id: 'light', label: 'Light energy', status: 'introduced', boardNodeIds: ['sun', 'deleted'], messageIds: ['message'], cardIds: ['card'] }], edges: [] }, 'student');
    const next = pruneMapBoardReferences(map, base());
    expect(next.revision).toBe(2); expect(next.nodes[0]).toMatchObject({ id: 'light', boardNodeIds: ['sun'], messageIds: ['message'], cardIds: ['card'] });
    expect(map.nodes[0]!.boardNodeIds).toEqual(['sun', 'deleted']); expect(pruneMapBoardReferences(next, base())).toBe(next);
  });
  it('keeps merged concept positions stable and rejects dangling relationships atomically', () => {
    const map = applyMapUpdate(emptyConceptMap('photosynthesis'), { topicId: 'photosynthesis', expectedRevision: 0, mode: 'merge', nodes: [{ id: 'sun', label: 'Sunlight', status: 'introduced', x: 73, y: 82 }], edges: [] }, 'student');
    const merged = applyMapUpdate(map, { topicId: map.topicId, expectedRevision: 1, mode: 'merge', nodes: [{ id: 'sun', label: 'Light energy', status: 'introduced', x: 0, y: 0 }], edges: [] }, 'tutor');
    expect(merged.nodes[0]).toMatchObject({ x: 73, y: 82, label: 'Sunlight', author: 'student' });
    expect(() => applyMapUpdate(map, { topicId: map.topicId, expectedRevision: 1, mode: 'merge', nodes: [], edges: [{ id: 'edge', from: 'sun', to: 'missing' }] }, 'tutor')).toThrow();
    expect(map.revision).toBe(1);
  });
  it('rejects cross-topic changes, duplicate IDs and invented mastery', () => {
    const map = emptyConceptMap('fractions');
    const update = { topicId: 'fractions', expectedRevision: 0, mode: 'merge' as const, nodes: [{ id: 'half', label: 'One half', status: 'understood' as const }], edges: [] };
    expect(() => applyMapUpdate(map, { ...update, topicId: 'circuits' }, 'tutor')).toThrow();
    expect(() => applyMapUpdate(map, update, 'tutor')).toThrow('evidence');
    expect(() => applyMapUpdate(map, { ...update, nodes: [...update.nodes, ...update.nodes] }, 'student')).toThrow('Duplicate');
  });
  it('does not let tutor replacement erase student map work', () => {
    const map = applyMapUpdate(emptyConceptMap('fractions'), { topicId: 'fractions', expectedRevision: 0, mode: 'merge', nodes: [{ id: 'half', label: 'My question', status: 'question' }], edges: [] }, 'student');
    expect(() => applyMapUpdate(map, { topicId: 'fractions', expectedRevision: 1, mode: 'replace', nodes: [], edges: [] }, 'tutor')).toThrow('student work');
  });
  it('preserves the learner’s relationship labels when tutor maps merge', () => {
    const map = applyMapUpdate(emptyConceptMap('fractions'), { topicId: 'fractions', expectedRevision: 0, mode: 'merge', nodes: [{ id: 'half', label: 'One half', status: 'introduced' }, { id: 'quarter', label: 'One quarter', status: 'introduced' }], edges: [{ id: 'link', from: 'half', to: 'quarter', label: 'My comparison' }] }, 'student');
    const next = applyMapUpdate(map, { topicId: 'fractions', expectedRevision: 1, mode: 'merge', nodes: [], edges: [{ id: 'link', from: 'quarter', to: 'half', label: 'Replacement' }] }, 'tutor');
    expect(next.edges[0]).toMatchObject({ from: 'half', to: 'quarter', label: 'My comparison', author: 'student' });
  });
  it('creates reproducible editable fraction diagrams with validated exact units', () => {
    const spec = DiagramSpecSchema.parse({ id: 'fractions-frame', title: 'Equivalent parts', template: 'fraction', nodes: [{ id: 'half', label: 'One half', fraction: { numerator: 1, denominator: 2 } }, { id: 'quarters', label: 'Two quarters', fraction: { numerator: 2, denominator: 4 } }], edges: [{ id: 'equivalent', from: 'half', to: 'quarters', label: 'same amount' }] });
    const commands = layoutDiagram(spec); expect(commands).toEqual(layoutDiagram(spec));
    expect(DiagramSpecSchema.safeParse({ ...spec, edges: [...spec.edges, ...spec.edges] }).success).toBe(false);
    const board = applyBoardTransaction({ nodes: [], edges: [] }, tx(commands), 'tutor');
    expect(board.nodes[0]).toMatchObject({ id: 'half', shape: 'fraction', fraction: { numerator: 1, denominator: 2 }, frameId: 'fractions-frame' });
    expect(DiagramSpecSchema.safeParse({ ...spec, nodes: [{ id: 'bad', label: 'Invalid whole', fraction: { numerator: 3, denominator: 2 } }] }).success).toBe(false);
  });
  it('lays out hierarchy levels deterministically and terminates on cyclic relations', () => {
    const spec = { id: 'tree', title: 'Hierarchy', template: 'hierarchy' as const, nodes: [{ id: 'root', label: 'Root' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'ra', from: 'root', to: 'a' }, { id: 'rb', from: 'root', to: 'b' }] };
    const board = applyBoardTransaction({ nodes: [], edges: [] }, tx(layoutDiagram(spec)), 'tutor');
    expect(board.nodes[0]!.y).toBeLessThan(board.nodes[1]!.y); expect(board.nodes[1]!.y).toBe(board.nodes[2]!.y);
    expect(board.nodes[1]!.x).not.toBe(board.nodes[2]!.x);
    const cyclic = { ...spec, edges: [...spec.edges, { id: 'ar', from: 'a', to: 'root' }] };
    expect(() => applyBoardTransaction({ nodes: [], edges: [] }, tx(layoutDiagram(cyclic)), 'tutor')).not.toThrow();
  });
  it('places new diagrams clear of saved work and preserves their placement on revision', () => {
    const spec = { id: 'new-frame', title: 'New diagram', template: 'process' as const, nodes: [{ id: 'new-idea', label: 'New idea' }], edges: [] };
    const original = base(); original.nodes[0] = { ...original.nodes[0]!, author: 'student', width: 220, height: 150 };
    const commands = layoutDiagram(spec, original);
    expect(commands).toEqual(layoutDiagram(spec, original));
    const board = applyBoardTransaction(original, tx(commands), 'tutor'), frame = board.frames![0]!;
    expect(frame.x >= 260 || frame.y >= 190 || frame.x + frame.width <= -40 || frame.y + frame.height <= -40).toBe(true);
    expect(board.nodes[0]).toEqual(original.nodes[0]);
    const updated = applyBoardTransaction(board, tx(layoutDiagram({ ...spec, title: 'Revised diagram' }, board), board.revision), 'tutor');
    expect(updated.frames![0]).toMatchObject({ x: frame.x, y: frame.y, title: 'Revised diagram' });
    expect(updated.nodes[1]!.x).toBe(board.nodes[1]!.x);
  });
  it('rejects diagram placement when the bounded canvas has no clear space', () => {
    const full: Board = { nodes: [], edges: [], frames: [-5000, 0].flatMap((x, i) => [-5000, 0].map((y, j) => ({ id: `occupied-${i}-${j}`, title: 'Occupied', x, y, width: 5000, height: 5000 }))) };
    expect(() => layoutDiagram({ id: 'new-frame', title: 'New diagram', template: 'process', nodes: [{ id: 'new-idea', label: 'New idea' }], edges: [] }, full)).toThrow('no clear space');
  });
  it('plots explicit bounded data without accepting executable expressions', () => {
    const spec = { id: 'plot', title: 'Time and distance', template: 'graph' as const, nodes: [{ id: 'distance', label: 'Constant speed', plot: { points: [{ x: 0, y: 0 }, { x: 2, y: 6 }], xLabel: 'Time (seconds)', yLabel: 'Distance (metres)' } }], edges: [] };
    const board = applyBoardTransaction({ nodes: [], edges: [] }, tx(layoutDiagram(spec)), 'tutor');
    expect(board.nodes[0]).toMatchObject({ shape: 'graph', plot: spec.nodes[0]!.plot });
    expect(DiagramSpecSchema.safeParse({ ...spec, nodes: [{ id: 'code', label: 'Code', expression: 'fetch("https://example.com")' }] }).success).toBe(false);
  });
});
