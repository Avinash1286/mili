import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { StudyPackSchema, type StudyPack, type Artifact } from '@tokai/contracts';
import { StoreError } from '@tokai/db';
import { exportCardsCsv, exportCardsJson, exportStudyPackJson, exportStudyPackMarkdown } from '@tokai/learning';

export type ArtifactBytes = { body: Buffer; contentType: string; extension: string };
const FONT_FILES = [['NotoSans-Regular.ttf', 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5'], ['NotoSansMath-Regular.ttf', '80b61fd613d3519197e64fff6f7e71fdc7f3e6526440ea4115b554ef7fd59af7']] as const;
let fontBytes: Promise<Uint8Array[]> | undefined;
function loadFonts(): Promise<Uint8Array[]> {
  fontBytes ??= Promise.all(FONT_FILES.map(([file, hash]) => readFile(new URL(`../../../content/fonts/${file}`, import.meta.url)).then(bytes => { if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new StoreError(503, 'PDF_FONT_CHANGED', 'The bundled PDF font could not be verified.'); return bytes; })));
  return fontBytes;
}
function wrap(text: string, measure: (text: string) => number, width: number): string[] {
  const result: string[] = []; let line = '';
  for (const word of text.replace(/\t/g, '    ').split(/\s+/)) {
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width) { line = next; continue; }
    if (line) { result.push(line); line = ''; }
    for (const character of word) {
      if (line && measure(line + character) > width) { result.push(line); line = ''; }
      line += character;
    }
  }
  if (line) result.push(line); return result.length ? result : [''];
}
export async function renderStudyPackPdf(raw: StudyPack): Promise<Buffer> {
  const pack = StudyPackSchema.parse(raw), document = await PDFDocument.create();
  document.registerFontkit(fontkit); document.setTitle(pack.title); document.setAuthor('Tokai'); document.setSubject('Study pack: completed narration, reference material and assessment evidence');
  const fonts = await Promise.all((await loadFonts()).map(bytes => document.embedFont(bytes, { subset: true }))), glyphSets = fonts.map(font => new Set(font.getCharacterSet())), font = fonts[0];
  const runs = (text: string): { text: string; font: PDFFont }[] => {
    const result: { text: string; font: PDFFont }[] = [];
    for (const character of text) {
      const selected = fonts[glyphSets.findIndex(set => set.has(character.codePointAt(0)!))] ?? font;
      const last = result.at(-1); if (last?.font === selected) last.text += character; else result.push({ text: character, font: selected });
    }
    return result;
  };
  const measure = (text: string, size: number) => runs(text).reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
  const paragraphs: { text: string; heading?: boolean }[] = [
    { text: pack.title, heading: true }, { text: `Version ${pack.version} • ${pack.generatedAt}` }, { text: 'Objectives', heading: true }, ...pack.objectives.map(item => ({ text: `• ${item.text}` })),
    { text: 'Completed spoken explanations', heading: true }, ...pack.completedNarration.map(item => ({ text: item.text })),
    ...(!pack.completedNarration.length ? [{ text: 'No complete narration was recorded as played.' }] : []),
    ...(pack.partialNarration.length ? [{ text: 'Interrupted narration', heading: true }, ...pack.partialNarration.map(item => ({ text: `${item.beatId}: ${Math.round(item.playedMs)} ms played. Its full text is excluded because it was not completed.` }))] : []),
    { text: 'Reference material', heading: true }, { text: 'These explanations are reference material, not a claim that every item was taught or heard.' },
    ...pack.referenceConcepts.flatMap(item => [{ text: item.label, heading: true }, { text: item.explanation }]),
    { text: 'Practice record', heading: true }, ...pack.attempts.flatMap(({ attempt, evaluation }) => [{ text: `${attempt.assessmentId}: ${evaluation.correctness} (${attempt.assisted ? 'assisted' : 'independent'}); reasoning ${evaluation.reasoning}; confidence ${evaluation.confidence}.` }, { text: evaluation.feedback }, { text: evaluation.explanation }]),
    { text: 'Understanding evidence', heading: true }, ...pack.mastery.map(item => ({ text: `${item.conceptId}: ${item.state} (${item.confidence}). ${item.explanation}` })),
    { text: 'Questions to revisit', heading: true }, ...pack.unresolvedQuestions.map(text => ({ text })), { text: 'Your notes', heading: true }, { text: pack.notes || 'No notes.' },
    { text: 'Cards', heading: true }, ...pack.cards.filter(card => card.status === 'active').flatMap(card => [{ text: card.front, heading: true }, { text: card.back }, { text: `Origin: ${card.originKind}. Next review: ${card.schedule.dueAt}` }]),
    { text: 'Next steps', heading: true }, ...pack.recommendations.map(text => ({ text })), { text: pack.nextLessonSuggestion },
    { text: 'Sources', heading: true }, ...pack.sourceRefs.map(source => ({ text: `${source.title}${source.page ? `, page ${source.page}` : ''}${source.section ? `, ${source.section}` : ''} (${source.sourceId}, version ${source.sourceVersion})${source.url ? ` ${source.url}` : ''}` })),
    ...(!pack.sourceRefs.length ? [{ text: 'No citations were supplied. Generated references are not presented as source-verified.' }] : []),
    { text: `Board snapshot, revision ${pack.boardRevision}`, heading: true },
    ...pack.board.nodes.map(node => ({ text: `${node.label}: ${node.detail}${node.shape === 'fraction' && node.fraction ? ` (${node.fraction.numerator}/${node.fraction.denominator})` : ''}` })),
    ...pack.board.edges.map(edge => ({ text: `${pack.board.nodes.find(node => node.id === edge.from)?.label ?? edge.from} → ${pack.board.nodes.find(node => node.id === edge.to)?.label ?? edge.to}${edge.label ? `: ${edge.label}` : ''}` })),
    { text: 'The board objects and connections are listed above. Export SVG or PNG from the workspace for its visual layout.' },
  ];
  for (const paragraph of paragraphs) for (const character of paragraph.text) if (!/\s/.test(character) && !glyphSets.some(set => set.has(character.codePointAt(0)!))) throw new StoreError(422, 'PDF_UNSUPPORTED_GLYPH', `This PDF font does not cover character U+${character.codePointAt(0)!.toString(16).toUpperCase()}. Download Markdown or JSON to preserve the full text.`);
  let page = document.addPage([595.28, 841.89]), y = 783;
  const nextPage = () => { if (document.getPageCount() >= 200) throw new StoreError(413, 'EXPORT_TOO_LARGE', 'The PDF exceeds 200 pages. Export JSON or a shorter lesson.'); page = document.addPage([595.28, 841.89]); y = 783; };
  for (const paragraph of paragraphs) {
    const size = paragraph.heading ? 14 : 10, lineHeight = paragraph.heading ? 20 : 15;
    for (const input of paragraph.text.split(/\r?\n/)) for (const line of wrap(input, text => measure(text, size), 499)) {
      if (y - lineHeight < 48) nextPage();
      let x = 48;
      for (const run of runs(line)) { page.drawText(run.text, { x, y, font: run.font, size, color: paragraph.heading ? rgb(.12, .26, .19) : rgb(.16, .18, .16) }); x += run.font.widthOfTextAtSize(run.text, size); }
      y -= lineHeight;
    }
    y -= paragraph.heading ? 7 : 9;
  }
  document.getPages().forEach((item, index) => item.drawText(`Tokai • ${index + 1} / ${document.getPageCount()}`, { x: 48, y: 25, font, size: 8, color: rgb(.4, .43, .4) }));
  return Buffer.from(await document.save());
}
export async function renderArtifactExport(pack: StudyPack, format: Artifact['format']): Promise<ArtifactBytes> {
  if (format === 'pdf') return { body: await renderStudyPackPdf(pack), contentType: 'application/pdf', extension: 'pdf' };
  if (format === 'csv') return { body: Buffer.from(exportCardsCsv(pack.cards)), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
  if (format === 'json') return { body: Buffer.from(exportStudyPackJson(pack)), contentType: 'application/json; charset=utf-8', extension: 'json' };
  if (format === 'markdown' || !format) return { body: Buffer.from(exportStudyPackMarkdown(pack)), contentType: 'text/markdown; charset=utf-8', extension: 'md' };
  throw new StoreError(400, 'INVALID_EXPORT_FORMAT', 'Choose Markdown, PDF, CSV or JSON.');
}
export const renderCardsJson = (pack: StudyPack): ArtifactBytes => ({ body: Buffer.from(exportCardsJson(pack.cards)), contentType: 'application/json; charset=utf-8', extension: 'json' });
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Buffer {
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 120 * sampleRate * 2 || sampleRate !== 24000) throw new StoreError(502, 'INVALID_RECAP_AUDIO', 'The recap audio was not valid bounded 24 kHz PCM.');
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}
