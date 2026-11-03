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
import styles from './Product.module.css';

export function NewLesson() {
  const router = useRouter(), [preferences, setPreferences] = useState<LearnerPreferences>(() => LearnerPreferencesSchema.parse({}));
  const [identity, setIdentity] = useState<Identity>(), [capabilities, setCapabilities] = useState<Capabilities>(), [topic, setTopic] = useState(''), [goal, setGoal] = useState(''), [mode, setMode] = useState<'sample' | 'live'>('live'), [sourceIds, setSourceIds] = useState<string[]>([]), [grounding, setGrounding] = useState<'general' | 'sources-only'>('general');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const goalEdited = useRef(false), editedPreferences = useRef(new Set<keyof LearnerPreferences>());
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
  return <ProductShell title="Follow a little curiosity." eyebrow="A LESSON THAT STARTS WITH YOU" description="Choose a question, set your pace, and bring a reference if you have one." identity={identity}>
    {error && <StatusMessage error>{error}</StatusMessage>}
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <section className={styles.panel}><h2>What would you like to understand?</h2><div className={styles.tabs} aria-label="Lesson mode"><button type="button" aria-pressed={mode === 'live'} onClick={() => { setMode('live'); setTopic(''); }}>Live AI</button><button type="button" aria-pressed={mode === 'sample'} onClick={() => { setMode('sample'); setTopic('photosynthesis'); }}>Guided sample</button></div><p className={styles.intro}>{mode === 'sample' ? 'Prepared lessons help you explore the workspace. Their responses are authored examples, not live AI.' : 'Your AI tutor can make mistakes. Check important claims and use sources when accuracy matters.'}</p><div className={styles.fields}>
        {mode === 'sample' ? <label className={`${styles.field} ${styles.wide}`}>Sample topic<select value={topic} disabled={busy} onChange={event => setTopic(event.target.value)}>{TOPICS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label> : <label className={`${styles.field} ${styles.wide}`}>Topic or question<input required minLength={2} maxLength={160} value={topic} disabled={busy} onChange={event => setTopic(event.target.value)} placeholder="Why do seasons change?"/></label>}
        <label className={`${styles.field} ${styles.wide}`}>Your learning goal<textarea value={goal} maxLength={500} disabled={busy} onChange={event => { goalEdited.current = true; setGoal(event.target.value); }} placeholder="By the end, I would like to be able to…"/></label>
      </div></section>
      <section className={styles.panel}><h2>A pace that feels right.</h2><PreferenceFields value={mode === 'sample' ? { ...preferences, language: 'english' } : preferences} onChange={editPreferences} disabled={busy || loading} languageLocked={mode === 'sample'}/><p className={styles.muted} style={{ marginTop: 15 }}>{mode === 'sample' ? 'Prepared sample content is available in English only. Choose Live AI for a lesson in another language; sample explanations do not adapt to language or style preferences.' : 'You can always ask for a shorter explanation, another example, or a slower pace.'}</p></section>
      {mode === 'live' && <section className={styles.panel}><SourceManager compact selectedIds={sourceIds} onSelection={setSourceIds}/><label className={styles.field}>How should the tutor use sources?<select value={grounding} onChange={event => setGrounding(event.target.value as typeof grounding)}><option value="general">Allow general knowledge with clearly labeled source support</option><option value="sources-only">Answer only from my selected sources</option></select><small>Source-only answers should say when support is missing.</small></label></section>}
      <section className={styles.panel}><h2>Keep what helps you.</h2><div className={styles.checks}><label className={styles.check}><input type="checkbox" checked={preferences.retainTranscript} onChange={event => editPreferences({ ...preferences, retainTranscript: event.target.checked })}/> Keep this lesson’s transcript for later study</label><label className={styles.check}><input type="checkbox" checked={preferences.retainRecapAudio} onChange={event => editPreferences({ ...preferences, retainRecapAudio: event.target.checked })}/> Allow saved recap audio when I request it</label></div><p className={styles.muted}>Raw microphone recordings are not saved as lesson artifacts. Voice transcription and tutoring use the configured providers when you choose those features.</p></section>
      <DeviceCheck/>
      {mode === 'live' && capabilities && !capabilities.tutor && <StatusMessage>Live tutoring is not configured. A guided sample is available while it is being connected.</StatusMessage>}
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy || loading || mode === 'live' && !capabilities?.tutor}>{busy ? 'Opening your lesson…' : 'Start my lesson'}<ArrowRight size={17}/></button><span className={styles.muted}>{loading ? 'Loading your preferences…' : 'You can use text from the first question.'}</span></div>
    </form>
  </ProductShell>;
}
