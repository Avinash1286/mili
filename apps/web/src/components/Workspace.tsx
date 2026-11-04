'use client';
import { useCallback, useEffect, useRef, useState, useMemo, type KeyboardEvent } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { PracticePanel } from './product/PracticePanel';
import { GestureControls } from './GestureControls';
import type { GestureAction } from '@/lib/gestures';
import type { BoardInteractionAdapter } from '@/lib/board-interaction';
import type { SpatialSelection } from '@tokai/contracts';
import type { SpatialInteractionAdapter } from './spatial/SpatialViewer';
const SpatialViewer = dynamic(() => import('./spatial/SpatialViewer').then(module => module.SpatialViewer), { ssr: false, loading: () => <p role="status">Opening 3D learning space…</p> });
import { ArrowLeft, ArrowUp, BookOpen, Box, Check, Download, FileText, Headphones, Keyboard, Layers3, Mic, ListChecks, MessageCircle, PanelRight, RefreshCw, Sparkles, Square, Volume2, X, Save, RotateCcw, Lightbulb, CheckCircle2 } from 'lucide-react';
import { type Board, type Session, type Capabilities, type BoardAdapter, type SelectionContext, type ConceptMap, type MapUpdate, TOPICS } from '@tokai/contracts';
import { api, downloadBlob, errorText, downloadSummary, RequestError } from '@/lib/api';
import { Mark } from './Brand';
import { ConceptBoard } from './ConceptBoard';
import { VoiceControls, voiceOrbState } from './VoiceControls';
import { VoiceOrb } from './VoiceOrb';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { ConceptMapPanel } from './ConceptMapPanel';
import { boardDiff, localBoardChange, rebaseBoard } from '@/lib/board-state';
import type { BoardFocusRequest } from '@/lib/board-geometry';
import { useGesturesEnabled } from '@/lib/features';

const studyTabs = [
  { id: 'conversation', label: 'Conversation', Icon: MessageCircle },
  { id: 'concepts', label: 'Concepts', Icon: Layers3 },
  { id: 'cards', label: 'Cards', Icon: BookOpen },
  { id: 'practice', label: 'Practice', Icon: CheckCircle2 },
] as const;

export function Workspace({ id }: { id: string }) {
  const [session, setSession] = useState<Session>(); const [draft, setDraft] = useState<Board>(); const [selectedId, setSelectedId] = useState<string>();
  const [selection, setSelection] = useState<SelectionContext>(); const [conflict, setConflict] = useState(false); const [studyWidth, setStudyWidth] = useState(390);
  const [boardFocus, setBoardFocus] = useState<BoardFocusRequest>();
  const [spatialReadyKey, setSpatialReadyKey] = useState('');
  const [spatialOpen, setSpatialOpen] = useState(false), [spatialSelection, setSpatialSelection] = useState<SpatialSelection>();
  const spatialView = useRef({ open: spatialOpen, selection: spatialSelection }); spatialView.current = { open: spatialOpen, selection: spatialSelection };
  const boardInteraction = useRef<BoardInteractionAdapter | undefined>(undefined), spatialAdapter = useRef<SpatialInteractionAdapter | undefined>(undefined);
  const spatialPaints = useRef(new Set<{ key: string; resolve: (ready:boolean)=>void; timer:ReturnType<typeof setTimeout> }>());
  const spatialKey = (value: SpatialSelection) => `${value.modelId}:${value.assetVersion}:${[...value.partIds].sort().join(',')}`;
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [text, setText] = useState(''); const [tab, setTab] = useState<'conversation' | 'concepts' | 'cards' | 'practice'>('conversation'); const [mobileTab, setMobileTab] = useState<'board' | 'study'>('board');
  // Cards are a recap tool: shown after the lesson, or when the learner jumps to them from a concept.
  const visibleTabs = studyTabs.filter(item => item.id !== 'cards' || session?.status === 'ended' || tab === 'cards');
  function navigateStudyTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % visibleTabs.length : event.key === 'ArrowLeft' ? (index + visibleTabs.length - 1) % visibleTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault(); setTab(visibleTabs[next].id);
    document.getElementById(`study-tab-${id}-${visibleTabs[next].id}`)?.focus();
  }
  const [capabilities, setCapabilities] = useState<Capabilities>({ tutor: false, speech: false, voice: false }); const [flipped, setFlipped] = useState<Set<string>>(new Set()); const [speakingId, setSpeakingId] = useState<string>(); const [speechLoading, setSpeechLoading] = useState(false); const [saved, setSaved] = useState(false);
  const [capabilityState, setCapabilityState] = useState<'loading' | 'ready' | 'error'>('loading');
  const capabilityRequest = useRef(0);
  const loadCapabilities = useCallback(async () => {
    const request = ++capabilityRequest.current;
    setCapabilityState('loading');
    // A readiness read does not call providers. Retry one failed read, never a valid
    // response reporting unavailable configuration; each request has a 5 s deadline.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await api.health();
        if (request === capabilityRequest.current) { setCapabilities(value); setCapabilityState('ready'); }
        return;
      } catch {
        if (request !== capabilityRequest.current) return;
        if (attempt === 1) setCapabilityState('error');
      }
    }
  }, []);
  const sessionRef = useRef<Session | undefined>(undefined), draftRef = useRef<Board | undefined>(undefined), draftBase = useRef<Board | undefined>(undefined), savingBoard = useRef(false), adapter = useRef<BoardAdapter | undefined>(undefined);
  const painted = useRef(-1), paints = useRef(new Set<{ revision: number; focusKey: string; resolve: (ready: boolean) => void; timer: ReturnType<typeof setTimeout> }>());
  const messagesEnd = useRef<HTMLDivElement>(null), audio = useRef<HTMLAudioElement | null>(null), audioUrl = useRef<string | null>(null), speechEpoch = useRef(0);
  const pendingTextRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  const receiveBoard = useCallback((board: Board) => {
    const current = sessionRef.current; if (!current || (current.board.revision ?? 0) > (board.revision ?? 0)) return;
    if (draftRef.current && draftBase.current && !savingBoard.current) {
      const merged = rebaseBoard(draftBase.current, board, draftRef.current);
      if (merged.conflict) setConflict(true);
      else { draftBase.current = board; draftRef.current = merged.board; setDraft(merged.board); }
    }
    sessionRef.current = { ...current, board }; setSession(sessionRef.current);
  }, []);
  const receiveSession = useCallback((value: Session) => {
    if (sessionRef.current && value.revision < sessionRef.current.revision) return;
    receiveBoard(value.board);
    const current = sessionRef.current;
    sessionRef.current = { ...value, board: current && (current.board.revision ?? 0) > (value.board.revision ?? 0) ? current.board : value.board, conceptMap: current?.conceptMap && current.conceptMap.revision > (value.conceptMap?.revision ?? -1) ? current.conceptMap : value.conceptMap };
    setSession(sessionRef.current);
  }, [receiveBoard]);
  const receiveMap = useCallback((map: ConceptMap) => { if (!sessionRef.current || (sessionRef.current.conceptMap?.revision ?? -1) > map.revision) return; sessionRef.current = { ...sessionRef.current, conceptMap: map }; setSession(sessionRef.current); }, []);
  const boardReady = useCallback((revision: number, focusKey?: string) => { painted.current = revision; for (const waiter of paints.current) if (waiter.revision === revision && waiter.focusKey === focusKey) { clearTimeout(waiter.timer); waiter.resolve(true); paints.current.delete(waiter); } }, []);
  const prepareBoard = useCallback((board: Board, beatId?: string, signal?: AbortSignal, map?: ConceptMap, focusIds?: string[], spatialState?: SpatialSelection, visualSurface?: 'board' | 'spatial') => {
    if (!beatId) { receiveBoard(board); if (map) receiveMap(map); return Promise.resolve(true); }
    // Keep a queued visual cancellable until the browser is about to paint it.
    return new Promise<boolean>(resolve => {
      let settled = false;
      const done = (ready: boolean) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); resolve(ready); };
      const frame = requestAnimationFrame(() => {
        if (signal?.aborted) { done(false); return; }
        receiveBoard(board); if (map) receiveMap(map);
        if (draftRef.current) { done(false); return; }
        const targetSpatial = spatialState ?? (visualSurface === 'spatial' && spatialView.current.open ? spatialView.current.selection ?? sessionRef.current?.spatialState : undefined);
        if (targetSpatial) {
          const waiter = { key: spatialKey(targetSpatial), resolve: done, timer: setTimeout(() => { spatialPaints.current.delete(waiter); done(false); }, 2200) };
          spatialPaints.current.add(waiter); setSpatialReadyKey(beatId); setSpatialSelection(targetSpatial); setSpatialOpen(true); setMobileTab('board');
          if (sessionRef.current) { sessionRef.current = {...sessionRef.current, spatialState: targetSpatial, visualSurface: 'spatial'}; setSession(sessionRef.current); }
          return;
        }
        setSpatialOpen(false); setBoardFocus({ key: beatId, revision: board.revision ?? 0, ids: focusIds ?? [] });
        const waiter = { revision: board.revision ?? 0, focusKey: beatId, resolve: done, timer: setTimeout(() => { paints.current.delete(waiter); done(false); }, 2200) };
        paints.current.add(waiter);
      });
      const abort = () => { cancelAnimationFrame(frame); for (const waiter of paints.current) if (waiter.resolve === done) { clearTimeout(waiter.timer); paints.current.delete(waiter); } for (const waiter of spatialPaints.current) if (waiter.resolve === done) { clearTimeout(waiter.timer); spatialPaints.current.delete(waiter); } done(false); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }, [receiveBoard, receiveMap]);
  const questionSelection = useMemo<SelectionContext | undefined>(() => spatialOpen && spatialSelection ? { shapeIds: [], conceptIds: [], boardRevision: session?.board.revision ?? 0, spatial: spatialSelection } : selection, [spatialOpen, spatialSelection, session?.board.revision, selection]);
  const voice = useVoiceSession(id, receiveSession, spatialOpen ? undefined : session?.board.nodes.some(node => node.id === selectedId) ? selectedId : undefined, session?.status === 'ended', draft ? undefined : questionSelection, prepareBoard, receiveMap);
  const spatialReady = useCallback((modelId:string,assetVersion:string,ready:boolean,partIds:string[] = []) => { const key = `${modelId}:${assetVersion}:${[...partIds].sort().join(',')}`; for(const waiter of spatialPaints.current) if(waiter.key===key) { clearTimeout(waiter.timer); waiter.resolve(ready); spatialPaints.current.delete(waiter); } }, []);
  function gestureAction(action: GestureAction) {
    if (action.type === 'draw.end' || action.type === 'lost') { boardInteraction.current?.gesture(action); return; }
    if (action.type === 'help') { setText(spatialOpen ? 'Please explain the selected model part.' : 'Please explain this selected idea.'); setTab('conversation'); setMobileTab('study'); return; }
    if (!spatialOpen) { boardInteraction.current?.gesture(action); return; }
    if (action.type === 'rotate') spatialAdapter.current?.orbit(action.delta.x,action.delta.y);
    else if (action.type === 'zoom') spatialAdapter.current?.zoom(action.factor);
    else if (action.type === 'select') spatialAdapter.current?.selectAt(action.point.x,action.point.y);
  }
  const load = useCallback(async () => { setLoading(true); setError(''); try { const value = await api.session(id); draftRef.current = undefined; draftBase.current = undefined; setDraft(undefined); setConflict(false); sessionRef.current = value; setSession(value); if(value.spatialState) {setSpatialSelection(value.spatialState);setSpatialOpen(value.visualSurface !== 'board');} } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCapabilities(); return () => { capabilityRequest.current++; }; }, [loadCapabilities]);
  useEffect(() => () => { for (const waiter of paints.current) { clearTimeout(waiter.timer); waiter.resolve(false); } paints.current.clear(); for(const waiter of spatialPaints.current) {clearTimeout(waiter.timer);waiter.resolve(false);} spatialPaints.current.clear(); }, []);
  const stopSpeech = useCallback(() => { speechEpoch.current++; audio.current?.pause(); audio.current = null; if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; setSpeakingId(undefined); setSpeechLoading(false); }, []);
  useEffect(() => () => { speechEpoch.current++; audio.current?.pause(); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [session?.messages.length, busy]);
  function changeBoard(next: Board) { if (!draftRef.current) draftBase.current = sessionRef.current?.board; draftRef.current = next; setDraft(next); setSaved(false); }
  async function speak(messageId: string) { if (voice.connected) { if (voice.messageId === messageId && voice.state === 'speaking') voice.runtime.interrupt(); else voice.runtime.repeat(messageId); return; } if (speakingId === messageId) { stopSpeech(); return; } stopSpeech(); const epoch = speechEpoch.current; setSpeakingId(messageId); setSpeechLoading(true); try { const blob = await api.speech(id, messageId); if (epoch !== speechEpoch.current) return; const url = URL.createObjectURL(blob); audioUrl.current = url; const sound = new Audio(url); audio.current = sound; sound.onended = stopSpeech; sound.onerror = () => { setError('Audio couldn’t play. Please try again.'); stopSpeech(); }; await sound.play(); setSpeechLoading(false); } catch (e) { if (epoch === speechEpoch.current) { setError(errorText(e)); stopSpeech(); } } }
  async function saveBoard() {
    if (!sessionRef.current || !draftRef.current || conflict) return;
    let base = draftBase.current ?? sessionRef.current.board, remaining = boardDiff(base, draftRef.current);
    if (!remaining.length) { draftRef.current = undefined; setDraft(undefined); return; }
    setBusy(true); setError(''); savingBoard.current = true;
    try {
      while (remaining.length) {
        const transaction = { operationId: crypto.randomUUID(), expectedRevision: base.revision ?? 0, commands: remaining.slice(0, 100) };
        if (voice.connected) { base = await voice.runtime.boardOperation(transaction); receiveBoard(base); }
        else { const value = await api.boardOperations(id, transaction); base = value.board; receiveSession(value); }
        remaining = remaining.slice(100); draftBase.current = base;
      }
      draftRef.current = undefined; draftBase.current = undefined; setDraft(undefined); setConflict(false); setSaved(true);
      setSelection(previous => previous ? { ...previous, boardRevision: base.revision ?? 0, capturedAt: new Date().toISOString() } : previous);
    } catch (e) {
      try { draftRef.current = localBoardChange(base, remaining); setDraft(draftRef.current); draftBase.current = base; } catch { setConflict(true); }
      if (e instanceof RequestError && e.status === 409) { setConflict(true); setError('The board changed during this edit. Your work is preserved. Review the latest board before saving again.'); } else setError(errorText(e));
    } finally { savingBoard.current = false; setBusy(false); }
  }
  async function reviewConflict() {
    try { const fresh = await api.session(id), original = draftBase.current, pending = draftRef.current; if (!original || !pending) return;
      if (!window.confirm('Apply your pending edits over the latest board? Other untouched ideas will be preserved.')) return;
      const rebased = localBoardChange(fresh.board, boardDiff(original, pending)); sessionRef.current = fresh; setSession(fresh); draftBase.current = fresh.board; draftRef.current = rebased; setDraft(rebased); setConflict(false); setError('');
    } catch (e) { setError(errorText(e)); }
  }
  async function send(value = text) {
    if (!value.trim() || busy || draftRef.current || session?.status === 'ended') return;
    stopSpeech(); setError('');
    if (voice.connected) { if (voice.runtime.text(value.trim(), spatialOpen ? undefined : selectedId, questionSelection)) { setText(''); setMobileTab('study'); } else setError('Voice disconnected before sending. Retry your question.'); return; }
    setBusy(true); const previous = text, before = sessionRef.current; setText('');
    try {
      const key = JSON.stringify({ id, text: value.trim(), selectedNodeId: spatialOpen ? undefined : selectedId, selection: questionSelection });
      if (pendingTextRequest.current?.key !== key) pendingTextRequest.current = { key, id: crypto.randomUUID() };
      const reply = await api.message(id, value.trim(), spatialOpen ? undefined : selectedId, questionSelection, { requestId: pendingTextRequest.current.id });
      pendingTextRequest.current = undefined;
      const newBeat = [...(reply.teachingBeats ?? [])].reverse().find(beat => !before?.teachingBeats?.some(old => old.beatId === beat.beatId) && beat.highlightNodeIds.length > 0);
      const ids = newBeat?.highlightNodeIds ?? (before ? boardDiff(before.board, reply.board).flatMap(command => command.type === 'upsert_node' ? [command.node.id] : []) : []);
      receiveSession(reply);
      const visualBeat = [...(reply.teachingBeats ?? [])].reverse().find(beat => !before?.teachingBeats?.some(old => old.beatId === beat.beatId) && (beat.spatialUpdate || beat.boardCommands.length || beat.highlightNodeIds.length));
      if (visualBeat?.spatialUpdate) { setSpatialSelection(visualBeat.spatialUpdate); setSpatialOpen(true); } else if (ids.length || visualBeat) setSpatialOpen(false);
      if (ids.length) setBoardFocus({ key: `reply-${reply.revision}`, revision: reply.board.revision ?? 0, ids });
      setMobileTab('study');
    } catch (e) { setText(previous || value); setError(errorText(e)); } finally { setBusy(false); }
  }
  async function shareDrawing(data: string, question: string, context: SelectionContext) {
    if (draftRef.current) throw new Error('Save your board before sharing this drawing, so the tutor can link it to the right objects.');
    const wasConnected = voice.connected; stopSpeech(); voice.runtime.stop(); setBusy(true);
    try { let attempt = 0; for (;;) { try { receiveSession(await api.explainImage(id, question, context, data)); break; } catch (e) { if (wasConnected && e instanceof RequestError && e.code === 'VOICE_ACTIVE' && attempt++ < 2) { await new Promise(resolve => setTimeout(resolve, 150 * attempt)); continue; } throw e; } } setTab('conversation'); setMobileTab('study'); } finally { setBusy(false); }
  }
  async function saveMap(update: MapUpdate) { receiveSession(await api.map(id, update)); }
  async function end() { if (!session || busy || draft) return; stopSpeech(); voice.runtime.stop(); setBusy(true); setError(''); try { receiveSession(await api.end(id)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const [panelOpen, setPanelOpen] = useState(true), [typing, setTyping] = useState(false);
  const gesturesEnabled = useGesturesEnabled();
  // Light up board ideas the moment milli says their name.
  const spokenHighlights = useMemo(() => {
    if (!voice.words.length || voice.wordIndex < 0 || !session) return [];
    const clean = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const spoken = ` ${clean(voice.words.slice(Math.max(0, voice.wordIndex - 6), voice.wordIndex + 1).join(' '))} `;
    return session.board.nodes.filter(node => { const label = clean(node.label); return label.length > 2 && spoken.includes(` ${label} `); }).map(node => node.id).slice(0, 4);
  }, [voice.words, voice.wordIndex, session]);
  const highlightIds = useMemo(() => [...new Set([...voice.highlightNodeIds, ...spokenHighlights])], [voice.highlightNodeIds, spokenHighlights]);
  const greeted = useRef(false);
  const presentedId = session?.status === 'active' && session.practice?.status === 'presented' ? session.practice.presentation.id : undefined;
  const [answerByVoice, setAnswerByVoice] = useState(true);
  useEffect(() => { setAnswerByVoice(true); }, [presentedId]);
  useEffect(() => { voice.runtime.setAnswering(presentedId && answerByVoice ? presentedId : undefined); }, [presentedId, answerByVoice, voice.runtime]);
  voice.runtime.onCommand = command => {
    if (command === 'show-3d') { setSpatialSelection(value => value ?? sessionRef.current?.spatialState ?? { modelId: sessionRef.current?.topic === 'solar-system' ? 'solar-system' : 'chloroplast', assetVersion: '1.0.0', partIds: [] }); setSpatialOpen(true); setMobileTab('board'); }
    else if (command === 'hide-3d') setSpatialOpen(false);
    else if (command === 'finish-lesson') void end();
    else if (command !== 'repeat') { setTab(command === 'open-concepts' ? 'concepts' : command === 'open-practice' ? 'practice' : 'conversation'); setPanelOpen(true); setMobileTab('study'); }
  };
  useEffect(() => {
    if (!voice.connected || !voice.microphone) return;
    const current = sessionRef.current;
    if (greeted.current || !current || current.messages.some(message => message.role === 'student')) return;
    greeted.current = true;
    // A fresh lesson starts with milli speaking its opening line.
    const opening = [...current.messages].reverse().find(message => message.role === 'tutor' && message.delivery !== 'completed');
    if (opening) voice.runtime.repeat(opening.id);
  }, [voice.connected, voice.microphone, voice.runtime]);
  const selected = (draft || session?.board)?.nodes.find(n => n.id === selectedId); const topic = TOPICS.find(t => t.id === session?.topic); const ended = session?.status === 'ended';
  if (loading || !session) return <div className="workspace-loading lesson-loading"><main id="main"><VoiceOrb state={loading ? 'thinking' : 'off'}/>{loading ? <h1 role="status">Getting your lesson ready…</h1> : <><h1>Let’s reconnect.</h1><p role="alert">{error || 'This lesson is not available.'}</p><div className="lesson-loading-actions"><button className="chunky-button" onClick={() => void load()}><RefreshCw size={16}/> Try again</button><Link className="pill-button" href="/"><ArrowLeft size={15}/> Home</Link></div></>}</main></div>;
  const phases = ['diagnose', 'explain', 'practice', 'reflect'] as const;
  const phaseIndex = session.lessonFocus?.phase ? phases.indexOf(session.lessonFocus.phase) : -1;
  const studentTurns = session.messages.filter(message => message.role === 'student').length;
  const progress = ended ? 100 : phaseIndex >= 0 ? Math.round((phaseIndex + 1) / (phases.length + 1) * 100) : Math.min(80, 6 + studentTurns * 8);
  const quick = (prompt: string, label: string) => <button type="button" disabled={busy || !!draft} onClick={() => void send(prompt)}>{label}</button>;
  const showCompose = !voice.connected || !voice.microphone || typing || !!text;
  return <div className={`workspace milli-lesson ${panelOpen ? 'panel-open' : 'panel-closed'}`} style={{ '--study-width': `${studyWidth}px` } as React.CSSProperties}>
    <header className="lesson-topbar">
      <Link className="icon-button lesson-close" href="/" aria-label="My learning space"><X size={22}/></Link>
      <div className="lesson-progress" role="progressbar" aria-label="Lesson progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={ended ? 'Complete' : session.lessonFocus?.phase ?? 'In progress'}><span style={{ width: `${progress}%` }}/></div>
      {session.plan && <details className="pill-details plan-details"><summary className="plan-summary" aria-label="Lesson plan"><ListChecks size={16}/><span>{session.plan.minutes} min</span></summary><div className="pill-popover"><p className="popover-lead">{session.plan.goal}</p><ol>{session.plan.steps.map((step, index) => <li key={index}><strong>{step.title}</strong><span>{step.objective}</span></li>)}</ol><small>{session.plan.provenance === 'authored' ? 'Prepared plan' : 'AI-generated plan'} · {session.plan.level}</small></div></details>}
      <span className={`lesson-badge ${session.mode}`} title={session.mode === 'sample' ? 'Prepared responses, not live AI' : 'Live AI tutor. It can make mistakes.'}>{session.mode === 'sample' ? 'Sample' : 'Live AI'}</span>
      <button className="icon-button panel-toggle" aria-label={panelOpen ? 'Hide study panel' : 'Show study panel'} aria-expanded={panelOpen} onClick={() => setPanelOpen(value => !value)}><PanelRight size={20}/></button>
      {ended ? <button className="chunky-button small" onClick={() => downloadSummary(session)}><Download size={15}/><span>Save notes</span></button> : <button className="chunky-button small" disabled={busy || !!draft} onClick={() => void end()}><Check size={15}/><span>{busy ? 'One moment…' : 'Finish lesson'}</span></button>}
    </header>
    <main id="main" className="workspace-main"><div className="workspace-mobile-tabs"><button aria-pressed={mobileTab === 'board'} onClick={() => setMobileTab('board')}><Layers3 size={15}/> Whiteboard</button><button aria-pressed={mobileTab === 'study'} onClick={() => setMobileTab('study')}><MessageCircle size={15}/> Study tools</button></div>
      <section className={`board-section lesson-stage ${mobileTab === 'board' ? 'mobile-active' : ''}`}>
        <div className="stage-head"><div className="stage-title"><span>{topic?.subject ?? (ended ? 'Your notes' : 'Lesson')}</span><h1>{session.title}</h1>{session.lessonFocus?.nextStep && !ended && <p>{session.lessonFocus.nextStep}</p>}</div></div>
        <div className="stage-tools">
          <button className="pill-button" aria-pressed={spatialOpen} onClick={() => { setSpatialOpen(value => !value); setSpatialSelection(value => value ?? session.spatialState ?? { modelId: session.topic === 'solar-system' ? 'solar-system' : 'chloroplast', assetVersion: '1.0.0', partIds: [] }); }}><Box size={15}/>{spatialOpen ? 'Close 3D model' : '3D models'}</button>
          {!!session.citations?.length && <details className="pill-details"><summary className="pill-button"><FileText size={15}/>Sources · {session.citations.length}</summary><div className="pill-popover"><small>Retrieved passages. Not every claim is guaranteed to be supported.</small>{session.citations.map(citation => <article key={citation.id}><h3>{citation.title}{citation.page ? ` · p. ${citation.page}` : ''}</h3><blockquote>{citation.snippet}</blockquote><button className="text-button" onClick={() => void api.sourceDownload(citation.sourceId).then(blob => downloadBlob(blob, `source-${citation.sourceId}`)).catch(e => setError(e instanceof Error ? e.message : 'Source download failed.'))}>Download source</button></article>)}</div></details>}
          {gesturesEnabled && <GestureControls onAction={gestureAction} disabled={ended} spatial={spatialOpen}/>}
        </div>
        {conflict && <div className="board-conflict" role="status">Your edits overlap a newer board change. They’re still here.<div><button className="pill-button" onClick={() => void reviewConflict()}>Keep my edits</button><button className="pill-button" onClick={() => void load()}>Discard and load latest</button></div></div>}
        {spatialOpen && <SpatialViewer readinessKey={spatialReadyKey} selection={spatialSelection} topic={session.topic} onSelection={setSpatialSelection} onReady={spatialReady} adapterRef={spatialAdapter} disabled={busy} onExplain={() => gestureAction({ type: 'help' })}/>}
        <div className={spatialOpen ? 'board-behind-spatial' : 'board-active-view'}><ConceptBoard board={draft || session.board} selectedId={selectedId} selectedIds={selection?.shapeIds} onSelect={setSelectedId} onSelection={setSelection} onChange={changeBoard} readOnly={busy || ended} onReady={boardReady} adapterRef={adapter} interactionRef={boardInteraction} highlightIds={highlightIds} focusRequest={boardFocus} onExplain={!ended ? () => { setText('Please explain this selected idea.'); setTab('conversation'); } : undefined} onShare={!ended && session.mode === 'live' ? shareDrawing : undefined}/></div>
        {draft ? <div className="board-save"><span>Unsaved changes</span><button className="pill-button" disabled={busy} onClick={() => void load()}><RotateCcw size={14}/> Discard</button><button className="chunky-button small" disabled={busy || conflict} onClick={() => void saveBoard()}><Save size={14}/>{busy ? 'Saving…' : 'Save board'}</button></div> : saved && <span className="saved-indicator" role="status"><Check size={13}/>Changes saved</span>}
        {ended && <section className="summary-panel"><div className="summary-title"><span className="summary-icon"><CheckCircle2 size={22}/></span><h2>Your lesson, collected.</h2><Link className="pill-button" href={`/sessions/${session.id}`}><Headphones size={15}/> Audio recap</Link><button className="pill-button" onClick={() => downloadSummary(session)}><Download size={15}/> Download notes</button></div><div className="summary-text">{session.summary || 'Your conversation, concepts and cards are saved.'}</div></section>}
      </section>
      {panelOpen && <div className="workspace-splitter" role="separator" tabIndex={0} aria-label="Resize study panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={600} aria-valuenow={studyWidth} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setStudyWidth(value => Math.max(300, Math.min(600, value + (event.key === 'ArrowLeft' ? 20 : -20)))); } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setStudyWidth(Math.max(300, Math.min(600, window.innerWidth - event.clientX))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}/>}
      <aside className={`study-panel ${mobileTab === 'study' ? 'mobile-active' : ''} ${panelOpen ? '' : 'is-collapsed'}`}>
        <div className="study-tabs" role="tablist" aria-label="Study tools">{visibleTabs.map(({ id: value, label, Icon }, index) => <button key={value} id={`study-tab-${id}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`study-panel-${id}-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => navigateStudyTab(event, index)}><Icon size={15}/>{label}</button>)}</div>
        {tab === 'conversation' && <div className="conversation-panel" role="tabpanel" id={`study-panel-${id}-conversation`} aria-labelledby={`study-tab-${id}-conversation`} tabIndex={0}><div className="conversation-messages" role="group" aria-label="Lesson conversation">
          <p className={`lesson-disclosure ${session.mode}`}>{session.mode === 'sample' ? 'Sample lesson · prepared responses, not live AI' : 'Live AI · it can make mistakes'}</p>
          {session.messages.map(message => <article className={`chat-message message-${message.role}`} key={message.id} data-message-id={message.id}>
            <div className="message-label">{message.role === 'tutor' ? <><Mark small/> milli</> : 'You'}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div>
            <p>{message.text}</p>
            <div className="message-meta">
              {!!session.teachingBeats?.some(beat => beat.messageId === message.id) && <span className="beat-dots" role="group" aria-label="Explanation delivery">{session.teachingBeats.filter(beat => beat.messageId === message.id).map((beat, index) => { const label = `Part ${index + 1}: ${beat.status === 'completed' ? 'played' : beat.status === 'playing' ? 'speaking' : beat.status === 'interrupted' ? 'interrupted' : beat.status === 'failed' ? 'unavailable' : 'not played'}${beat.playedMs !== undefined ? `, ${(beat.playedMs / 1000).toFixed(1)} s heard` : ''}`; return <span key={beat.beatId} data-state={beat.status} title={label}><span className="sr-only">{label}</span></span>; })}</span>}
              {message.delivery && <span className={`speech-delivery delivery-${message.delivery}`}>{message.delivery === 'completed' ? 'Played' : message.delivery === 'interrupted' ? `Interrupted${message.playedMs !== undefined ? ` · ${(message.playedMs / 1000).toFixed(1)} s` : ''}` : message.delivery === 'failed' ? 'Speech unavailable' : message.delivery === 'playing' ? 'Playing' : 'Not yet played'}</span>}
              {message.role === 'tutor' && capabilities.speech && <button className={`listen-button ${speakingId === message.id ? 'playing' : ''}`} aria-label={speakingId === message.id ? 'Stop listening' : 'Listen'} title={speakingId === message.id && speechLoading ? 'Preparing audio' : undefined} onClick={() => void speak(message.id)}>{speakingId === message.id ? <Square size={12}/> : <Volume2 size={14}/>}</button>}
            </div>
          </article>)}
          {(busy || voice.state === 'thinking') && !draft && <div className="tutor-thinking" role="status"><span/><span/><span/>{session.mode === 'sample' ? 'Opening the next idea…' : 'Thinking…'}</div>}
          <div ref={messagesEnd}/>
          {ended && <div className="session-finished"><CheckCircle2 size={18}/><p>Lesson saved. Your notes and cards are ready.</p></div>}
        </div></div>}
        {tab === 'concepts' && <ConceptMapPanel panelId={`study-panel-${id}-concepts`} labelledBy={`study-tab-${id}-concepts`} session={session} disabled={busy || ended} onSave={saveMap} onSelect={node => { const boardNode = session.board.nodes.find(n => node.boardNodeIds?.includes(n.id) || n.conceptIds?.includes(node.id) || n.id === node.id); setSelectedId(boardNode?.id); setSelection({ shapeIds: boardNode ? [boardNode.id] : [], conceptIds: [node.id], boardRevision: session.board.revision ?? 0, capturedAt: new Date().toISOString() }); if (boardNode) adapter.current?.fitFrame(boardNode.frameId); }} onEvidence={ids => { setTab('conversation'); requestAnimationFrame(() => { const target = Array.from(document.querySelectorAll('[data-message-id]')).find(el => ids.includes(el.getAttribute('data-message-id') || '')); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); }} onCards={ids => { setTab('cards'); requestAnimationFrame(() => { const target = Array.from(document.querySelectorAll('[data-card-id]')).find(el => ids.includes(el.getAttribute('data-card-id') || '')); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); }}/>}
        {tab === 'practice' && <div className="practice-tab-panel" role="tabpanel" id={`study-panel-${id}-practice`} aria-labelledby={`study-tab-${id}-practice`} tabIndex={0}><PracticePanel sessionId={session.id} practice={session.practice} disabled={busy || voice.connected} onUpdated={() => void api.session(id).then(receiveSession).catch(e => setError(errorText(e)))}/></div>}
        {tab === 'cards' && <div className="flashcards-panel" role="tabpanel" id={`study-panel-${id}-cards`} aria-labelledby={`study-tab-${id}-cards`} tabIndex={0}><div className="panel-intro"><Link className="text-button" href={`/sessions/${session.id}`}>Open study pack</Link></div>{session.flashcards.map((card, index) => <button className={`flashcard ${flipped.has(card.id) ? 'is-flipped' : ''}`} key={card.id} data-card-id={card.id} onClick={() => setFlipped(previous => { const value = new Set(previous); if (value.has(card.id)) value.delete(card.id); else value.add(card.id); return value; })} aria-description="Activate to flip this card."><span className="flashcard-top"><span>{flipped.has(card.id) ? 'THE ANSWER' : `QUESTION ${index + 1}`}</span><Sparkles size={15}/></span><p>{flipped.has(card.id) ? card.back : card.front}</p><span className="flashcard-bottom"><RotateCcw size={12}/>{flipped.has(card.id) ? 'See question' : 'Reveal answer'}</span></button>)}{!session.flashcards.length && <p className="panel-empty">Cards appear as you learn.</p>}</div>}
      </aside>
    </main>
    {error && <div className="workspace-error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
    {!ended && <footer className="lesson-dock" data-orb={voiceOrbState(voice)}>
      {(voice.partial || voice.caption || voice.words.length > 0) && <div className="live-caption"><span>{voice.partial ? 'You' : 'milli'}</span>
        {voice.partial ? <p aria-live="polite">{voice.partial}</p> : voice.words.length ? <><p className="karaoke" aria-hidden="true">{(() => { const start = Math.max(0, voice.wordIndex - 10), end = Math.min(voice.words.length, start + 24); return voice.words.slice(start, end).map((word, offset) => <span key={start + offset} className={start + offset < voice.wordIndex ? 'said' : start + offset === voice.wordIndex ? 'now' : ''}>{word} </span>); })()}</p><p className="sr-only" aria-live="polite">{voice.caption || voice.words.join(' ')}</p></> : <p aria-live="polite">{voice.caption}</p>}</div>}
      <div className="dock-row">
        <VoiceControls voice={voice} session={session} configured={capabilities.voice} availability={capabilityState} retryAvailability={() => void loadCapabilities()} locked={!!draft || busy} beforeStart={stopSpeech}/>
        <div className="dock-compose">
          {(selected || draft || session.practice?.status === 'presented') && <div className="dock-context">
            {selected && <div className="selected-chip"><span>About <strong>{selected.label}</strong></span><button aria-label="Clear question context" onClick={() => setSelectedId(undefined)}><X size={13}/></button></div>}
            {draft && <p className="compose-notice">Save or discard board edits to continue.</p>}
            {session.practice?.status === 'presented' && voice.connected && voice.microphone && <><span className="answer-chip" role="status"><Mic size={14}/>{answerByVoice ? 'milli asked you — answer out loud' : 'Your next words go to milli as a question'}</span><button className="pill-button" onClick={() => setAnswerByVoice(value => !value)}>{answerByVoice ? 'Ask instead' : 'Answer instead'}</button></>}
            {session.practice?.status === 'presented' && <button className="pill-button accent" disabled={busy} onClick={() => { stopSpeech(); voice.runtime.stop(); setTab('practice'); setPanelOpen(true); setMobileTab('study'); }}><Lightbulb size={14}/>{voice.connected ? 'Answer in writing' : 'Answer tutor question'}</button>}
          </div>}
          {showCompose ? <form onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="question">Ask your tutor a question</label><textarea id="question" autoFocus={typing} placeholder={selected ? `Ask about ${selected.label.toLowerCase()}…` : 'Ask milli anything…'} value={text} onChange={event => setText(event.target.value)} maxLength={2000} disabled={busy || !!draft} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } if (event.key === 'Escape' && voice.connected) setTyping(false); }} rows={1}/><button className="send-button" type="submit" aria-label="Send question" disabled={!text.trim() || busy || !!draft}><ArrowUp size={18}/></button></form>
            : <button type="button" className="pill-button type-instead" onClick={() => setTyping(true)}><Keyboard size={15}/>Type instead</button>}
          <div className="quick-questions">{quick('Can you explain this more simply?', 'Explain simply')}{quick('Ask me a practice question', 'Quiz me')}{quick('Let me teach this idea back to you. Ask me to explain it in my own words, then tell me what I got right and what I missed.', 'Teach it back')}{quick('Give me a real-world example.', 'Example')}</div>
        </div>
      </div>
    </footer>}
  </div>;
}
