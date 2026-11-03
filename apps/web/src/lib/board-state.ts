import { applyBoardTransaction, type Board, type BoardCommand, type BoardTransaction } from '@tokai/contracts';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'revision' && item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function boardDiff(before: Board, after: Board): BoardCommand[] {
  const commands: BoardCommand[] = [];
  for (const edge of before.edges) if (!after.edges.some(e => e.id === edge.id)) commands.push({ type: 'remove_edge', id: edge.id });
  for (const node of before.nodes) if (!after.nodes.some(n => n.id === node.id)) commands.push({ type: 'remove_node', id: node.id });
  for (const frame of after.frames ?? []) if (!same(frame, before.frames?.find(f => f.id === frame.id))) commands.push({ type: 'upsert_frame', frame });
  for (const node of after.nodes) if (!same(node, before.nodes.find(n => n.id === node.id))) commands.push({ type: 'upsert_node', node });
  for (const edge of after.edges) if (!same(edge, before.edges.find(e => e.id === edge.id))) commands.push({ type: 'upsert_edge', edge });
  for (const frame of before.frames ?? []) if (!after.frames?.some(f => f.id === frame.id)) commands.push({ type: 'remove_frame', id: frame.id });
  return commands;
}
export function localBoardChange(board: Board, commands: BoardCommand[]): Board {
  if (!commands.length) return board;
  // Large reset/undo gestures are still one UI action, but each reducer call stays bounded.
  let next = board;
  for (let i = 0; i < commands.length; i += 100) next = applyBoardTransaction(next, { operationId: crypto.randomUUID(), expectedRevision: next.revision ?? 0, commands: commands.slice(i, i + 100) }, 'student');
  return next;
}
export function boardTransaction(base: Board, draft: Board): BoardTransaction { return { operationId: crypto.randomUUID(), expectedRevision: base.revision ?? 0, commands: boardDiff(base, draft) }; }
export function rebaseBoard(base: Board, incoming: Board, draft: Board): { board: Board; conflict: boolean } {
  const changes = boardDiff(base, draft), remote = boardDiff(base, incoming);
  const key = (command: BoardCommand) => command.type.endsWith('node') ? `node:${'node' in command ? command.node.id : 'id' in command ? command.id : ''}` : command.type.endsWith('edge') ? `edge:${'edge' in command ? command.edge.id : 'id' in command ? command.id : ''}` : `frame:${'frame' in command ? command.frame.id : 'id' in command ? command.id : ''}`;
  if (changes.some(change => remote.some(other => key(change) === key(other)))) return { board: draft, conflict: true };
  try { return { board: localBoardChange(incoming, changes), conflict: false }; } catch { return { board: draft, conflict: true }; }
}
