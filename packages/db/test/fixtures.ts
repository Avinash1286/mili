import { randomUUID } from 'node:crypto';
import type { Session } from '@tokai/contracts';
export function lesson(): Session {
  const now = new Date().toISOString();
  return { id: randomUUID(), topic: 'photosynthesis', title: 'A stored lesson', mode: 'sample', status: 'active', createdAt: now, updatedAt: now, revision: 0, messages: [], board: { nodes: [], edges: [], revision: 0 }, concepts: [], flashcards: [] };
}
