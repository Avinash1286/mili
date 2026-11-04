import { expect, test, type Page } from '@playwright/test';
import { fixtureTransport, openLiveLesson, type TransportEvent } from '../fixtures/browser.js';
import { DELAYED_VISUAL_REQUEST, VISUAL_FRAME_ID, VISUAL_REQUEST } from '../fixtures/teaching.js';

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: /question/i }).fill(text);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
}
async function startOutput(page: Page, events: TransportEvent[]) {
  await page.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => events.some(event => event.type === 'session.ready')).toBe(true);
}
async function addStudentShape(page: Page, label = 'My energy model') {
  await page.getByRole('button', { name: 'Add shape', exact: true }).click();
  await page.getByRole('combobox', { name: 'Shape type', exact: true }).selectOption('rectangle');
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.getByRole('textbox', { name: 'Your note', exact: true }).fill('My retained note: light supplies energy, not matter.');
  await page.getByRole('button', { name: 'Add to board', exact: true }).click();
  return page.locator('.board-node').filter({ hasText: label });
}

test('student semantic shapes support keyboard movement, undo, persistence, grounding and export', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  const node = await addStudentShape(page);
  await expect(node).toBeVisible();
  const beforeMove = await node.getAttribute('transform');
  await node.focus(); await page.keyboard.press('ArrowRight');
  await expect(node).not.toHaveAttribute('transform', beforeMove!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(node).toHaveAttribute('transform', beforeMove!);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(node).not.toHaveAttribute('transform', beforeMove!);
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(node).toBeVisible();
  await node.click();
  await page.getByRole('button', { name: 'Explain selected idea', exact: true }).click();
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-tutor').last()).toContainText('Selected concept: My energy model');
  await expect(page.locator('.message-tutor').last()).toContainText('My retained note');
  await page.getByRole('button', { name: 'Delete selected shapes', exact: true }).click();
  await expect(node).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(node).toBeVisible();
  await page.getByLabel('Board export and reset').click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('tokai-board.svg');
  await page.getByLabel('Board export and reset').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Whiteboard', exact: true }).click();
  await page.getByRole('button', { name: 'Fit frame', exact: true }).click();
  await page.getByLabel('Board export and reset').click();
  const exportMenu = await page.locator('.board-more > div').boundingBox();
  expect(exportMenu).not.toBeNull();
  expect(exportMenu!.x).toBeGreaterThanOrEqual(0);
  expect(exportMenu!.x + exportMenu!.width).toBeLessThanOrEqual(390);
  await page.getByLabel('Board export and reset').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/tokai-phase-3-mobile.png', fullPage: true });
  expect(transport.errors).toEqual([]);
});

test('a board conflict preserves the local draft until the learner discards it', async ({ page, context }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  const node = await addStudentShape(page);
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  const other = await context.newPage();
  const otherTransport = await fixtureTransport(other);
  await other.goto(page.url());
  await expect(other.locator('.board-node').filter({ hasText: 'My energy model' })).toBeVisible();
  await node.click();
  await page.getByRole('button', { name: 'Edit My energy model', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your note', exact: true }).fill('My unsaved local explanation.');
  await page.getByRole('button', { name: 'Apply edit', exact: true }).click();
  await other.locator('.board-node').filter({ hasText: 'My energy model' }).click();
  await other.getByRole('button', { name: 'Edit My energy model', exact: true }).click();
  await other.getByRole('textbox', { name: 'Your note', exact: true }).fill('The newer explanation saved in the other tab.');
  await other.getByRole('button', { name: 'Apply edit', exact: true }).click();
  await other.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(other.getByText('Changes saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /changed|conflict/i })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected concept', exact: true })).toContainText('My unsaved local explanation.');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await node.click();
  await expect(page.getByRole('region', { name: 'Selected concept', exact: true })).toContainText('The newer explanation saved in the other tab.');
  expect(transport.errors).toEqual([]); expect(otherTransport.errors).toEqual([]);
  await other.close();
});

test('board image preview stays local until explicit sharing', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const shares: { image: { data: string; mimeType: string }; text: string }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/explain-image')) shares.push(request.postDataJSON()); });
  await openLiveLesson(page);
  const node = await addStudentShape(page, 'My shared drawing');
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await node.click();
  await page.getByRole('button', { name: 'Preview drawing to share', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Share just this drawing.' })).toBeVisible();
  await expect(page.getByAltText('Preview of the selected board objects to share')).toBeVisible();
  expect(shares).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel drawing share', exact: true }).click();
  expect(shares).toHaveLength(0);
  await page.getByRole('button', { name: 'Preview drawing to share', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('What does this drawing communicate?');
  await page.getByRole('button', { name: 'Share drawing with tutor', exact: true }).click();
  await expect(page.locator('.message-tutor').last()).toContainText('Fixture crop explanation');
  expect(shares).toHaveLength(1);
  expect(shares[0]!.image.mimeType).toBe('image/png');
  const png = Buffer.from(shares[0]!.image.data, 'base64');
  expect(png.length).toBeLessThanOrEqual(1024 * 1024);
  expect(png.readUInt32BE(16)).toBeLessThanOrEqual(1024);
  expect(png.readUInt32BE(20)).toBeLessThanOrEqual(1024);
  expect(transport.errors).toEqual([]);
});

test('concept map links, accessible list and keyboard arrangement survive saving', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await ask(page, VISUAL_REQUEST);
  await page.getByRole('combobox', { name: 'Frame', exact: true }).selectOption(VISUAL_FRAME_ID);
  await expect(page.locator('.board-node[data-node-id="fixture-sugar"]')).toBeVisible();
  await page.getByRole('tab', { name: 'Concepts', exact: true }).click();
  const light = page.locator('.concept-map-panel').getByRole('button', { name: /Light energy.*introduced/ });
  await expect(light).toBeVisible();
  const before = await light.getAttribute('transform');
  await light.focus(); await page.keyboard.press('ArrowRight');
  await expect(light).not.toHaveAttribute('transform', before!);
  const after = await light.getAttribute('transform');
  await page.getByRole('button', { name: 'Save map positions', exact: true }).click();
  await expect(page.getByText('Arrangement not saved', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Concepts', exact: true }).click();
  await expect(light).toHaveAttribute('transform', after!);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const list = page.getByLabel('Concept map list');
  await expect(list).toContainText('Light energy'); await expect(list).toContainText('Sugar building');
  await expect(list).toContainText('powers');
  await list.getByRole('button', { name: /Light energy/ }).click();
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Conversation evidence (1)', exact: true })).toBeEnabled();
  await list.getByRole('button', { name: /Sugar building/ }).click();
  await expect(page.getByRole('button', { name: 'Review cards (1)', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review cards (1)', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Cards', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(transport.errors).toEqual([]);
});

test('visual readiness gates audio and interruption discards the next visual beat', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await startOutput(page, transport.events);
  transport.holdClientEvents(event => event.type === 'board.ready');
  await ask(page, VISUAL_REQUEST);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toBeVisible();
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'board.ready')).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Frame', exact: true })).toHaveValue(VISUAL_FRAME_ID);
  expect(transport.trace.filter(entry => entry.event.type === 'audio.chunk')).toHaveLength(0);
  transport.releaseClientEvents();
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'playback.ack' && event.status === 'started')).toBe(true);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toHaveClass(/node-highlighted/);
  const readyIndex = transport.trace.findIndex(entry => entry.direction === 'client' && entry.event.type === 'board.ready');
  const chunkIndex = transport.trace.findIndex(entry => entry.event.type === 'audio.chunk');
  expect(readyIndex).toBeGreaterThanOrEqual(0);
  expect(chunkIndex).toBeGreaterThan(readyIndex);
  const priorCancels = transport.events.filter(event => event.type === 'audio.cancel').length;
  await page.getByRole('button', { name: 'Stop tutor', exact: true }).click();
  await expect.poll(() => transport.events.filter(event => event.type === 'audio.cancel').length).toBeGreaterThan(priorCancels);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).not.toHaveClass(/node-highlighted/);
  // Wait beyond the fixture's generation/tail delay; a stale callback must not create the next visual.
  await page.waitForTimeout(1600);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toBeVisible();
  await expect(page.locator('.board-node[data-node-id="fixture-sugar"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.reload();
  await page.getByRole('combobox', { name: 'Frame', exact: true }).selectOption(VISUAL_FRAME_ID);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toBeVisible();
  await expect(page.locator('.board-node[data-node-id="fixture-sugar"]')).toHaveCount(0);
  expect(transport.errors).toEqual([]);
});

test('successive visual beats advance only after playback completion and persist after reload', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await startOutput(page, transport.events);
  await ask(page, VISUAL_REQUEST);
  await expect.poll(() => transport.clientEvents.filter(event => event.type === 'playback.ack' && event.status === 'completed').length).toBe(2);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toBeVisible();
  await expect(page.locator('.board-node[data-node-id="fixture-sugar"]')).toBeVisible();
  const starts = transport.events.filter(event => event.type === 'audio.start');
  expect(starts).toHaveLength(2);
  const firstComplete = transport.trace.findIndex(entry => entry.direction === 'client' && entry.event.type === 'playback.ack' && entry.event.status === 'completed' && entry.event.streamId === starts[0]!.streamId);
  const secondStart = transport.trace.findIndex(entry => entry.direction === 'server' && entry.event.type === 'audio.start' && entry.event.streamId === starts[1]!.streamId);
  expect(firstComplete).toBeGreaterThanOrEqual(0);
  expect(secondStart).toBeGreaterThan(firstComplete);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.reload();
  await page.getByRole('combobox', { name: 'Frame', exact: true }).selectOption(VISUAL_FRAME_ID);
  await expect(page.locator('.board-node[data-node-id="fixture-sugar"]')).toBeVisible();
  await page.screenshot({ path: 'test-results/tokai-phase-3-visuals.png', fullPage: true });
  expect(transport.errors).toEqual([]);
});

test('a cancelled model completion cannot apply a late diagram', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await startOutput(page, transport.events);
  await ask(page, DELAYED_VISUAL_REQUEST);
  await expect(page.locator('.message-student').last()).toContainText(DELAYED_VISUAL_REQUEST);
  await page.getByRole('button', { name: 'Stop tutor', exact: true }).click();
  await page.waitForTimeout(1600);
  expect(transport.events.filter(event => event.type === 'board.patch')).toHaveLength(0);
  expect(transport.trace.filter(entry => entry.event.type === 'audio.chunk')).toHaveLength(0);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toHaveCount(0);
  await expect(page.locator('.message-tutor')).toHaveCount(1);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  expect(transport.errors).toEqual([]);
});
