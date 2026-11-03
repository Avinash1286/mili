'use client';
import { useId } from 'react';
import type { SpatialModel } from '@tokai/contracts';
import styles from './SpatialViewer.module.css';

export function SpatialDiagram({ model, selectedIds, onSelect }: { model: SpatialModel; selectedIds: string[]; onSelect: (id: string) => void }) {
  const arrow = useId().replace(/:/g, '');
  return <div className={styles.diagram}>
    <svg viewBox="0 0 730 420" role="img" aria-label={`${model.title} labeled 2D diagram`}>
      <title>{model.fallback.title}</title><desc>{model.accessibilityDescription}</desc>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="#8f9d78"/></marker></defs>
      {model.fallback.relations.map((relation, index) => {
        const a = model.parts.find(part => part.id === relation.from)!.diagram, b = model.parts.find(part => part.id === relation.to)!.diagram;
        const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2, dx = bx - ax, dy = by - ay;
        const edge = (box: typeof a) => Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity);
        return <path key={index} d={`M${ax + dx * edge(a)} ${ay + dy * edge(a)}L${bx - dx * edge(b) * 1.08} ${by - dy * edge(b) * 1.08}`} stroke="#8f9d78" strokeWidth="2" markerEnd={`url(#${arrow})`} fill="none"><title>{`${relation.from} ${relation.label} ${relation.to}`}</title></path>;
      })}
      {model.parts.map(part => <g key={part.id} role="button" tabIndex={0} aria-label={`Select ${part.label} in diagram`} aria-pressed={selectedIds.includes(part.id)} onClick={() => onSelect(part.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(part.id); } }} className={styles.diagramPart}>
        {part.diagram.shape === 'ellipse' ? <ellipse cx={part.diagram.x + part.diagram.width / 2} cy={part.diagram.y + part.diagram.height / 2} rx={part.diagram.width / 2} ry={part.diagram.height / 2} fill={part.diagram.color} stroke={selectedIds.includes(part.id) ? '#625222' : '#fffdf0'} strokeWidth={selectedIds.includes(part.id) ? 4 : 2}/> : <rect x={part.diagram.x} y={part.diagram.y} width={part.diagram.width} height={part.diagram.height} rx="12" fill={part.diagram.color} stroke={selectedIds.includes(part.id) ? '#625222' : '#fffdf0'} strokeWidth={selectedIds.includes(part.id) ? 4 : 2}/>}
        <text x={part.diagram.x + part.diagram.width / 2} y={part.diagram.y + part.diagram.height / 2} dominantBaseline="middle" textAnchor="middle" fontSize={part.label.length > 16 ? 12 : 14} fill="#203e32" fontFamily="Arial,sans-serif">{part.label}</text>
      </g>)}
    </svg>
    <p>{model.fallback.description}</p>
  </div>;
}
