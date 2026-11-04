'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, ArrowUp, Check, Clock3, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { TOPICS, CreateLessonSchema, type Topic, type Session, type Capabilities, type Identity } from '@tokai/contracts';
import { api, errorText } from '@/lib/api';
import { AppNav } from './AppNav';
import { TopicArt } from './TopicArt';
import { VoiceOrb } from './VoiceOrb';
import { DictationInput } from './product/DictationInput';

const shortNames: Record<Topic, string> = { photosynthesis: 'Photosynthesis', fractions: 'Fractions', 'solar-system': 'The solar system', circuits: 'Circuits' };

export function Home() {
  const router = useRouter(); const [sessions, setSessions] = useState<Session[]>([]); const [capabilities, setCapabilities] = useState<Capabilities>({ tutor: false, speech: false, voice: false });
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState<Topic | string>(); const [mode, setMode] = useState<'sample' | 'live'>('sample');
  const [identity, setIdentity] = useState<Identity>(); const [question, setQuestion] = useState(''); const modeChosen = useRef(false);
  const choose = (value: 'sample' | 'live') => { modeChosen.current = true; setMode(value); };
  const load = useCallback(async () => { setLoading(true); setError(''); try { const [items, health] = await Promise.all([api.list(), api.health()]); setSessions(items); setCapabilities(health); if (!modeChosen.current && health.tutor) setMode('live'); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api.me().then(value => setIdentity(value.identity)).catch(() => undefined); }, []);
  async function start(topic: Topic) { setBusy(topic); setError(''); try { const session = await api.create(topic, mode); router.push(`/learn/${session.id}`); } catch (e) { setError(errorText(e)); setBusy(undefined); } }
  async function remove(session: Session) { if (!window.confirm(`Delete “${session.title}” and its saved notes?`)) return; setBusy(session.id); try { await api.remove(session.id); setSessions(items => items.filter(s => s.id !== session.id)); } catch (e) { setError(errorText(e)); } finally { setBusy(undefined); } }
  async function ask(value = question) {
    const topic = value.trim().slice(0, 160); if (topic.length < 2 || busy) return;
    if (!capabilities.tutor) { router.push(`/learn/new?topic=${encodeURIComponent(topic)}`); return; }
    setBusy('ask'); setError('');
    try {
      const me = await api.me();
      const session = await api.createLesson(CreateLessonSchema.parse({ topic, mode: 'live', goal: me.preferences.goal, sourceIds: [], grounding: 'general', preferences: me.preferences }));
      router.push(`/learn/${session.id}`);
    } catch (e) { setError(errorText(e)); setBusy(undefined); }
  }
  const current = sessions.find(session => session.status !== 'ended');
  return <div className="milli-home">
    <AppNav identity={identity}/>
    <main id="main" className="home-wrap">
      <section className="home-hero">
        <VoiceOrb state={busy === 'ask' ? 'thinking' : 'idle'}/>
        <h1>What do you want to learn?</h1>
        <p>{busy === 'ask' ? 'Planning your lesson…' : 'Talk it through with milli. See it click.'}</p>
        <form className="hero-ask" onSubmit={event => { event.preventDefault(); void ask(); }}>
          <label className="sr-only" htmlFor="hero-question">Topic or question</label>
          <input id="hero-question" value={question} maxLength={160} disabled={busy === 'ask'} onChange={event => setQuestion(event.target.value)} placeholder="Why is the sky blue?"/>
          <DictationInput idleLabel="Say it" disabled={busy === 'ask'} onTranscript={value => { setQuestion(value.slice(0, 160)); void ask(value); }}/>
          <button className="send-button" type="submit" aria-label="Start a lesson on this" disabled={question.trim().length < 2 || !!busy}><ArrowUp size={18}/></button>
        </form>
        {question.trim().length >= 2 && !busy && <Link className="text-button" href={`/learn/new?topic=${encodeURIComponent(question.trim().slice(0, 160))}`}>More options</Link>}
      </section>
      {error && <div className="error-banner" role="alert"><p>{error}</p><button onClick={() => void load()} className="pill-button"><RefreshCw size={15}/> Try again</button></div>}
      {current && <Link className="continue-card" href={`/learn/${current.id}`}><span className="continue-art">{current.topic in shortNames ? <TopicArt topic={current.topic as Topic}/> : <VoiceOrb state="idle" size="small"/>}</span><span className="continue-copy"><small>Continue</small><strong>{current.title}</strong></span><span className="chunky-button small">Resume<ArrowRight size={16}/></span></Link>}
      <section className="topic-section">
        <div className="section-row"><h2>Start a lesson</h2><div className="mode-switch" role="group" aria-label="Lesson mode"><button disabled={!capabilities.tutor} title={!capabilities.tutor ? 'Live AI isn’t configured' : 'Talk with the live AI tutor'} aria-pressed={mode === 'live'} onClick={() => choose('live')}><Sparkles size={13}/> Live AI</button><button aria-pressed={mode === 'sample'} title="Prepared lessons without AI or voice" onClick={() => choose('sample')}>Offline demo</button></div></div>
        <div className="topics-grid">{TOPICS.map(topic => <button key={topic.id} className={`topic-card topic-${topic.id}`} disabled={!!busy || loading} onClick={() => void start(topic.id)}><span className="topic-art-wrap"><TopicArt topic={topic.id}/></span><span className="topic-copy"><strong>{shortNames[topic.id]}</strong><span>{topic.title}</span><small><Clock3 size={12}/>{busy === topic.id ? 'Opening…' : topic.duration}{mode === 'sample' ? ' · demo' : ' · live'}</small></span></button>)}</div>
      </section>
      <section id="your-sessions" className="sessions-section">
        <div className="section-row"><h2>Your lessons</h2><div className="section-links"><Link className="text-button" href="/library">Sources</Link>{!!sessions.length && <Link className="text-button" href="/dashboard">Manage</Link>}</div></div>
        {loading ? <div className="empty-sessions loading-state"><span className="spinner"/> Loading…</div> : !sessions.length ? <div className="empty-sessions"><h3>No lessons yet</h3><p>Pick a topic above or just ask.</p></div> : <div className="session-list">{sessions.map(session => <article className="saved-session" key={session.id}><span className="session-dot" data-mode={session.mode}/><Link className="session-link" href={`/learn/${session.id}`}><h3>{session.title}</h3><p>{session.mode === 'sample' ? 'Sample' : 'Live AI'} · {new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p></Link><span className={`status-tag ${session.status}`}>{session.status === 'ended' ? <><Check size={12}/> Completed</> : 'In progress'}</span><button className="icon-button delete-session" aria-label={`Delete ${session.title}`} disabled={!!busy} onClick={() => void remove(session)}><Trash2 size={15}/></button></article>)}</div>}
      </section>
    </main>
  </div>;
}
