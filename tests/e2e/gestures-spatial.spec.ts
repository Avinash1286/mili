import { expect, test, type Page, type Route } from '@playwright/test';
import { fixtureTransport, openLiveLesson } from '../fixtures/browser.js';
import { fixtureCamera } from '../fixtures/camera.js';
import { SPATIAL_REQUEST, SPATIAL_SEQUENCE_REQUEST } from '../fixtures/spatial.js';
import { VISUAL_REQUEST } from '../fixtures/teaching.js';

// Camera gestures are an opt-in experiment in Settings.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('milli.gestures', '1')); });

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: /question/i }).fill(text);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
}

async function openSpatial(page: Page) {
  const entry = page.getByRole('button', { name: '3D models', exact: true });
  const picker = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(entry.or(page.getByRole('button', { name: 'Close 3D model', exact: true }))).toBeVisible();
  if (await entry.isVisible()) await entry.click();
  await expect(picker).toBeVisible();
  return picker;
}

test('the real local MediaPipe worker initializes on a synthetic blank camera and stops cleanly', async ({ page }, testInfo) => {
  const transport = await fixtureTransport(page);
  const camera = await fixtureCamera(page);
  const assets: { path: string; status: number; contentType: string }[] = [];
  const failures: { path: string; error: string }[] = [];
  const network: { origin: string; path: string; method: string; resourceType: string }[] = [];
  const workers: string[] = [], errors: string[] = [];
  let captureNetwork = false;
  const tracked = (url: string) => { const path = new URL(url).pathname; return path === '/gesture-worker.js' || path.startsWith('/vendor/mediapipe/') ? path : undefined; };
  page.context().on('response', response => {
    const path = tracked(response.url());
    if (path && assets.length < 30) assets.push({ path, status: response.status(), contentType: response.headers()['content-type'] ?? '' });
  });
  page.context().on('requestfailed', request => {
    const path = tracked(request.url());
    if (path && failures.length < 20) failures.push({ path, error: (request.failure()?.errorText ?? 'unknown').slice(0, 180) });
  });
  page.context().on('request', request => {
    if (!captureNetwork || network.length >= 100) return;
    const url = new URL(request.url());
    network.push({ origin: url.origin, path: url.pathname, method: request.method(), resourceType: request.resourceType() });
  });
  page.on('worker', worker => { if (workers.length < 10) workers.push(new URL(worker.url()).pathname); });
  page.on('console', message => { if (message.type() === 'error' && errors.length < 15) errors.push(message.text().slice(0, 250)); });
  await openLiveLesson(page);
  const status = page.getByRole('region', { name: 'Camera gesture controls', exact: true }).getByRole('status');
  try {
    captureNetwork = true;
    await page.getByRole('button', { name: 'Enable camera gestures', exact: true }).click();
    // Match the application's 25-second model deadline; fail immediately on its error state.
    await expect.poll(async () => status.innerText(), { timeout: 30000 }).not.toMatch(/^Camera off$|Waiting for camera permission|loading local hand tracking/);
    expect(await status.innerText()).toBe('Camera on · tracking locally in a worker');
    expect(workers).toContain('/gesture-worker.js');
    expect(assets.some(asset => asset.path.endsWith('/vision_bundle.mjs') && asset.status === 200)).toBe(true);
    expect(assets.some(asset => asset.path.endsWith('.wasm') && asset.status === 200)).toBe(true);
    expect(assets.some(asset => asset.path.endsWith('/gesture_recognizer.task') && asset.status === 200)).toBe(true);
    expect(failures).toEqual([]);
    await expect.poll(async () => (await camera.state()).workerMessages.result ?? 0).toBeGreaterThanOrEqual(3);
    expect((await camera.state()).liveTracks).toBe(1);
    await page.getByRole('button', { name: 'Disable camera gestures', exact: true }).click();
    await expect(status).toHaveText('Camera off');
    await expect.poll(async () => (await camera.state()).liveTracks).toBe(0);
    expect((await camera.state()).stops).toBe(1);
    expect(network.filter(request => !['http://localhost:3000', 'http://localhost:4000', 'http://localhost:4100'].includes(request.origin))).toEqual([]);
    expect(transport.errors).toEqual([]);
  } finally {
    await testInfo.attach('mediapipe-initialization.json', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ assets, failures, network, workers, consoleErrors: errors, camera: await camera.state().catch(() => null), status: await status.innerText().catch(() => 'unavailable') }, null, 2)),
    });
  }
});

test('camera denial preserves the complete keyboard and text path', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const camera = await fixtureCamera(page, 'denied');
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Enable camera gestures', exact: true }).click();
  await expect.poll(async () => (await camera.state()).attempts).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Camera permission was denied' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable camera gestures', exact: true })).toBeEnabled();
  expect((await camera.state()).liveTracks).toBe(0);
  await ask(page, 'Explain this lesson without camera gestures.');
  await expect(page.locator('.message-tutor').last()).toContainText('Fixture tutor response:');
  await openSpatial(page);
  expect(transport.errors).toEqual([]);
});

test('disabling camera gestures during model initialization releases the acquired track', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const camera = await fixtureCamera(page);
  const held: Route[] = [];
  await page.context().route('**/vendor/mediapipe/**', route => { held.push(route); });
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Enable camera gestures', exact: true }).click();
  await expect.poll(async () => (await camera.state()).liveTracks).toBe(1);
  await page.getByRole('button', { name: 'Disable camera gestures', exact: true }).click();
  await expect.poll(async () => (await camera.state()).liveTracks).toBe(0);
  expect((await camera.state()).stops).toBe(1);
  for (const route of held.splice(0)) await route.abort().catch(() => undefined);
  await expect(page.getByRole('button', { name: 'Enable camera gestures', exact: true })).toBeEnabled();
  await ask(page, 'Continue after I disabled the camera.');
  await expect(page.locator('.message-tutor').last()).toContainText('Fixture tutor response:');
  expect(transport.errors).toEqual([]);
});

test('late camera permission cannot restart a disabled gesture session', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const camera = await fixtureCamera(page, 'deferred');
  await page.context().route('**/vendor/mediapipe/**', route => route.abort());
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Enable camera gestures', exact: true }).click();
  await expect.poll(async () => (await camera.state()).pending).toBe(1);
  await page.getByRole('button', { name: 'Disable camera gestures', exact: true }).click();
  await camera.release();
  await expect.poll(async () => (await camera.state()).stops).toBe(1);
  expect((await camera.state()).liveTracks).toBe(0);
  await expect(page.getByRole('button', { name: 'Enable camera gestures', exact: true })).toBeEnabled();
  expect(transport.errors).toEqual([]);
});

test('a local tracking asset failure stops the camera and leaves selection help usable', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const camera = await fixtureCamera(page);
  await page.context().route('**/vendor/mediapipe/**', route => route.abort());
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Enable camera gestures', exact: true }).click();
  await expect.poll(async () => (await camera.state()).stops).toBe(1);
  expect((await camera.state()).liveTracks).toBe(0);
  await expect(page.getByRole('status').filter({ hasText: /could not|failed|stopped/i })).toBeVisible();
  await page.locator('.board-node[data-node-id="chloroplast"]').click();
  await page.getByText('Gesture settings', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ask about selection', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Ask about selection', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /question/i })).not.toHaveValue('');
  expect(transport.errors).toEqual([]);
});

test('all four local spatial models load and expose keyboard controls and a diagram fallback', async ({ page }) => {
  const transport = await fixtureTransport(page);
  const assetRequests: string[] = [];
  page.on('response', response => { if (/\/models\/[^/]+\.glb$/.test(new URL(response.url()).pathname) && response.ok()) assetRequests.push(new URL(response.url()).pathname); });
  await openLiveLesson(page);
  const modelPicker = await openSpatial(page);
  for (const model of [
    { id: 'solar-system', part: 'Earth', partId: 'earth', title: 'Our solar system' },
    { id: 'dna', part: 'A base pair', partId: 'base-pair', title: 'Inside the DNA double helix' },
    { id: 'chloroplast', part: 'Thylakoid membrane', partId: 'thylakoid', title: 'A chloroplast, opened up' },
    { id: 'heart', part: 'Left ventricle', partId: 'left-ventricle', title: 'Follow blood through the heart' },
  ]) {
    await modelPicker.selectOption(model.id);
    await expect(page.getByText('3D model ready', { exact: true })).toBeVisible();
    const canvas = page.getByLabel(`${model.title} interactive 3D model`, { exact: true });
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-rendered', 'true');
    const part = page.getByRole('button', { name: `Select ${model.part}`, exact: true });
    await part.focus(); await page.keyboard.press('Enter');
    await expect(part).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas).toHaveAttribute('data-selected-parts', model.partId);
    await page.getByRole('button', { name: 'Reset view', exact: true }).click();
    const initialPose = await canvas.getAttribute('data-camera-pose');
    expect(initialPose).toBeTruthy();
    await page.getByRole('button', { name: 'Rotate right', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(canvas).not.toHaveAttribute('data-camera-pose', initialPose!);
    await page.getByRole('button', { name: 'Tilt up', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Reset view', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(canvas).toHaveAttribute('data-camera-pose', initialPose!);
    await page.getByRole('button', { name: 'Isolate selected part', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Isolate selected part', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: / on model$/ })).toHaveCount(1);
    await page.getByRole('button', { name: 'Isolate selected part', exact: true }).click();
    await page.getByRole('button', { name: 'Use 2D diagram', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Try 3D again', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Select ${model.part}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Try 3D again', exact: true }).click();
    await expect(page.getByText('3D model ready', { exact: true })).toBeVisible();
  }
  expect(new Set(assetRequests)).toEqual(new Set(['/models/solar-system.glb', '/models/dna.glb', '/models/chloroplast.glb', '/models/heart.glb']));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Whiteboard', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/tokai-phase-4-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close 3D model', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveCount(0);
  expect(transport.errors).toEqual([]);
});

test('an unavailable model asset leaves a labeled keyboard-accessible diagram and a visible reason', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await page.route('**/models/*.glb', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture model unavailable' }));
  await openLiveLesson(page);
  await openSpatial(page);
  await expect(page.getByText('2D diagram ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The model file could not be loaded.' })).toBeVisible();
  const part = page.getByRole('button', { name: 'Select Thylakoid membrane in diagram', exact: true });
  await part.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Select Thylakoid membrane', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Explain selected part', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Explain selected part', exact: true }).click();
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.message-tutor').last()).toContainText('Thylakoid membrane:');
  expect(transport.errors).toEqual([]);
});

test('tutor spatial selection is grounded in catalog parts and survives reload', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await ask(page, SPATIAL_REQUEST);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('dna');
  await expect(page.getByRole('button', { name: 'Select A base pair', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await openSpatial(page);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('dna');
  await expect(page.getByRole('button', { name: 'Select A base pair', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Select Adenine (A)', exact: true }).click();
  await ask(page, 'What does this selected part do?');
  await expect(page.locator('.message-tutor').last()).toContainText('Selected model: Inside the DNA double helix. Adenine (A):');
  await expect(page.locator('.message-tutor').last()).toContainText('pairs with thymine');
  await expect(page.getByRole('button', { name: 'Select Adenine (A)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('3D model ready', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.getByRole('combobox', { name: 'Model', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tokai-phase-4-spatial.png', fullPage: true });
  await ask(page, VISUAL_REQUEST);
  await expect(page.locator('.board-node[data-node-id="fixture-energy"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close 3D model', exact: true })).toHaveCount(0);
  const model = await openSpatial(page);
  await model.selectOption('heart');
  await page.getByRole('button', { name: 'Select Left ventricle', exact: true }).click();
  await ask(page, 'Explain this selected heart part.');
  await expect(page.locator('.message-tutor').last()).toContainText('Left ventricle:');
  await expect(model).toHaveValue('heart');
  await expect(page.getByRole('button', { name: 'Select Left ventricle', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(transport.errors).toEqual([]);
});

test('spatial readiness gates narration and stopping prevents the next model change', async ({ page }) => {
  const transport = await fixtureTransport(page);
  await openLiveLesson(page);
  await page.getByRole('button', { name: 'Start without microphone', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'session.ready')).toBe(true);
  transport.holdClientEvents(event => event.type === 'board.ready');
  await ask(page, SPATIAL_SEQUENCE_REQUEST);
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'board.ready' && event.ready === true)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('dna');
  await expect(page.getByRole('button', { name: 'Select A base pair', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(transport.trace.some(entry => entry.event.type === 'audio.chunk')).toBe(false);
  transport.releaseClientEvents();
  await expect.poll(() => transport.clientEvents.some(event => event.type === 'playback.ack' && event.status === 'started')).toBe(true);
  await page.getByRole('button', { name: 'Stop tutor', exact: true }).click();
  await expect.poll(() => transport.events.some(event => event.type === 'audio.cancel')).toBe(true);
  await page.getByRole('button', { name: 'Disconnect voice', exact: true }).click();
  await page.reload();
  await openSpatial(page);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('dna');
  expect(transport.events.filter(event => event.type === 'board.patch' && JSON.stringify(event).includes('left-ventricle'))).toHaveLength(0);
  expect(transport.errors).toEqual([]);
});
