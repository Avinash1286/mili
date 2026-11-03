import { describe, expect, it } from 'vitest';
import { BoardSchema, SendMessageSchema, UpdateBoardSchema } from './index';

describe('shared trust-boundary contracts', () => {
  const node = { id: 'sun', label: 'Sunlight', detail: 'Energy', x: 0, y: 0, kind: 'concept' };
  it('rejects graphs with dangling edges and duplicate identities', () => {
    expect(BoardSchema.safeParse({ nodes: [node], edges: [{ id: 'e', from: 'sun', to: 'missing' }] }).success).toBe(false);
    expect(BoardSchema.safeParse({ nodes: [node, node], edges: [] }).success).toBe(false);
  });
  it('bounds student input and requires a revision for edits', () => {
    expect(SendMessageSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(SendMessageSchema.safeParse({ text: 'a'.repeat(2001) }).success).toBe(false);
    expect(UpdateBoardSchema.safeParse({ board: { nodes: [node], edges: [] } }).success).toBe(false);
  });
  it('accepts an editable valid scene and trims input', () => {
    expect(BoardSchema.parse({ nodes: [node], edges: [] }).nodes[0]?.id).toBe('sun');
    expect(SendMessageSchema.parse({ text: ' Why? ' }).text).toBe('Why?');
  });
});
