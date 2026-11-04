'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { CreateLessonSchema, LearnerPreferencesSchema, TOPICS, type LearnerPreferences, type Identity, type Capabilities } from '@tokai/contracts';
import { api, errorText } from '@/lib/api';
import { ProductShell, StatusMessage } from './ProductShell';
import { PreferenceFields } from './PreferenceFields';
import { SourceManager } from './SourceManager';
import { DeviceCheck } from './DeviceCheck';
import { DictationInput } from './DictationInput';
import styles from './Product.module.css';

export function NewLesson() {
  const router = useRouter(), [preferences, setPreferences] = useState<LearnerPreferences>(() => LearnerPreferencesSchema.parse({}));
  const [identity, setIdentity] = useState<Identity>(), [capabilities, setCapabilities] = useState<Capabilities>(), [topic, setTopic] = useState(''), [goal, setGoal] = useState(''), [mode, setMode] = useState<'sample' | 'live'>('live'), [sourceIds, setSourceIds] = useState<string[]>([]), [grounding, setGrounding] = useState<'general' | 'sources-only'>('general');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const goalEdited = useRef(false), editedPreferences = useRef(new Set<keyof LearnerPreferences>());
  useEffect(() => { const value = new URLSearchParams(window.location.search).get('topic')?.trim(); if (value) setTopic(value.slice(0, 160)); }, []);
  function editPreferences(next: LearnerPreferences) {
    for (const key of Object.keys(next) as (keyof LearnerPreferences)[]) if (next[key] !== preferences[key]) editedPreferences.current.add(key);
    setPreferences(next);
  }
  useEffect(() => { let active = true; void Promise.all([api.me(), api.health()]).then(([me, health]) => { if (active) {
    setIdentity(me.identity);
    setPreferences(current => ({ ...me.preferences, ...Object.fromEntries([...editedPreferences.current].map(key => [key, current[key]])) }));
    if (!goalEdited.current) setGoal(me.preferences.goal);
    setCapabilities(health);
  } }).catch(e => { if (active) setError(errorText(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function submit() {
    const parsed = CreateLessonSchema.safeParse({ topic, mode, goal, sourceIds: mode === 'live' ? sourceIds : [], grounding: mode === 'live' ? grounding : 'general', preferences: mode === 'sample' ? { ...preferences, language: 'english' } : preferences });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'Lesson'}: ${issue.message}`).join(' ')); return; }
    if (grounding === 'sources-only' && mode === 'live' && !sourceIds.length) { setError('Choose at least one ready source for a source-only lesson.'); return; }
    setBusy(true); setError(''); try { const session = await api.createLesson(parsed.data); router.push(`/learn/${session.id}`); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <ProductShell title="New lesson" identity={identity}>
    {error && <StatusMessage error>{error}</StatusMessage>}
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <section className={styles.panel}><div className={styles.stepHead}><span className={styles.step}>1</span><h2>What do you want to learn?</h2><div className={styles.tabs} role="group" aria-label="Lesson mode"><button type="button" aria-pressed={mode === 'live'} onClick={() => { setMode('live'); setTopic(''); }}>Live AI</button><button type="button" aria-pressed={mode === 'sample'} onClick={() => { setMode('sample'); setTopic('photosynthesis'); }}>Guided sample</button></div></div><p className={styles.intro}>{mode === 'sample' ? 'Prepared responses, not live AI.' : 'Live AI can make mistakes. Add sources when accuracy matters.'}</p><div className={styles.fields}>
        {mode === 'sample' ? <label className={`${styles.field} ${styles.wide}`}>Sample topic<select value={topic} disabled={busy} onChange={event => setTopic(event.target.value)}>{TOPICS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : <div className={`${styles.wide} ${styles.topicRow}`}><label className={styles.field}>Topic or question<input required minLength={2} maxLength={160} value={topic} disabled={busy} onChange={event => setTopic(event.target.value)} placeholder="Why do seasons change?"/></label><DictationInput idleLabel="Say it" disabled={busy} onTranscript={value => setTopic(value.slice(0, 160))}/></div>}
        <label className={`${styles.field} ${styles.wide}`}>Your learning goal<textarea value={goal} maxLength={500} disabled={busy} onChange={event => { goalEdited.current = true; setGoal(event.target.value); }} placeholder="By the end, I want to…"/></label>
      </div></section>
      <section className={styles.panel}><div className={styles.stepHead}><span className={styles.step}>2</span><h2>How should milli teach?</h2></div><PreferenceFields value={mode === 'sample' ? { ...preferences, language: 'english' } : preferences} onChange={editPreferences} disabled={busy || loading} languageLocked={mode === 'sample'}/>{mode === 'sample' && <p className={styles.muted} style={{ marginTop: 12 }}>Samples are English only.</p>}</section>
      {mode === 'live' && <section className={styles.panel}><div className={styles.stepHead}><span className={styles.step}>3</span><h2>Add sources <span className={styles.optional}>optional</span></h2></div><SourceManager compact selectedIds={sourceIds} onSelection={setSourceIds}/><label className={styles.field}>How should the tutor use sources?<select value={grounding} onChange={event => setGrounding(event.target.value as typeof grounding)}><option value="general">General knowledge, with sources labeled</option><option value="sources-only">Only my selected sources</option></select></label></section>}
      <section className={styles.panel}><div className={styles.stepHead}><span className={styles.step}>{mode === 'live' ? 4 : 3}</span><h2>Before you start</h2></div><div className={styles.checks}><label className={styles.check}><input type="checkbox" checked={preferences.retainTranscript} onChange={event => editPreferences({ ...preferences, retainTranscript: event.target.checked })}/> Keep this lesson’s transcript for later study</label><label className={styles.check}><input type="checkbox" checked={preferences.retainRecapAudio} onChange={event => editPreferences({ ...preferences, retainRecapAudio: event.target.checked })}/> Allow saved recap audio when I request it</label></div><DeviceCheck/></section>
      {mode === 'live' && capabilities && !capabilities.tutor && <StatusMessage>Live AI isn’t configured yet. Try a guided sample.</StatusMessage>}
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy || loading || mode === 'live' && !capabilities?.tutor}>{busy ? 'Opening your lesson…' : 'Start my lesson'}<ArrowRight size={17}/></button>{loading && <span className={styles.muted}>Loading your preferences…</span>}</div>
    </form>
  </ProductShell>;
}
