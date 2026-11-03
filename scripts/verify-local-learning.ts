import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCanvas } from '../packages/grounding/node_modules/@napi-rs/canvas';
import { PDFDocument, StandardFonts } from '../apps/api/node_modules/pdf-lib';
import { ConvexStore } from '../packages/db/src/index';
import { embedQuery } from '../packages/grounding/src/index';

/** Actual local Convex scheduled action + native PDF/OCR/indexing; no LLM or speech calls. */
async function main() {
  loadEnvFile('.env.local');
  const api = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
  const ready = await fetch(`${api}/health/ready`); if (!ready.ok || (await ready.json() as { database: string }).database !== 'convex') throw new Error('Start the API with the local Convex configuration first.');
  const store = ConvexStore.fromEnv(process.env); await store.initialize();
  const { token } = await (await fetch(`${api}/v1/guest-sessions`, { method: 'POST' })).json() as { token: string };
  const p = await store.authenticate(token), authorization = `Bearer ${token}`;
  async function call(path: string, init: RequestInit = {}) { const result = await fetch(api + path, { ...init, headers: { Authorization: authorization, 'Content-Type': 'application/json', ...init.headers } }); if (!result.ok) throw new Error(`Local learning probe failed at ${path}: HTTP ${result.status}`); return result; }
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([700, 300]).drawText('Fractions describe equal parts of the same whole. One half equals two quarters.', { x: 30, y: 200, size: 18, font });
    pdf.addPage([700, 300]).drawText('Electric current travels around a closed circuit when a potential difference drives it.', { x: 30, y: 200, size: 15, font });
    const canvas = createCanvas(1400, 400), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1400, 400); ctx.fillStyle = 'black'; ctx.font = '42px Arial';
    ctx.fillText('Mitochondria release usable energy from food.', 35, 100); ctx.fillText('Cellular respiration produces ATP for cell activities.', 35, 190);
    const image = await pdf.embedPng(canvas.toBuffer('image/png')); pdf.addPage([700, 200]).drawImage(image, { x: 0, y: 0, width: 700, height: 200 });
    const bytes = Buffer.from(await pdf.save()), checksum = createHash('sha256').update(bytes).digest('hex');
    const intent = await (await call('/v1/sources/uploads', { method: 'POST', body: JSON.stringify({ title: 'Isolated mixed PDF verification', filename: 'mixed.pdf', mimeType: 'application/pdf', bytes: bytes.length, checksum }) })).json() as { source: { id: string } };
    const id = intent.source.id;
    await call(`/v1/sources/${id}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
    await call(`/v1/sources/${id}/complete`, { method: 'POST', body: '{}' });
    let source: { id: string; status: string; pages: number; chunks: number } | undefined;
    for (let attempt = 0; attempt < 90; attempt++) {
      const data = await (await call('/v1/sources')).json() as { sources: NonNullable<typeof source>[] }; source = data.sources.find(item => item.id === id);
      if (source?.status === 'ready') break; if (source?.status === 'failed') throw new Error('Actual Convex source job failed.');
      if (attempt % 10 === 0) console.info(JSON.stringify({ waitingForScheduledSource: true, status: source?.status }));
      await delay(2000);
    }
    if (source?.status !== 'ready' || source.pages !== 3) throw new Error('Mixed PDF did not finish with three anchored pages.');
    const vector = await embedQuery('How do mitochondria make usable energy for cells?');
    const hits = await store.chunks.search(p, { sourceIds: [id], text: 'mitochondria', embedding: vector, limit: 3 });
    if (!hits.some(hit => hit.page === 3 && /mitochondria/i.test(hit.text))) throw new Error('Scanned-page OCR evidence was missing from actual retrieval.');
    const stranger = await store.authenticate((await store.createGuest()).token);
    try { await store.chunks.search(stranger, { sourceIds: [id], embedding: vector, limit: 3 }); throw new Error('Owner filter did not reject access.'); } catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; } finally { await store.deleteOwner(stranger); }
    console.info(JSON.stringify({ actualConvexScheduledAction: true, actualTextAndScannedPdf: true, pages: source.pages, chunks: source.chunks, citedScanPage: 3, embeddingDimensions: vector.length, crossOwnerDenied: true }));
  } finally { await call('/v1/me', { method: 'DELETE', body: '{}' }); await store.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Local learning check failed.'); process.exitCode = 1; });
