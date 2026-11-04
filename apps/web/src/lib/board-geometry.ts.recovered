import type { Board, BoardNode } from '@milli/contracts';

export type Viewport = { x: number; y: number; zoom: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export type BoardFocusRequest = { key: string; revision: number; ids: string[] };
export const clamp = (value: number, min = -4900, max = 4900) => Math.max(min, Math.min(max, value));
export function nodeBounds(node: BoardNode): Bounds { return { x: node.x, y: node.y, width: node.width ?? 190, height: node.height ?? 130 }; }
/** Clip a relationship to the rectangular silhouettes, leaving its arrowhead visible. */
export function connectorAnchors(a: Bounds, b: Bounds) {
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2, dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
  if (length < .001) return { x1: a.x + a.width + 4, y1: ay, x2: b.x + b.width + 4, y2: b.y - 5 };
  const boundary = (box: Bounds) => Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity);
  const start = boundary(a), end = boundary(b);
  return { x1: ax + dx * start + dx / length * 2, y1: ay + dy * start + dy / length * 2, x2: bx - dx * end - dx / length * 5, y2: by - dy * end - dy / length * 5 };
}
export function boardBounds(board: Board, ids?: string[], frameId?: string): Bounds {
  const frame = board.frames?.find(item => item.id === frameId);
  if (frame && !ids?.length) return frame;
  const nodes = board.nodes.filter(node => ids?.length ? ids.includes(node.id) : !frameId || node.frameId === frameId);
  if (!nodes.length) return { x: 0, y: 0, width: 800, height: 450 };
  const boxes = nodes.map(nodeBounds), x = Math.min(...boxes.map(b => b.x)) - 35, y = Math.min(...boxes.map(b => b.y)) - 35;
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x + 35, height: Math.max(...boxes.map(b => b.y + b.height)) - y + 35 };
}
/** Focus a shared frame, or all targeted objects when the beat crosses frames. */
export function boardFocusTarget(board: Board, ids: string[]): { frameId: string; bounds: Bounds } | undefined {
  const nodes = board.nodes.filter(node => ids.includes(node.id));
  if (!nodes.length) return undefined;
  const frameId = nodes[0]!.frameId;
  const frame = frameId && nodes.every(node => node.frameId === frameId) ? board.frames?.find(item => item.id === frameId) : undefined;
  return frame ? { frameId: frame.id, bounds: frame } : { frameId: '', bounds: boardBounds(board, nodes.map(node => node.id)) };
}
export function fitViewport(bounds: Bounds, width: number, height: number): Viewport {
  const zoom = clamp(Math.min(width / bounds.width, height / bounds.height), .25, 1.2);
  return { x: clamp(bounds.x - (width / zoom - bounds.width) / 2), y: clamp(bounds.y - (height / zoom - bounds.height) / 2), zoom };
}
export function zoomViewport(view: Viewport, factor: number, width: number, height: number): Viewport {
  const zoom = clamp(view.zoom * factor, .1, 8);
  return { x: clamp(view.x + width / view.zoom / 2 - width / zoom / 2), y: clamp(view.y + height / view.zoom / 2 - height / zoom / 2), zoom };
}
export function wrapText(text: string, columns: number, lines = 10): string[] {
  const result: string[] = []; let line = '';
  for (const raw of text.split(/\s+/)) {
    const pieces = raw.match(new RegExp(`.{1,${Math.max(3, columns)}}`, 'g')) ?? [''];
    for (const word of pieces) { if (line && line.length + word.length + 1 > columns) { result.push(line); line = ''; } line += `${line ? ' ' : ''}${word}`; }
  }
  if (line) result.push(line);
  if (result.length > lines) return [...result.slice(0, lines - 1), `${result[lines - 1]?.slice(0, Math.max(1, columns - 1))}…`];
  return result;
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
function textMarkup(text: string, x: number, y: number, columns: number, size: number, color: string, maxLines = 5) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Arial,sans-serif" font-size="${size}">${wrapText(text, columns, maxLines).map((line, i) => `<tspan x="${x}" dy="${i ? size * 1.45 : 0}">${escape(line)}</tspan>`).join('')}</text>`;
}
export function nodeMarkup(node: BoardNode): string {
  const { width: w, height: h } = nodeBounds(node), root = node.kind === 'root', fill = root ? '#31593f' : node.kind === 'question' ? '#f8edcb' : '#f4f3e7', ink = root ? '#faf8e9' : '#38513a';
  let body = '';
  if (node.shape === 'annotation') body = `<polyline points="${node.points?.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#846b38" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  else {
    if (node.shape === 'ellipse') body += `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="#a5b599"/>`;
    else if (node.shape !== 'text') body += `<rect width="${w}" height="${h}" rx="${node.shape === 'rectangle' ? 2 : 9}" fill="${fill}" stroke="#b3c2a3"/>`;
    body += textMarkup(node.label, 14, 28, Math.max(8, Math.floor((w - 28) / 10)), node.shape === 'equation' ? 23 : 19, ink, 2);
    if (node.shape === 'fraction' && node.fraction) {
      const { numerator, denominator } = node.fraction, piece = (w - 28) / denominator;
      for (let i = 0; i < denominator; i++) body += `<rect x="${14 + i * piece}" y="${h - 63}" width="${Math.max(1, piece - 2)}" height="35" fill="${i < numerator ? '#bbac5a' : '#e1e7d5'}" stroke="#889b75"/>`;
      body += textMarkup(`${numerator} / ${denominator}`, 14, h - 10, 30, 13, ink, 1);
    } else if (node.shape === 'number-line' && node.range) {
      body += `<path d="M 18 ${h - 38} H ${w - 18}" stroke="${ink}" stroke-width="2"/>`;
      for (let i = 0; i <= 5; i++) { const x = 18 + i * (w - 36) / 5; body += `<path d="M ${x} ${h - 44} V ${h - 32}" stroke="${ink}"/>` + textMarkup(String(Math.round((node.range.min + i * (node.range.max - node.range.min) / 5) * 100) / 100), x - 6, h - 15, 9, 11, ink, 1); }
      if (node.range.value !== undefined) body += `<circle cx="${18 + (node.range.value - node.range.min) / (node.range.max - node.range.min) * (w - 36)}" cy="${h - 38}" r="6" fill="#bb9a49"/>`;
    } else if (node.shape === 'graph' && node.plot) {
      const points = node.plot.points, minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
      const x = (v: number) => 35 + (v - minX) / (maxX - minX || 1) * (w - 60), y = (v: number) => h - 35 - (v - minY) / (maxY - minY || 1) * Math.max(20, h - 105);
      body += `<path d="M35 65 V${h - 35} H${w - 20}" stroke="${ink}" fill="none"/><polyline points="${points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')}" stroke="#bda050" stroke-width="3" fill="none"/><desc>${escape(points.map(p => `(${p.x}, ${p.y})`).join(', '))}</desc>`;
      body += textMarkup(node.plot.xLabel, w / 2, h - 10, 30, 11, ink, 1) + textMarkup(node.plot.yLabel, 40, 60, 30, 11, ink, 1);
    } else body += textMarkup(node.detail, 14, 66, Math.max(8, Math.floor((w - 28) / 7)), 12, root ? '#c9d5bc' : '#708061', Math.max(1, Math.floor((h - 75) / 17)));
  }
  return `<g transform="translate(${node.x} ${node.y})"><title>${escape(`${node.label}. ${node.detail}`)}</title>${body}</g>`;
}
/** Only application-authored SVG elements and escaped text; no foreignObject, URLs or model markup. */
export function exportBoardSvg(board: Board, ids?: string[], frameId?: string): string {
  const bounds = boardBounds(board, ids, frameId), nodes = board.nodes.filter(n => ids?.length ? ids.includes(n.id) : !frameId || n.frameId === frameId), included = new Set(nodes.map(n => n.id));
  const edges = board.edges.filter(edge => included.has(edge.from) && included.has(edge.to)).map(edge => {
    const a = nodeBounds(nodes.find(n => n.id === edge.from)!), b = nodeBounds(nodes.find(n => n.id === edge.to)!);
    const { x1, y1, x2, y2 } = connectorAnchors(a, b);
    return `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#9eaf91" stroke-width="2" marker-end="url(#arrow)"/>${textMarkup(edge.label ?? '', (x1 + x2) / 2, (y1 + y2) / 2 - 8, 25, 12, '#657a55', 1)}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" role="img"><title>milli lesson board</title><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 1 7 4 0 7" fill="none" stroke="#9eaf91"/></marker></defs><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="#fffef9"/>${edges}${nodes.map(nodeMarkup).join('')}</svg>`;
}
export async function boardPng(board: Board, ids?: string[], frameId?: string): Promise<{ data: string; url: string }> {
  const svg = exportBoardSvg(board, ids, frameId), bounds = boardBounds(board, ids, frameId), scale = Math.min(1, 1024 / Math.max(bounds.width, bounds.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bounds.width * scale)); canvas.height = Math.max(1, Math.round(bounds.height * scale));
  const boundedSvg = svg.replace(/width="[^"]+" height="[^"]+"/, `width="${canvas.width}" height="${canvas.height}"`);
  const url = URL.createObjectURL(new Blob([boundedSvg], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser cannot export the board. Try SVG instead.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png'), data = png.split(',')[1]!;
    if (data.length * .75 > 1024 * 1024) throw new Error('This drawing is too large to share. Select a smaller area.');
    return { data, url: png };
  } finally { URL.revokeObjectURL(url); }
}
export function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
