import type { Board } from '@tokai/contracts';
import styles from './Product.module.css';

/** A read-only semantic diagram with the same labels available as ordinary text. */
export function LearningDiagram({ board, targetIds = [] }: { board: Board; targetIds?: string[] }) {
  if (!board.nodes.length) return null;
  const minX = Math.min(...board.nodes.map(node => node.x)) - 25, minY = Math.min(...board.nodes.map(node => node.y)) - 25;
  const width = Math.max(...board.nodes.map(node => node.x + (node.width ?? 220))) - minX + 25, height = Math.max(...board.nodes.map(node => node.y + (node.height ?? 130))) - minY + 25;
  return <div><svg viewBox={`${minX} ${minY} ${width} ${height}`} role="img" aria-label="Practice diagram" style={{ display: 'block', width: '100%', maxHeight: 330, border: '1px solid #d7e1c8', borderRadius: 8, background: '#f7f9ef' }}>
    {board.edges.map(edge => { const from = board.nodes.find(node => node.id === edge.from), to = board.nodes.find(node => node.id === edge.to); return from && to ? <line key={edge.id} x1={from.x + (from.width ?? 220) / 2} y1={from.y + (from.height ?? 130) / 2} x2={to.x + (to.width ?? 220) / 2} y2={to.y + (to.height ?? 130) / 2} stroke="#a0b88a" strokeWidth={3}><title>{edge.label || 'Connected'}</title></line> : null; })}
    {board.nodes.map(node => <g key={node.id}><rect x={node.x} y={node.y} width={node.width ?? 220} height={node.height ?? 130} rx={10} fill={targetIds.includes(node.id) ? '#f3e9bd' : '#eaf1df'} stroke="#a7b994"/><text x={node.x + (node.width ?? 220) / 2} y={node.y + (node.height ?? 130) / 2} textAnchor="middle" dominantBaseline="middle" fill="#3b5930" fontSize={16}>{targetIds.includes(node.id) ? `Label ${targetIds.indexOf(node.id) + 1}` : node.label}</text></g>)}
  </svg><details className={styles.prose}><summary>Read the diagram as text</summary><ul>{board.nodes.map(node => <li key={node.id}>{targetIds.includes(node.id) ? `Label ${targetIds.indexOf(node.id) + 1}` : node.label}{!targetIds.includes(node.id) && node.detail ? `: ${node.detail}` : ''}</li>)}</ul>{board.edges.length > 0 && <ul>{board.edges.map(edge => <li key={edge.id}>{targetIds.includes(edge.from) ? `Label ${targetIds.indexOf(edge.from) + 1}` : board.nodes.find(node => node.id === edge.from)?.label} {edge.label || 'connects to'} {targetIds.includes(edge.to) ? `Label ${targetIds.indexOf(edge.to) + 1}` : board.nodes.find(node => node.id === edge.to)?.label}</li>)}</ul>}</details></div>;
}
