'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Check, Expand, Eye, Focus, HelpCircle, LoaderCircle, Pause, Play, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { SPATIAL_CATALOG, getSpatialModel, spatialModelForTopic, type SpatialSelection } from '@milli/contracts';
import type { SpatialInteractionAdapter, SpatialLabel, SpatialRenderer } from '@/lib/spatial/renderer';
import { SpatialDiagram } from './SpatialDiagram';
import styles from './SpatialViewer.module.css';

export type { SpatialInteractionAdapter } from '@/lib/spatial/renderer';
export type SpatialViewerProps = {
  selection?: SpatialSelection; topic?: string; readinessKey?: string; onSelection: (value: SpatialSelection) => void;
  onReady?: (modelId: string, assetVersion: string, ready: boolean, partIds?: string[]) => void;
  adapterRef?: MutableRefObject<SpatialInteractionAdapter | undefined>; onExplain?: () => void; disabled?: boolean;
};
export function SpatialViewer({ selection, topic, readinessKey, onSelection, onReady, adapterRef, onExplain, disabled = false }: SpatialViewerProps) {
  const [localSelection, setLocalSelection] = useState<SpatialSelection>(() => ({ modelId: spatialModelForTopic(topic ?? '')?.id ?? 'solar-system', assetVersion: '1.0.0', partIds: [] }));
  const current = selection ?? localSelection, model = getSpatialModel(current.modelId) ?? SPATIAL_CATALOG[0]!;
  const selectedIds = current.assetVersion === model.assetVersion ? current.partIds.filter(id => model.parts.some(part => part.id === id)) : [];
  const selectionKey = selectedIds.join('\u0000');
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading'), [fallback, setFallback] = useState(false), [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  const [labels, setLabels] = useState<SpatialLabel[]>([]), [showLabels, setShowLabels] = useState(true), [isolate, setIsolate] = useState(false), [animation, setAnimation] = useState(false);
  const host = useRef<HTMLDivElement>(null), engine = useRef<SpatialRenderer | undefined>(undefined), callbacks = useRef({ onSelection, onReady });
  callbacks.current = { onSelection, onReady };
  const selectionRef = useRef(selectedIds); selectionRef.current = selectedIds;
  const modelRef = useRef(model); modelRef.current = model;
  const select = useCallback((partId: string) => {
    const value = { modelId: modelRef.current.id, assetVersion: modelRef.current.assetVersion, partIds: [partId] };
    setLocalSelection(value); callbacks.current.onSelection(value);
  }, []);

  useEffect(() => {
    setLabels([]); setIsolate(false); setAnimation(false);
    if (fallback) { setStatus('fallback'); return; }
    let cancelled = false; setStatus('loading'); setFailure('');
    void import('@/lib/spatial/renderer').then(({ SpatialRenderer: Renderer }) => {
      if (cancelled || !host.current) return;
      try {
        const renderer = new Renderer(host.current, model, {
          onPart: select,
          onReady: partIds => { if (cancelled) return; setStatus('ready'); callbacks.current.onReady?.(model.id, model.assetVersion, true, partIds); },
          onError: message => { if (cancelled) return; setFailure(message); setFallback(true); },
          onLabels: next => { if (!cancelled) setLabels(next); },
        });
        engine.current = renderer; renderer.setSelection(selectionRef.current);
        if (adapterRef) adapterRef.current = renderer;
      } catch (error) { setFailure(error instanceof Error ? error.message : 'This device cannot display 3D graphics.'); setFallback(true); }
    }).catch(() => { if (!cancelled) { setFailure('The 3D viewer could not load. The labeled diagram is ready below.'); setFallback(true); } });
    return () => { cancelled = true; engine.current?.dispose(); engine.current = undefined; if (adapterRef) adapterRef.current = undefined; };
  }, [model.id, model.assetVersion, fallback, retry, select, adapterRef]);
  useEffect(() => { engine.current?.setSelection(selectedIds, isolate); }, [selectionKey, isolate, readinessKey]);
  useEffect(() => { engine.current?.setAnimation(animation); }, [animation]);
  useLayoutEffect(() => {
    if (!fallback) return;
    const frame = requestAnimationFrame(() => callbacks.current.onReady?.(model.id, model.assetVersion, true, [...selectionRef.current]));
    return () => cancelAnimationFrame(frame);
  }, [fallback, model.id, model.assetVersion, selectionKey, readinessKey]);
  const changeModel = (id: string) => {
    const next = getSpatialModel(id); if (!next) return;
    const value = { modelId: next.id, assetVersion: next.assetVersion, partIds: [] };
    setLocalSelection(value); callbacks.current.onSelection(value);
  };
  const selected = model.parts.filter(part => selectedIds.includes(part.id));
  const ready3d = status === 'ready' && !fallback;
  return <section className={styles.viewer} aria-label="Spatial learning viewer" data-model-id={model.id}>
    <div className={styles.heading}>
      <div><span className={styles.eyebrow}>EXPLORE FROM EVERY ANGLE</span><h2>{model.title}</h2><p>{model.description}</p></div>
      <label className={styles.modelSelect}>Model<select value={model.id} onChange={event => changeModel(event.target.value)}>{SPATIAL_CATALOG.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    </div>
    {topic && !spatialModelForTopic(topic) && <p className={styles.topicNotice}>This topic has no dedicated 3D model yet. These four models are available to explore; your whiteboard remains available for the lesson.</p>}
    <div className={styles.toolbar} role="group" aria-label="3D view controls">
      <button type="button" aria-label="Rotate left" title="Rotate left" disabled={!ready3d} onClick={() => engine.current?.orbit(-.07, 0)}><ArrowLeft size={16}/></button>
      <button type="button" aria-label="Rotate right" title="Rotate right" disabled={!ready3d} onClick={() => engine.current?.orbit(.07, 0)}><ArrowRight size={16}/></button>
      <button type="button" aria-label="Tilt up" title="Tilt up" disabled={!ready3d} onClick={() => engine.current?.orbit(0, -.07)}><ArrowUp size={16}/></button>
      <button type="button" aria-label="Tilt down" title="Tilt down" disabled={!ready3d} onClick={() => engine.current?.orbit(0, .07)}><ArrowDown size={16}/></button>
      <span className={styles.divider}/>
      <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!ready3d} onClick={() => engine.current?.zoom(1.2)}><ZoomIn size={16}/></button>
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!ready3d} onClick={() => engine.current?.zoom(1 / 1.2)}><ZoomOut size={16}/></button>
      <button type="button" disabled={!ready3d} onClick={() => engine.current?.reset()}><RotateCcw size={15}/> Reset view</button>
      <label className={styles.preset}>Camera view<select aria-label="Camera view" disabled={!ready3d} defaultValue="overview" key={model.id} onChange={event => engine.current?.reset(event.target.value)}>{model.cameraPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
    </div>
    <div className={styles.stage}>
      {!fallback && <div ref={host} className={styles.canvasHost}/>}
      {!fallback && status === 'loading' && <div className={styles.loading} role="status"><LoaderCircle className={styles.spinner} size={24}/><span>Loading the model…</span><small>The part descriptions are already available below.</small></div>}
      {ready3d && showLabels && <div className={styles.labels}>{labels.filter(label => model.parts.some(part => part.id === label.id)).map(label => <button key={label.id} aria-label={`Select ${model.parts.find(part => part.id === label.id)!.label} on model`} aria-pressed={selectedIds.includes(label.id)} style={{ left: label.x, top: label.y }} onClick={() => select(label.id)}>{model.parts.find(part => part.id === label.id)!.label}</button>)}</div>}
      {fallback && <SpatialDiagram model={model} selectedIds={selectedIds} onSelect={select}/>}
      <div className={styles.stageBadge}><Box size={13}/>{fallback ? 'Labeled 2D diagram' : 'Original schematic model'}</div>
    </div>
    <div className={styles.viewStatus}>
      <span role="status">{fallback ? <><Check size={14}/> 2D diagram ready</> : ready3d ? <><Check size={14}/> 3D model ready</> : 'Preparing 3D…'}</span>
      <button type="button" onClick={() => { if (fallback) { setFallback(false); setRetry(value => value + 1); } else setFallback(true); }}>{fallback ? 'Try 3D again' : 'Use 2D diagram'}</button>
    </div>
    {failure && fallback && <p className={styles.notice} role="status">{failure} You can select the same parts in the diagram and list.</p>}
    <div className={styles.options}>
      <button type="button" aria-pressed={showLabels} disabled={!ready3d} onClick={() => setShowLabels(value => !value)}><Eye size={15}/> Show labels</button>
      <button type="button" aria-pressed={isolate} disabled={!ready3d || !selectedIds.length} onClick={() => setIsolate(value => !value)}><Expand size={15}/> Isolate selected part</button>
      <button type="button" disabled={!ready3d || !selectedIds.length} onClick={() => engine.current?.focusSelected()}><Focus size={15}/> Focus selected</button>
      {model.animations[0] && <button type="button" aria-pressed={animation} disabled={!ready3d} onClick={() => setAnimation(value => !value)}>{animation ? <Pause size={15}/> : <Play size={15}/>} {model.animations[0].label}</button>}
    </div>
    <p className={styles.instructions}>{fallback ? 'Choose a labeled part, or use the keyboard-accessible list below.' : 'Drag to orbit · Pinch or scroll to zoom · Arrow keys rotate · + / − zoom · R resets'}</p>
    {animation && <p className={styles.animationNote}>{model.animations[0]?.description}</p>}
    <div className={styles.partSection}>
      <div className={styles.partHeading}><h3>Meet the parts</h3><span>{model.parts.length} things to explore</span></div>
      <div className={styles.partList} role="group" aria-label="Model parts">{model.parts.map(part => <button key={part.id} type="button" aria-label={`Select ${part.label}`} aria-pressed={selectedIds.includes(part.id)} onClick={() => select(part.id)}><span style={{ background: part.diagram.color }}/>{part.label}{selectedIds.includes(part.id) && <Check size={13}/>}</button>)}</div>
      <div className={styles.partDetails} aria-live="polite">{selected.length ? selected.map(part => <article key={part.id}><span className={styles.eyebrow}>SELECTED PART</span><h3>{part.label}</h3><p>{part.description}</p></article>) : <p>Select a part to see its role and ask about it.</p>}
        {onExplain && selected.length > 0 && <button type="button" className={styles.explain} disabled={disabled} onClick={onExplain}><HelpCircle size={16}/> Explain selected part</button>}
      </div>
    </div>
    <p className={styles.scaleNote}>{model.scaleNote}</p>
    <details className={styles.provenance}><summary>Model sources and provenance</summary><p>{model.attribution}</p><p>Asset version {model.assetVersion} · <a href="/models/LICENSE.txt" target="_blank" rel="noreferrer">{model.license} asset license</a> · <a href="/models/manifest.json" target="_blank" rel="noreferrer">Asset manifest</a></p><ul>{model.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul><p>{model.accessibilityDescription}</p></details>
  </section>;
}
export default SpatialViewer;
