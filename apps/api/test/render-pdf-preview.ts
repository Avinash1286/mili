// Manual local verification artifact; never used by the API or a provider job.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildStudyPack, getLessonPack } from '@tokai/learning';
import { createLesson } from '@tokai/tutor-core';
import { renderStudyPackPdf } from '../src/artifact-export';
const requireGrounding = createRequire(new URL('../../../packages/grounding/package.json', import.meta.url));
const { createCanvas, DOMMatrix, ImageData, Path2D } = requireGrounding('@napi-rs/canvas');
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { getDocument } = await import(pathToFileURL(requireGrounding.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const now = '2026-11-03T12:00:00.000Z', session = createLesson({ id: 'preview', topic: 'photosynthesis', mode: 'sample', now, messageId: 'intro' });
const pack = buildStudyPack({ session, pack: getLessonPack(session.topic), attempts: [], evidence: [], cards: [], notes: 'CO₂ + H₂O; Ω and α; energía; crème brûlée; √9 = 3 → correct.', now, id: 'preview' });
const bytes = await renderStudyPackPdf(pack), output = new URL('../../../var/probes/', import.meta.url);
await mkdir(output, { recursive: true }); await writeFile(new URL('tokai-study-pack.pdf', output), bytes);
const task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: false });
try { const document = await task.promise; for (const number of [1, 2]) { const page = await document.getPage(number), viewport = page.getViewport({ scale: 1.5 }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)); await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise; await writeFile(new URL(`tokai-study-pack-page-${number}.png`, output), canvas.toBuffer('image/png')); } }
finally { await task.destroy(); }
console.log('Rendered var/probes/tokai-study-pack.pdf and page previews.');
