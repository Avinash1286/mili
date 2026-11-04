'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, ArrowUp, RefreshCw, Sparkles } from 'lucide-react';
import { TOPICS, StartCourseSessionSchema, type Topic, type Session, type Capabilities, type Identity } from '@milli/contracts';
import { api, errorText } from '@/lib/api';
import { unlockLessonAudio } from '@/lib/lesson-audio';
import { AppNav } from './AppNav';
import { TopicArt } from './TopicArt';
import { MilliMascot } from './course/MilliMascot';
import { DictationInput } from './product/DictationInput';

const shortNames: Record<Topic, string> = { photosynthesis: 'Photosynthesis', fractions: 'Fractions', 'solar-system': 'The solar system', circuits: 'Circuits' };
const featuredActivities: Record<Topic, string> = {
  photosynthesis: 'Follow the bubbles and see what limits a leaf’s growth.',
  fractions: 'Shade the bars and see why different fractions can be equal.',
  'solar-system': 'Find a repeating pattern, then compare the lengths of planetary years.',
  circuits: 'Predict what a switch does, then tune a circuit on a live graph.',
};

export function Home() {
  const router = useRouter(); const [sessions, setSessions] = useState<Session[]>([]); const [capabilities, setCapabilities] = useState<Capabilities>({ tutor: false, speech: false, voice: false });
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState<Topic | string>(); const [mode, setMode] = useState<'sample' | 'live'>('sample');
  const [identity, setIdentity] = useState<Identity>(); const [question, setQuestion] = useState(''); const modeChosen = useRef(false);
  const choose = (value: 'sample' | 'live') => { modeChosen.current = true; setMode(value); };
  const load = useCallback(async () => { setLoading(true); setError(''); try { const [items, health] = await Promise.all([api.list(), api.health()]); setSessions(items); setCapabilities(health); if (!modeChosen.current && health.tutor) setMode('live'); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void api.me().then(value => setIdentity(value.identity)).catch(() => undefined); }, []);
  async function start(topic: Topic) {
    unlockLessonAudio();
    setBusy(topic);
    setError('');
    try {
      const session = await api.startCourse(StartCourseSessionSchema.parse({ topic, mode, featured: true }));
      router.push(`/learn/${session.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(undefined);
    }
  }
  async function ask(value = question) {
    const topic = value.trim().slice(0, 160); if (topic.length < 2 || busy) return;
    unlockLessonAudio();
    if (!capabilities.tutor) { setError('Live topic creation is unavailable right now. Choose one of the prepared lessons below, or try again when Live AI is available.'); return; }
    setBusy('ask'); setError('');
    try {
      const me = await api.me();
      const session = await api.startCourse(StartCourseSessionSchema.parse({ topic, mode: 'live', goal: me.preferences.goal, sourceIds: [], grounding: 'general', preferences: me.preferences }));
      router.push(`/learn/${session.id}`);
    } catch (e) { setError(errorText(e)); setBusy(undefined); }
  }
  const current = sessions.find(session => session.status !== 'ended');
  return <div className="milli-home">
    <AppNav identity={identity}/>
    <main id="main" className="home-wrap">
      <section className="home-hero">
        <MilliMascot mood={busy === 'ask' ? 'thinking' : 'happy'} label="milli interactive tutor"/>
        <h1>What do you want to learn?</h1>
        <p>{busy === 'ask' ? 'Opening your live tutor…' : 'Talk it through with milli. See it click.'}</p>
        <form className="hero-ask" onSubmit={event => { event.preventDefault(); void ask(); }}>
          <label className="sr-only" htmlFor="hero-question">Topic or question</label>
          <input id="hero-question" value={question} maxLength={160} disabled={busy === 'ask'} onChange={event => setQuestion(event.target.value)} placeholder="Why is the sky blue?"/>
          <DictationInput idleLabel="Say it" disabled={busy === 'ask'} onTranscript={value => { setQuestion(value.slice(0, 160)); void ask(value); }}/>
          <button className="send-button" type="submit" aria-label="Start a lesson on this" disabled={question.trim().length < 2 || !!busy}><ArrowUp size={18}/></button>
        </form>
      </section>
      {error && <div className="error-banner" role="alert"><p>{error}</p><button onClick={() => void load()} className="pill-button"><RefreshCw size={15}/> Try again</button></div>}
      {current && <Link className="continue-card" href={`/learn/${current.id}`}><span className="continue-art">{current.topic in shortNames ? <TopicArt topic={current.topic as Topic}/> : <MilliMascot mood="idle"/>}</span><span className="continue-copy"><small>Continue</small><strong>{current.title}</strong></span><span className="chunky-button small">Resume<ArrowRight size={16}/></span></Link>}
      <section className="topic-section">
        <div className="section-row"><h2>Start a lesson</h2><div className="mode-switch" role="group" aria-label="Lesson mode"><button disabled={!capabilities.tutor} title={!capabilities.tutor ? 'Live AI isn’t configured' : 'Talk with the live AI tutor'} aria-pressed={mode === 'live'} onClick={() => choose('live')}><Sparkles size={13}/> Live AI</button><button aria-pressed={mode === 'sample'} title="Prepared lessons without AI or voice" onClick={() => choose('sample')}>Offline demo</button></div></div>
        <p className="featured-intro">Try Circuits first and adjust a graph yourself. Live AI adds tutor feedback to each prepared lesson{capabilities.speech ? ', with questions you can answer aloud' : ''}.</p>
        <div className="topics-grid">{TOPICS.map(topic => <button key={topic.id} className={`topic-card topic-${topic.id}`} disabled={!!busy || loading} onClick={() => void start(topic.id)}><span className="topic-art-wrap"><TopicArt topic={topic.id}/></span><span className="topic-copy"><strong>{shortNames[topic.id]}</strong><span>{featuredActivities[topic.id]}</span><small>{busy === topic.id ? 'Opening…' : mode === 'sample' ? 'Offline practice' : 'Live tutor'}</small></span></button>)}</div>
      </section>
      {!loading && sessions.length > 0 && <div className="home-courses-link"><Link className="text-button" href="/courses">See all {sessions.length} course{sessions.length === 1 ? '' : 's'} <ArrowRight size={15}/></Link></div>}
    </main>
  </div>;
}
