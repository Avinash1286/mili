'use client';

import { useId, useState } from 'react';
import { compileMathExpr, type CoursePalette, type CourseVisual, type PlotVisual } from '@milli/contracts';

const PALETTE: Record<CoursePalette, { stroke: string; fill: string; text: string }> = {
  green: { stroke: '#13a14b', fill: '#e8f9ee', text: '#0d6b31' },
  teal: { stroke: '#0e8f88', fill: '#e5f7f6', text: '#0a5e59' },
  blue: { stroke: '#2563eb', fill: '#e8f0fe', text: '#1d4ed8' },
  orange: { stroke: '#ea580c', fill: '#fff1e6', text: '#c2410c' },
  purple: { stroke: '#7c3aed', fill: '#f3e8ff', text: '#6d28d9' },
  red: { stroke: '#dc2626', fill: '#fee2e2', text: '#b91c1c' },
  yellow: { stroke: '#d97706', fill: '#fef7d6', text: '#92400e' },
  gray: { stroke: '#64748b', fill: '#f1f5f9', text: '#334155' },
};
const pick = (c?: CoursePalette) => PALETTE[c ?? 'teal'];

function ticksBetween(min: number, max: number, step: number): number[] {
  const intervals = (max - min) / step;
  if (!(intervals > 0)) return [];
  const spacing = intervals > 60 ? (max - min) / 60 : step;
  return [...new Set(Array.from({ length: Math.min(61, Math.floor(intervals + 1e-9) + 1) },
    (_, index) => Number((min + index * spacing).toPrecision(10))))];
}

export function CourseVisualRenderer({
  visual, highlight = [], markedPoints = [], onTogglePoint, interactivePoints = false, paramOverrides = {}, onParamChange,
}: {
  visual: CourseVisual;
  highlight?: string[];
  markedPoints?: { x: number; y: number }[];
  onTogglePoint?: (point: { x: number; y: number }) => void;
  interactivePoints?: boolean;
  paramOverrides?: Record<string, number>;
  onParamChange?: (name: string, value: number) => void;
}) {
  const hi = new Set(highlight);
  return (
    <figure className="milli-course-visual" aria-label={visual.alt}>
      {visual.kind === 'plot' && (
        <PlotSvg
          visual={visual}
          highlight={hi}
          markedPoints={markedPoints}
          onTogglePoint={onTogglePoint}
          interactive={interactivePoints}
          paramOverrides={paramOverrides}
          onParamChange={onParamChange}
        />
      )}
      {visual.kind === 'number-line' && <NumberLineSvg visual={visual} highlight={hi} />}
      {visual.kind === 'fraction-bars' && <FractionBarsSvg visual={visual} highlight={hi} paramOverrides={paramOverrides} />}
      {visual.kind === 'flow' && <FlowDiagram visual={visual} highlight={hi} />}
      {visual.kind === 'bars' && <BarsSvg visual={visual} highlight={hi} />}
      {visual.kind === 'shapes' && <ShapesSvg visual={visual} highlight={hi} />}
      {visual.kind === 'table' && (
        <div className="milli-course-table-wrap">
          <table className="milli-course-table">
            <thead><tr>{visual.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>{visual.rows.map((r, ri) => <tr key={ri}>{r.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {visual.kind === 'callout' && (
        <div className="milli-course-callout">
          <span className="milli-course-callout-emoji" aria-hidden="true">{visual.emoji}</span>
          {visual.caption && <p>{visual.caption}</p>}
        </div>
      )}
      <figcaption className="sr-only">{visual.alt}</figcaption>
    </figure>
  );
}

function PlotSvg({
  visual, highlight, markedPoints, onTogglePoint, interactive, paramOverrides, onParamChange,
}: {
  visual: PlotVisual;
  highlight: Set<string>;
  markedPoints: { x: number; y: number }[];
  onTogglePoint?: (point: { x: number; y: number }) => void;
  interactive: boolean;
  paramOverrides: Record<string, number>;
  onParamChange?: (name: string, value: number) => void;
}) {
  const arrowId = useId();
  const [pointX, setPointX] = useState('');
  const [pointY, setPointY] = useState('');
  const W = 380, H = 260, padL = 44, padR = 22, padT = 28, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const toX = (x: number) => padL + ((x - visual.x.min) / (visual.x.max - visual.x.min)) * plotW;
  const toY = (y: number) => padT + plotH - ((y - visual.y.min) / (visual.y.max - visual.y.min)) * plotH;
  const vars: Record<string, number> = {};
  for (const p of visual.params) vars[p.name] = paramOverrides[p.name] ?? p.value;

  const xTicks = ticksBetween(visual.x.min, visual.x.max, visual.x.step);
  const yTicks = ticksBetween(visual.y.min, visual.y.max, visual.y.step);

  function handleSvgClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!interactive || !onTogglePoint) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    const rawX = visual.x.min + ((sx - padL) / plotW) * (visual.x.max - visual.x.min);
    const rawY = visual.y.min + ((padT + plotH - sy) / plotH) * (visual.y.max - visual.y.min);
    const snap = (val: number, step: number, min: number, max: number) => {
      const snapped = Math.round((val - min) / step) * step + min;
      return Number(Math.max(min, Math.min(max, snapped)).toFixed(2));
    };
    onTogglePoint({ x: snap(rawX, visual.x.step, visual.x.min, visual.x.max), y: snap(rawY, visual.y.step, visual.y.min, visual.y.max) });
  }

  return (
    <div className="milli-course-plot-block">
      {visual.title && <div className="milli-course-plot-title">{visual.title}</div>}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={`milli-course-svg ${interactive ? 'milli-course-svg-clickable' : ''}`}
        onClick={handleSvgClick}
        role="img"
        aria-label={visual.alt}
      >
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="#18181b" />
          </marker>
        </defs>
        {xTicks.map(t => (
          <g key={`gx-${t}`}>
            <line x1={toX(t)} y1={padT} x2={toX(t)} y2={padT + plotH} stroke="#eceef2" strokeWidth="1" />
            {t !== visual.x.min && (
              <>
                <line x1={toX(t)} y1={padT + plotH - 3} x2={toX(t)} y2={padT + plotH + 3} stroke="#18181b" strokeWidth="1.2" />
                <text x={toX(t)} y={padT + plotH + 15} textAnchor="middle" className="milli-course-axis-num">{t}</text>
              </>
            )}
          </g>
        ))}
        {yTicks.map(t => (
          <g key={`gy-${t}`}>
            <line x1={padL} y1={toY(t)} x2={padL + plotW} y2={toY(t)} stroke="#eceef2" strokeWidth="1" />
            {t !== visual.y.min && (
              <>
                <line x1={padL - 3} y1={toY(t)} x2={padL + 3} y2={toY(t)} stroke="#18181b" strokeWidth="1.2" />
                <text x={padL - 8} y={toY(t) + 4} textAnchor="end" className="milli-course-axis-num">{t}</text>
              </>
            )}
          </g>
        ))}
        <line x1={padL} y1={padT + plotH} x2={padL + plotW + 8} y2={padT + plotH} stroke="#18181b" strokeWidth="1.6" markerEnd={`url(#${arrowId})`} />
        <line x1={padL} y1={padT + plotH} x2={padL} y2={padT - 8} stroke="#18181b" strokeWidth="1.6" markerEnd={`url(#${arrowId})`} />
        {visual.xLabel && <text x={padL + plotW} y={H - 6} textAnchor="end" className="milli-course-axis-label">{visual.xLabel}</text>}
        {visual.yLabel && <text x={padL + 6} y={padT - 10} textAnchor="start" className="milli-course-axis-label">{visual.yLabel}</text>}

        {visual.functions.map(fn => {
          const domMin = Math.max(fn.domain?.[0] ?? visual.x.min, visual.x.min);
          const domMax = Math.min(fn.domain?.[1] ?? visual.x.max, visual.x.max);
          if (domMax <= domMin) return null;
          let evaluate: ReturnType<typeof compileMathExpr>;
          try { evaluate = compileMathExpr(fn.expr); } catch { return null; }
          const samples = 240;
          const segs: string[] = [];
          let penDown = false;
          for (let i = 0; i <= samples; i++) {
            const xv = domMin + ((domMax - domMin) * i) / samples;
            const yv = evaluate({ ...vars, x: xv });
            if (!Number.isFinite(yv) || yv < visual.y.min - (visual.y.max - visual.y.min) * 0.25 || yv > visual.y.max + (visual.y.max - visual.y.min) * 0.25) {
              penDown = false;
              continue;
            }
            const px = toX(xv).toFixed(1), py = toY(yv).toFixed(1);
            segs.push(`${penDown ? 'L' : 'M'}${px},${py}`);
            penDown = true;
          }
          const pal = pick(fn.color);
          return (
            <path
              key={fn.id}
              d={segs.join(' ')}
              fill="none"
              stroke={pal.stroke}
              strokeWidth={highlight.has(fn.id) ? 3.4 : 2.4}
              strokeDasharray={fn.dashed ? '5 4' : undefined}
              className="milli-course-curve"
            />
          );
        })}

        {visual.points.map(pt => {
          const pal = pick(pt.color ?? 'orange');
          const active = highlight.has(pt.id);
          return (
            <g key={pt.id}>
              {active && (
                <circle
                  cx={toX(pt.x)}
                  cy={toY(pt.y)}
                  r={11}
                  fill={pal.fill}
                  stroke={pal.stroke}
                  strokeWidth="1.6"
                  pointerEvents="none"
                  className="milli-course-pulse-ring"
                />
              )}
              <g
                className={interactive ? 'milli-course-point-target' : undefined}
                onClick={e => {
                  if (!interactive || !onTogglePoint) return;
                  e.stopPropagation();
                  onTogglePoint({ x: pt.x, y: pt.y });
                }}
              >
                <circle cx={toX(pt.x)} cy={toY(pt.y)} r={interactive ? 9 : 5} fill="transparent" />
                <circle cx={toX(pt.x)} cy={toY(pt.y)} r={interactive ? 6 : 5} fill={pal.stroke} stroke="#ffffff" strokeWidth="1.8" />
                {pt.label && <text x={toX(pt.x)} y={toY(pt.y) - 10} textAnchor="middle" className="milli-course-point-label">{pt.label}</text>}
              </g>
            </g>
          );
        })}

        {markedPoints.map((pt, i) => (
          <g key={`mk-${i}-${pt.x}-${pt.y}`}>
            <circle cx={toX(pt.x)} cy={toY(pt.y)} r={9} fill="rgba(234,88,12,0.18)" stroke="#ea580c" strokeWidth="2" />
            <circle cx={toX(pt.x)} cy={toY(pt.y)} r={4.5} fill="#ea580c" />
          </g>
        ))}
      </svg>
      {interactive && onTogglePoint && (
        <details className="milli-course-plot-coordinates">
          <summary>Enter a point by coordinates</summary>
          <form className="milli-course-answer-form" onSubmit={event => {
            event.preventDefault();
            if (!pointX || !pointY) return;
            onTogglePoint({ x: Number(pointX), y: Number(pointY) });
            setPointX('');
            setPointY('');
          }}>
            <input aria-label="X coordinate" placeholder="X" type="number" min={visual.x.min} max={visual.x.max} step="any" required value={pointX} onChange={event => setPointX(event.target.value)} />
            <input aria-label="Y coordinate" placeholder="Y" type="number" min={visual.y.min} max={visual.y.max} step="any" required value={pointY} onChange={event => setPointY(event.target.value)} />
            <button type="submit" className="milli-course-why-btn">Mark point</button>
          </form>
        </details>
      )}

      {visual.params.length > 0 && onParamChange && (
        <div className="milli-course-sim-params">
          {visual.params.map(p => {
            const val = paramOverrides[p.name] ?? p.value;
            return (
              <label key={p.name} className="milli-course-param-slider">
                <span>{p.label}: <strong>{val}</strong></span>
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={val}
                  onChange={e => onParamChange(p.name, Number(e.target.value))}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NumberLineSvg({ visual, highlight }: { visual: Extract<CourseVisual, { kind: 'number-line' }>; highlight: Set<string> }) {
  const W = 380, H = 96, pad = 34;
  const span = visual.max - visual.min;
  const toX = (v: number) => span > 0 ? pad + ((v - visual.min) / span) * (W - pad * 2) : W / 2;
  const ticks = ticksBetween(visual.min, visual.max, visual.step);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="milli-course-svg" role="img" aria-label={visual.alt}>
      <line x1={pad} y1={48} x2={W - pad} y2={48} stroke="#18181b" strokeWidth="2" />
      {visual.range && (
        <line
          x1={toX(visual.range.from)}
          y1={48}
          x2={toX(visual.range.to)}
          y2={48}
          stroke={pick(visual.range.color ?? 'green').stroke}
          strokeWidth="6"
          strokeLinecap="round"
        />
      )}
      {ticks.map(t => (
        <g key={t}>
          <line x1={toX(t)} y1={40} x2={toX(t)} y2={56} stroke="#18181b" strokeWidth="1.5" />
          <text x={toX(t)} y={74} textAnchor="middle" className="milli-course-axis-num">{t}</text>
        </g>
      ))}
      {visual.marks.map(m => {
        const pal = pick(m.color ?? 'green');
        return (
          <g key={m.id}>
            <circle cx={toX(m.value)} cy={48} r={highlight.has(m.id) ? 8 : 6} fill={pal.stroke} stroke="#fff" strokeWidth="2" />
            {m.label && <text x={toX(m.value)} y={26} textAnchor="middle" className="milli-course-point-label">{m.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function FractionBarsSvg({
  visual, highlight, paramOverrides,
}: {
  visual: Extract<CourseVisual, { kind: 'fraction-bars' }>;
  highlight: Set<string>;
  paramOverrides: Record<string, number>;
}) {
  return (
    <div className="milli-course-fraction-list">
      {visual.bars.map((bar, idx) => {
        const pal = pick(bar.color ?? 'green');
        const shaded = idx === visual.bars.length - 1 && typeof paramOverrides.__slider === 'number'
          ? Math.max(0, Math.min(bar.parts, Math.round(paramOverrides.__slider)))
          : bar.shaded;
        return (
          <div key={bar.id} className={`milli-course-fraction-row ${highlight.has(bar.id) ? 'milli-course-hi' : ''}`}>
            {bar.label && <span className="milli-course-fraction-label">{bar.label}</span>}
            <div className="milli-course-fraction-bar" role="img" aria-label={`${shaded} of ${bar.parts} shaded`}>
              {Array.from({ length: bar.parts }).map((_, i) => (
                <span
                  key={i}
                  className="milli-course-fraction-cell"
                  style={{
                    background: i < shaded ? pal.stroke : pal.fill,
                    borderColor: pal.stroke,
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FlowDiagram({ visual, highlight }: { visual: Extract<CourseVisual, { kind: 'flow' }>; highlight: Set<string> }) {
  return (
    <div className={`milli-course-flow milli-course-flow-${visual.layout}`}>
      {visual.nodes.map((node, index) => {
        const pal = pick(node.color ?? 'green');
        const link = visual.links.find(l => l.from === node.id);
        return (
          <div key={node.id} className="milli-course-flow-step">
            <div
              className={`milli-course-flow-node ${highlight.has(node.id) ? 'milli-course-hi' : ''}`}
              style={{ borderColor: pal.stroke, background: pal.fill }}
            >
              {node.emoji && <span className="milli-course-flow-emoji" aria-hidden="true">{node.emoji}</span>}
              <strong>{node.label}</strong>
              {node.detail && <small>{node.detail}</small>}
            </div>
            {index < visual.nodes.length - 1 && (
              <span className="milli-course-flow-arrow" aria-hidden="true">
                {link?.label ? <small>{link.label}</small> : null} →
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BarsSvg({ visual, highlight }: { visual: Extract<CourseVisual, { kind: 'bars' }>; highlight: Set<string> }) {
  const max = Math.max(1, ...visual.bars.map(b => b.value));
  return (
    <div className="milli-course-bars">
      {visual.bars.map(b => {
        const pal = pick(b.color ?? 'green');
        const pct = Math.max(6, Math.round((b.value / max) * 100));
        return (
          <div key={b.id} className={`milli-course-bar-row ${highlight.has(b.id) ? 'milli-course-hi' : ''}`}>
            <span className="milli-course-bar-label">{b.label}</span>
            <div className="milli-course-bar-track">
              <div className="milli-course-bar-fill" style={{ width: `${pct}%`, background: pal.stroke }} />
            </div>
            <span className="milli-course-bar-val">{b.value}{visual.unit ?? ''}</span>
          </div>
        );
      })}
    </div>
  );
}

function ShapesSvg({ visual, highlight }: { visual: Extract<CourseVisual, { kind: 'shapes' }>; highlight: Set<string> }) {
  // Include the nominal canvas and any geometry beyond it in the SVG viewport.
  let left = 0, top = 0, right = 420, bottom = 140;
  function include(x: number, y: number, width = 0, height = 0) {
    const padding = 6;
    left = Math.min(left, x - padding);
    top = Math.min(top, y - padding);
    right = Math.max(right, x + width + padding);
    bottom = Math.max(bottom, y + height + padding);
  }
  function includeText(text: string, x: number, baseline: number, size: number, centered = false) {
    const width = [...text].length * size;
    include(centered ? x - width / 2 : x, baseline - size, width, size * 1.25);
  }
  for (const element of visual.elements) {
    switch (element.type) {
      case 'rect':
        include(element.x, element.y, element.w, element.h);
        if (element.label) includeText(element.label, element.x + element.w / 2, element.y + element.h / 2 + 5, 13, true);
        break;
      case 'circle':
        include(element.cx - element.r, element.cy - element.r, element.r * 2, element.r * 2);
        if (element.label) includeText(element.label, element.cx, element.cy + 4, 12, true);
        break;
      case 'line':
        include(element.x1, element.y1);
        include(element.x2, element.y2);
        break;
      case 'polygon':
        for (const [x, y] of element.points) include(x, y);
        break;
      case 'text':
        includeText(element.text, element.x, element.y, 13);
        break;
    }
  }
  return (
    <svg viewBox={`${left} ${top} ${right - left} ${bottom - top}`} className="milli-course-svg milli-course-shapes-svg" role="img" aria-label={visual.alt}>
      {visual.elements.map(el => {
        const pal = pick(el.fill ?? 'green');
        const strokeW = highlight.has(el.id) ? 3 : 2;
        if (el.type === 'rect') {
          return (
            <g key={el.id}>
              <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={el.rounded ? 12 : 2} fill={pal.fill} stroke={pal.stroke} strokeWidth={strokeW} />
              {el.label && <text x={el.x + el.w / 2} y={el.y + el.h / 2 + 5} textAnchor="middle" fill={pal.text} fontWeight="700" fontSize="13">{el.label}</text>}
            </g>
          );
        }
        if (el.type === 'circle') {
          return (
            <g key={el.id}>
              <circle cx={el.cx} cy={el.cy} r={el.r} fill={pal.fill} stroke={pal.stroke} strokeWidth={strokeW} />
              {el.label && <text x={el.cx} y={el.cy + 4} textAnchor="middle" fill={pal.text} fontWeight="700" fontSize="12">{el.label}</text>}
            </g>
          );
        }
        if (el.type === 'line') {
          return <line key={el.id} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke={pal.stroke} strokeWidth="2.5" strokeDasharray={el.dashed ? '4 4' : undefined} />;
        }
        if (el.type === 'polygon') {
          return <polygon key={el.id} points={el.points.map(p => p.join(',')).join(' ')} fill={pal.fill} stroke={pal.stroke} strokeWidth={strokeW} />;
        }
        return <text key={el.id} x={el.x} y={el.y} fill={pal.text} fontWeight="600" fontSize="13">{el.text}</text>;
      })}
    </svg>
  );
}
