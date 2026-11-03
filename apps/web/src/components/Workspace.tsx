'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, Download, Layers3, MessageCircle, RefreshCw, Send, Sparkles, Square, Volume2, X, Save, RotateCcw, Lightbulb, CheckCircle2 } from 'lucide-react';
import { type Board, type Session, type Capabilities, type BoardAdapter, type SelectionContext, type ConceptMap, type MapUpdate, TOPICS } from '@tokai/contracts';
import { api, errorText, downloadSummary, RequestError } from '@/lib/api';
import { Brand, Mark } from './Brand';
import { ConceptBoard } from './ConceptBoard';
import { VoiceControls } from './VoiceControls';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { ConceptMapPanel } from './ConceptMapPanel';
import { boardDiff, localBoardChange, rebaseBoard } from '@/lib/board-state';
import type { BoardFocusRequest } from '@/lib/board-geometry';

export function Workspace({ id }: { id: string }) {
  const [session, setSession] = useState<Session>(); const [draft, setDraft] = useState<Board>(); const [selectedId, setSelectedId] = useState<string>();
  const [selection, setSelection] = useState<SelectionContext>(); const [conflict, setConflict] = useState(false); const [studyWidth, setStudyWidth] = useState(390);
  const [boardFocus, setBoardFocus] = useState<BoardFocusRequest>();
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [text, setText] = useState(''); const [tab, setTab] = useState<'conversation' | 'concepts' | 'cards'>('conversation'); const [mobileTab, setMobileTab] = useState<'board' | 'study'>('board');
  const [capabilities, setCapabilities] = useState<Capabilities>({ tutor: false, speech: false, voice: false }); const [flipped, setFlipped] = useState<Set<string>>(new Set()); const [speakingId, setSpeakingId] = useState<string>(); const [speechLoading, setSpeechLoading] = useState(false); const [saved, setSaved] = useState(false);
  const sessionRef = useRef<Session | undefined>(undefined), draftRef = useRef<Board | undefined>(undefined), draftBase = useRef<Board | undefined>(undefined), savingBoard = useRef(false), adapter = useRef<BoardAdapter | undefined>(undefined);
  const painted = useRef(-1), paints = useRef(new Set<{ revision: number; focusKey: string; resolve: (ready: boolean) => void; timer: ReturnType<typeof setTimeout> }>());
  const messagesEnd = useRef<HTMLDivElement>(null), audio = useRef<HTMLAudioElement | null>(null), audioUrl = useRef<string | null>(null), speechEpoch = useRef(0);
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
  const prepareBoard = useCallback((board: Board, beatId?: string, signal?: AbortSignal, map?: ConceptMap, focusIds?: string[]) => {
    if (!beatId) { receiveBoard(board); if (map) receiveMap(map); return Promise.resolve(true); }
    // Keep a queued visual cancellable until the browser is about to paint it.
    return new Promise<boolean>(resolve => {
      let settled = false;
      const done = (ready: boolean) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); resolve(ready); };
      const frame = requestAnimationFrame(() => {
        if (signal?.aborted) { done(false); return; }
        receiveBoard(board); if (map) receiveMap(map);
        if (draftRef.current) { done(false); return; }
        setBoardFocus({ key: beatId, revision: board.revision ?? 0, ids: focusIds ?? [] });
        const waiter = { revision: board.revision ?? 0, focusKey: beatId, resolve: done, timer: setTimeout(() => { paints.current.delete(waiter); done(false); }, 2200) };
        paints.current.add(waiter);
      });
      const abort = () => { cancelAnimationFrame(frame); for (const waiter of paints.current) if (waiter.resolve === done) { clearTimeout(waiter.timer); paints.current.delete(waiter); } done(false); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }, [receiveBoard, receiveMap]);
  const voice = useVoiceSession(id, receiveSession, session?.board.nodes.some(node => node.id === selectedId) ? selectedId : undefined, session?.status === 'ended', draft ? undefined : selection, prepareBoard, receiveMap);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const value = await api.session(id); draftRef.current = undefined; draftBase.current = undefined; setDraft(undefined); setConflict(false); sessionRef.current = value; setSession(value); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, [id]);
  useEffect(() => { void load(); void api.health().then(setCapabilities).catch(() => {}); }, [load]);
  useEffect(() => () => { for (const waiter of paints.current) { clearTimeout(waiter.timer); waiter.resolve(false); } paints.current.clear(); }, []);
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
    if (voice.connected) { if (voice.runtime.text(value.trim(), selectedId, selection)) { setText(''); setMobileTab('study'); } else setError('Voice disconnected before sending. Retry your question.'); return; }
    setBusy(true); const previous = text, before = sessionRef.current; setText('');
    try {
      const reply = await api.message(id, value.trim(), selectedId, selection);
      const newBeat = [...(reply.teachingBeats ?? [])].reverse().find(beat => !before?.teachingBeats?.some(old => old.beatId === beat.beatId) && beat.highlightNodeIds.length > 0);
      const ids = newBeat?.highlightNodeIds ?? (before ? boardDiff(before.board, reply.board).flatMap(command => command.type === 'upsert_node' ? [command.node.id] : []) : []);
      receiveSession(reply);
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
  const selected = (draft || session?.board)?.nodes.find(n => n.id === selectedId); const topic = TOPICS.find(t => t.id === session?.topic); const ended = session?.status === 'ended';
  if (loading || !session) return <div className="workspace-loading"><header><Brand /><Link className="subtle-button" href="/"><ArrowLeft size={16}/> Back to your space</Link></header><main id="main"><Mark/><h1>{loading ? 'Making room for a new idea…' : 'Let’s reconnect.'}</h1>{loading ? <span className="spinner"/> : <><p role="alert">{error || 'This lesson is not available.'}</p><button className="primary-button" onClick={() => void load()}><RefreshCw size={16}/> Try again</button></>}</main></div>;
  return <div className="workspace" style={{ '--study-width': `${studyWidth}px` } as React.CSSProperties}><header className="workspace-topbar"><Brand /><div className="workspace-title"><span>{topic?.subject} <span> / </span> {ended ? 'Your study notes' : 'Learning session'}</span><strong>{session.title}</strong></div><div className="workspace-top-actions"><span className={`lesson-mode ${session.mode}`}><span/>{session.mode === 'sample' ? 'Guided sample' : 'Live AI'}</span><Link className="icon-button" href="/" aria-label="Back to your learning space"><X size={21}/></Link></div></header>
    <main id="main" className="workspace-main"><div className="workspace-mobile-tabs"><button aria-pressed={mobileTab === 'board'} onClick={() => setMobileTab('board')}><Layers3 size={15}/> Whiteboard</button><button aria-pressed={mobileTab === 'study'} onClick={() => setMobileTab('study')}><MessageCircle size={15}/> Study tools</button></div>
      <section className={`board-section ${mobileTab === 'board' ? 'mobile-active' : ''}`}><div className="board-heading"><div><span className="eyebrow">FOLLOW THE CONNECTIONS</span><h1>Let’s see the bigger picture.</h1>{session.lessonFocus && <p className="lesson-focus"><strong>{session.lessonFocus.goal}</strong><span>{session.lessonFocus.nextStep}</span></p>}</div><span className="board-chip"><span/> Your whiteboard</span></div>{conflict && <div className="board-conflict" role="status">Your edits overlap a newer board change. They are still here.<div><button className="subtle-button" onClick={() => void reviewConflict()}>Review and keep my edits</button><button className="subtle-button" onClick={() => void load()}>Discard and load latest</button></div></div>}<ConceptBoard board={draft || session.board} selectedId={selectedId} selectedIds={selection?.shapeIds} onSelect={setSelectedId} onSelection={setSelection} onChange={changeBoard} readOnly={busy || ended} onReady={boardReady} adapterRef={adapter} highlightIds={voice.highlightNodeIds} focusRequest={boardFocus} onExplain={!ended ? () => { setText('Please explain this selected idea.'); setTab('conversation'); setMobileTab('study'); } : undefined} onShare={!ended && session.mode === 'live' ? shareDrawing : undefined}/><div className="board-bottom"><div className="board-caption"><Lightbulb size={17}/><span>{voice.connected ? 'Draw and arrange while you talk. Save to share your changes.' : 'Select an idea. Ask a question. Make it yours.'}</span></div>{draft ? <div className="board-save"><span>Unsaved changes</span><button className="subtle-button" disabled={busy} onClick={() => void load()}><RotateCcw size={14}/> Discard</button><button className="small-button" disabled={busy || conflict} onClick={() => void saveBoard()}><Save size={14}/>{busy ? 'Saving…' : 'Save board'}</button></div> : <span className="saved-indicator"><Check size={13}/>{saved ? 'Changes saved' : 'Saved to your lesson'}</span>}</div>
      {ended && <section className="summary-panel"><div className="summary-title"><span className="summary-icon"><CheckCircle2 size={20}/></span><div><span className="eyebrow">A LITTLE MORE UNDERSTANDING</span><h2>Your lesson, collected.</h2></div><button className="subtle-button" onClick={() => downloadSummary(session)}><Download size={15}/> Download notes</button></div><div className="summary-text">{session.summary || 'Your conversation, concepts and flashcards are saved. You can return to them any time.'}</div></section>}
      </section>
      <div className="workspace-splitter" role="separator" tabIndex={0} aria-label="Resize study panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={600} aria-valuenow={studyWidth} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setStudyWidth(value => Math.max(300, Math.min(600, value + (event.key === 'ArrowLeft' ? 20 : -20)))); } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setStudyWidth(Math.max(300, Math.min(600, window.innerWidth - event.clientX))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}/>
      <aside className={`study-panel ${mobileTab === 'study' ? 'mobile-active' : ''}`}><div className="tutor-heading"><div className="tutor-avatar"><Mark small/></div><div><h2>Your learning companion</h2><p>{session.mode === 'sample' ? 'A guided lesson, at your pace' : 'A little help making things click'}</p></div><span className="tutor-online"/></div>{!ended && <VoiceControls voice={voice} session={session} configured={capabilities.voice} locked={!!draft || busy} beforeStart={stopSpeech}/>}<div className="study-tabs" role="tablist" aria-label="Study tools"><button role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}><MessageCircle size={14}/> Conversation</button><button role="tab" aria-selected={tab === 'concepts'} onClick={() => setTab('concepts')}><Layers3 size={14}/> Concepts</button><button role="tab" aria-selected={tab === 'cards'} onClick={() => setTab('cards')}><BookOpen size={14}/> Cards</button></div>
        {tab === 'conversation' && <div className="conversation-panel" role="tabpanel"><div className="conversation-messages" aria-label="Lesson conversation"><div className="lesson-disclosure">{session.mode === 'sample' ? <><span>SAMPLE LESSON</span>These are prepared learning responses, not live AI. Try selecting a concept and asking about it.</> : <><span>LIVE AI TUTOR</span>Your tutor can make mistakes. Ask for clarification and check important facts.</>}</div>{session.messages.map(message => <article className={`chat-message message-${message.role}`} key={message.id} data-message-id={message.id}><div className="message-label">{message.role === 'tutor' ? <><Mark small/> Tokai</> : 'You'}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p>{!!session.teachingBeats?.some(beat => beat.messageId === message.id) && <div className="teaching-beat-list" aria-label="Explanation delivery">{session.teachingBeats.filter(beat => beat.messageId === message.id).map((beat, index) => <div key={beat.beatId} data-state={beat.status}><span>{beat.status === 'completed' ? 'Played' : beat.status === 'playing' ? 'Speaking' : beat.status === 'interrupted' ? 'Interrupted' : beat.status === 'failed' ? 'Unavailable' : 'Not played'}</span><span>Part {index + 1}{beat.playedMs !== undefined ? ` · ${(beat.playedMs / 1000).toFixed(1)} s heard` : ''}{beat.warnings?.length ? ` · ${beat.warnings.join(' ')}` : ''}</span></div>)}</div>}{message.delivery && <span className={`speech-delivery delivery-${message.delivery}`}>{message.delivery === 'completed' ? 'Played' : message.delivery === 'interrupted' ? `Interrupted${message.playedMs !== undefined ? ` · ${(message.playedMs / 1000).toFixed(1)} s played` : ''}` : message.delivery === 'failed' ? 'Speech unavailable' : message.delivery === 'playing' ? 'Playing' : 'Not yet played'}</span>}{message.role === 'tutor' && capabilities.speech && <button className={`listen-button ${speakingId === message.id ? 'playing' : ''}`} onClick={() => void speak(message.id)}>{speakingId === message.id ? <Square size={12}/> : <Volume2 size={14}/>} {speakingId === message.id ? speechLoading ? 'Preparing · stop' : 'Stop listening' : 'Listen'}</button>}</article>)}{(busy || voice.state === 'thinking') && !draft && <div className="tutor-thinking" role="status"><span/><span/><span/>{session.mode === 'sample' ? 'Opening the next idea…' : 'Thinking it through…'}</div>}<div ref={messagesEnd}/>{voice.partial && <div className="voice-partial" aria-live="polite"><span>HEARING YOU</span><p>{voice.partial}</p></div>}{voice.caption && <div className="voice-caption"><span>{voice.state === 'speaking' ? 'TUTOR SPEECH' : 'UPCOMING SPEECH'}</span><p>{voice.caption}</p></div>}</div>{!ended ? <div className="conversation-compose">{selected && <div className="selected-chip"><span>Asking about <strong>{selected.label}</strong></span><button aria-label="Clear question context" onClick={() => setSelectedId(undefined)}><X size={13}/></button></div>}{draft && <p className="compose-notice">Save or discard your board edits before continuing.</p>}<form onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="question">Ask your tutor a question</label><textarea id="question" placeholder={selected ? `What are you wondering about ${selected.label.toLowerCase()}?` : 'What are you wondering about?'} value={text} onChange={event => setText(event.target.value)} maxLength={2000} disabled={busy || !!draft} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} rows={2}/><button className="send-button" type="submit" aria-label="Send question" disabled={!text.trim() || busy || !!draft}><ArrowRight size={19}/></button></form><div className="quick-questions"><button disabled={busy || !!draft} onClick={() => void send('Can you explain this more simply?')}>Explain simply</button><button disabled={busy || !!draft} onClick={() => void send('Ask me a practice question')}>Quiz me</button></div><p className="compose-hint">Enter to send <span>·</span> Shift + Enter for a new line</p></div> : <div className="session-finished"><CheckCircle2 size={18}/><p>This lesson is saved.<br/><span>Your notes and cards are ready to revisit.</span></p></div>}</div>}
        {tab === 'concepts' && <ConceptMapPanel session={session} disabled={busy || ended} onSave={saveMap} onSelect={node => { const boardNode = session.board.nodes.find(n => node.boardNodeIds?.includes(n.id) || n.conceptIds?.includes(node.id) || n.id === node.id); setSelectedId(boardNode?.id); setSelection({ shapeIds: boardNode ? [boardNode.id] : [], conceptIds: [node.id], boardRevision: session.board.revision ?? 0, capturedAt: new Date().toISOString() }); if (boardNode) adapter.current?.fitFrame(boardNode.frameId); }} onEvidence={ids => { setTab('conversation'); requestAnimationFrame(() => { const target = Array.from(document.querySelectorAll('[data-message-id]')).find(el => ids.includes(el.getAttribute('data-message-id') || '')); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); }} onCards={ids => { setTab('cards'); requestAnimationFrame(() => { const target = Array.from(document.querySelectorAll('[data-card-id]')).find(el => ids.includes(el.getAttribute('data-card-id') || '')); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); }}/>}
        {tab === 'cards' && <div className="flashcards-panel" role="tabpanel"><div className="panel-intro"><span className="eyebrow">MAKE THE IDEAS STICK</span><h3>A little recall goes a long way.</h3><p>Think of your answer, then flip the card.</p></div>{session.flashcards.map((card, index) => <button className={`flashcard ${flipped.has(card.id) ? 'is-flipped' : ''}`} key={card.id} data-card-id={card.id} onClick={() => setFlipped(previous => { const value = new Set(previous); if (value.has(card.id)) value.delete(card.id); else value.add(card.id); return value; })} aria-label={`${flipped.has(card.id) ? 'Answer' : 'Question'} ${index + 1}: ${flipped.has(card.id) ? card.back : card.front}. Click to flip.`}><span className="flashcard-top"><span>{flipped.has(card.id) ? 'THE ANSWER' : `QUESTION ${String(index + 1).padStart(2, '0')}`}</span><Sparkles size={15}/></span><p>{flipped.has(card.id) ? card.back : card.front}</p><span className="flashcard-bottom"><RotateCcw size={12}/>{flipped.has(card.id) ? 'See question' : 'Reveal answer'}</span></button>)}{!session.flashcards.length && <p className="panel-empty">Your review cards will appear as you learn.</p>}</div>}
      </aside>
    </main>
    {voice.connected && mobileTab === 'board' && <div className="mobile-voice-shortcut"><span>{voice.recording ? 'Microphone sending' : voice.state === 'speaking' ? 'Tutor speaking' : 'Voice on'}</span><button onClick={() => voice.runtime.interrupt()}>Stop tutor</button><button onClick={() => { setTab('conversation'); setMobileTab('study'); }}>Voice controls</button></div>}
    {error && <div className="workspace-error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
    <footer className="workspace-footer"><Link href="/" className="subtle-button"><ArrowLeft size={15}/><span>My learning space</span></Link><div className="footer-session-state"><span className={`state-dot ${ended ? 'ended' : ''}`}/>{ended ? 'Lesson complete. Curiosity continues.' : session.mode === 'sample' ? 'A guided sample · Type to explore' : 'Live AI lesson · Type to explore'}</div>{ended ? <button className="small-button" onClick={() => downloadSummary(session)}><Download size={14}/><span>Save your notes</span></button> : <button className="end-session-button" disabled={busy || !!draft} onClick={() => void end()}><Check size={15}/><span>{busy ? 'One moment…' : 'Finish lesson'}</span></button>}</footer>
  </div>;
}
function ArrowUpRightIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg>; }
