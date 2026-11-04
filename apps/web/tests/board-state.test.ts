import { describe, expect, it } from 'vitest';
import { applyBoardTransaction, SelectionContextSchema, type Board } from '@milli/contracts';
import { boardDiff, localBoardChange, rebaseBoard } from '../src/lib/board-state';
import { boardBounds, boardFocusTarget, connectorAnchors, exportBoardSvg, fitViewport, zoomViewport } from '../src/lib/board-geometry';

function seed(): Board { return { revision: 0, nodes: [{ id: 'a', label: 'Sunlight', detail: 'Energy for plants', kind: 'concept', x: 0, y: 0, author: 'tutor' }, { id: 'b', label: 'Sugar', detail: 'Stored energy', kind: 'concept', x: 300, y: 0, author: 'tutor' }], edges: [{ id: 'ab', from: 'a', to: 'b', label: 'helps make', author: 'tutor' }] }; }
const edit = (board: Board, label: string) => localBoardChange(board, [{ type: 'upsert_node', node: { ...board.nodes[0]!, label } }]);
describe('student board history and remote changes', () => {
  it('undoes only the local edit while retaining a later tutor addition', () => {
    const before = seed(), changed = edit(before, 'My observation'), undo = boardDiff(changed, before);
    const remote = applyBoardTransaction(changed, { operationId: 'remote-1', expectedRevision: changed.revision!, commands: [{ type: 'upsert_node', node: { id: 'c', label: 'Chlorophyll', detail: 'Absorbs light', x: 150, y: 200, kind: 'detail' } }] }, 'tutor');
    const restored = localBoardChange(remote, undo);
    expect(restored.nodes.find(n => n.id === 'a')?.label).toBe('Sunlight');
    expect(restored.nodes.find(n => n.id === 'c')?.label).toBe('Chlorophyll');
    expect(restored.edges).toHaveLength(1);
  });
  it('rebases an annotation around unrelated tutor edits without losing either', () => {
    const before = seed(), draft = localBoardChange(before, [{ type: 'upsert_node', node: { id: 'drawing-1', label: 'My drawing', detail: '', shape: 'annotation', kind: 'detail', x: 30, y: 40, points: [{ x: 0, y: 0 }, { x: 20, y: 10 }] } }]);
    const remote = applyBoardTransaction(before, { operationId: 'remote-2', expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...before.nodes[1]!, detail: 'Chemical energy stored in sugar' } }] }, 'tutor');
    const result = rebaseBoard(before, remote, draft);
    expect(result.conflict).toBe(false);
    expect(result.board.nodes.find(n => n.id === 'drawing-1')?.author).toBe('student');
    expect(result.board.nodes.find(n => n.id === 'b')?.detail).toBe('Chemical energy stored in sugar');
  });
  it('surfaces competing edits without replacing the student’s pending text', () => {
    const before = seed(), draft = edit(before, 'My pending words');
    const remote = applyBoardTransaction(before, { operationId: 'remote-3', expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...before.nodes[0]!, detail: 'A new tutor explanation' } }] }, 'tutor');
    const result = rebaseBoard(before, remote, draft);
    expect(result.conflict).toBe(true);
    expect(result.board.nodes[0]!.label).toBe('My pending words');
    expect(before.nodes[0]!.label).toBe('Sunlight');
  });
  it('handles a full-capacity reset and undo as bounded reducer transactions', () => {
    const board: Board = { revision: 0, nodes: Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, label: `Idea ${i}`, detail: '', kind: 'concept', x: i % 10 * 200, y: Math.floor(i / 10) * 150 })), edges: Array.from({ length: 240 }, (_, i) => ({ id: `e${i}`, from: `n${i % 120}`, to: `n${(i + 1) % 120}` })) };
    const reset = localBoardChange(board, board.nodes.map(node => ({ type: 'remove_node', id: node.id })));
    expect(reset.nodes).toHaveLength(0); expect(reset.edges).toHaveLength(0);
    const restored = localBoardChange(reset, boardDiff(reset, board));
    expect(restored.nodes).toHaveLength(120); expect(restored.edges).toHaveLength(240);
    expect(restored.nodes.map(node => node.id)).toEqual(board.nodes.map(node => node.id));
  });
});
describe('safe portable board export', () => {
  it('focuses a tutor diagram frame and uses all ideas for targets spanning frames', () => {
    const board = seed(); board.frames = [{ id: 'process', title: 'New explanation', x: 1100, y: 0, width: 800, height: 400 }];
    board.nodes.push({ id: 'new', label: 'New idea', detail: '', kind: 'concept', x: 1140, y: 80, frameId: 'process' });
    const target = boardFocusTarget(board, ['new'])!;
    expect(target.frameId).toBe('process');
    const view = fitViewport(target.bounds, 800, 320);
    expect((1140 - view.x) * view.zoom).toBeGreaterThanOrEqual(0);
    expect((1140 + 190 - view.x) * view.zoom).toBeLessThanOrEqual(800);
    expect(boardFocusTarget(board, ['a', 'new'])?.frameId).toBe('');
    expect(boardFocusTarget(board, ['a', 'new'])!.bounds.width).toBeGreaterThan(1300);
    expect(boardFocusTarget(board, ['missing'])).toBeUndefined();
  });
  it('keeps selection context valid when fitting and zooming near the world boundary', () => {
    const fit = fitViewport({ x: -4935, y: -4935, width: 90, height: 90 }, 800, 450);
    const outward = zoomViewport(fit, .1, 800, 450);
    for (const viewport of [fit, outward, zoomViewport({ x: 4900, y: 4900, zoom: .1 }, 10, 800, 450)]) {
      expect(SelectionContextSchema.safeParse({ shapeIds: ['edge-idea'], conceptIds: [], boardRevision: 0, viewport }).success).toBe(true);
      expect(Object.values(viewport).every(Number.isFinite)).toBe(true);
    }
    expect(fit.x).toBeLessThanOrEqual(-4890);
    expect(fit.x + 800 / fit.zoom).toBeGreaterThan(-4880);
  });
  it('keeps horizontal and diagonal relationship arrows outside opaque card interiors', () => {
    const source = { x: 0, y: 0, width: 200, height: 100 }, target = { x: 300, y: 0, width: 200, height: 100 };
    const horizontal = connectorAnchors(source, target);
    expect(horizontal).toEqual({ x1: 202, y1: 50, x2: 295, y2: 50 });
    const diagonal = connectorAnchors(source, { ...target, y: 300 });
    expect(Object.values(diagonal).every(Number.isFinite)).toBe(true);
    expect(diagonal.y1).toBeGreaterThan(100);
    expect(diagonal.y2).toBeLessThan(300);
    expect(Object.values(connectorAnchors(source, source)).every(Number.isFinite)).toBe(true);
  });
  it('renders hostile-looking labels as escaped text, never executable markup or links', () => {
    const board = seed(); board.nodes[0]!.label = '</text><script>alert(1)</script>'; board.nodes[0]!.detail = '<image href="https://example.invalid/pixel" onload="bad()"/> & notes';
    const svg = exportBoardSvg(board);
    expect(svg).not.toContain('<script>'); expect(svg).not.toContain('<image '); expect(svg).not.toContain('foreignObject');
    expect(svg).toContain('&lt;script&gt;'); expect(svg).toContain('&amp; notes');
    expect(svg).not.toContain('href="https:');
  });
  it('exports only explicitly selected objects and their internal relationships', () => {
    const board = seed(), svg = exportBoardSvg(board, ['a']);
    expect(svg).toContain('Sunlight'); expect(svg).not.toContain('Sugar'); expect(svg).not.toContain('helps make');
    expect(boardBounds(board, ['a']).width).toBeLessThan(boardBounds(board).width);
  });
  it('renders exact fraction parts and finite graph geometry with zero-span values', () => {
    const board = seed(); board.nodes = [{ ...board.nodes[0]!, shape: 'fraction', fraction: { numerator: 1, denominator: 4 } }, { ...board.nodes[1]!, shape: 'graph', width: 400, height: 240, plot: { points: [{ x: 2, y: 7 }, { x: 2, y: 7 }], xLabel: 'Time', yLabel: 'Value' } }];
    const svg = exportBoardSvg(board);
    expect(svg).toContain('1 / 4'); expect(svg).toContain('Time'); expect(svg).toContain('(2, 7)');
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});
