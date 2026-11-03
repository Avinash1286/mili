'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Artifact, Session } from '@tokai/contracts';
import { api, downloadBlob, errorText, type LearningState } from '@/lib/api';
import { ProductShell, StatusMessage } from './ProductShell';
import { StudyPackContent } from './StudyPackContent';
import { PracticePanel } from './PracticePanel';
import { CardManager } from './CardManager';
import { ShareManager } from './ShareManager';
import { RecapPlayer } from './RecapPlayer';
import styles from './Product.module.css';

export function SessionPage({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [session, setSession] = useState<Session>(), [learning, setLearning] = useState<LearningState>(), [notes, setNotes] = useState(''), [notesRevision, setNotesRevision] = useState(0), [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('pack'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [format, setFormat] = useState<'markdown' | 'pdf' | 'csv' | 'json'>('markdown');
  const refresh = useCallback(async () => { try { setLearning(await api.learning(sessionId)); } catch (e) { setError(errorText(e)); } }, [sessionId]);
  useEffect(() => { let live = true; void Promise.all([api.session(sessionId), api.learning(sessionId)]).then(([value, materials]) => { if (!live) return; setSession(value); setNotes(value.notes || ''); setNotesRevision(value.revision); setLearning(materials); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [sessionId]);
  useEffect(() => { if (tab === 'practice' || !learning?.artifacts.some(item => ['queued', 'running'].includes(item.status))) return; const timer = setInterval(() => { void refresh(); }, 2500); return () => clearInterval(timer); }, [learning, refresh, tab]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  async function run(id: string, operation: () => Promise<void>) { setBusy(id); setError(''); setNotice(''); try { await operation(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); } }
  async function saveNotes() { await run('notes', async () => { const updated = await api.notes(sessionId, notes, notesRevision); setSession(updated); setNotesRevision(updated.revision); setDirty(false); setNotice('Your notes are saved. Regenerate the study pack to include the latest version.'); }); }
  async function reloadNotes() { if (dirty && !confirm('Replace your unsaved note draft with the saved notes?')) return; await run('notes', async () => { const updated = await api.session(sessionId); setSession(updated); setNotes(updated.notes || ''); setNotesRevision(updated.revision); setDirty(false); }); }
  async function saveRecapConsent(retainRecapAudio: boolean) {
    if (!session) return;
    await run('privacy', async () => {
      const updated = await api.lessonPrivacy(sessionId, { revision: session.revision, retainRecapAudio });
      setSession(updated); setNotesRevision(current => current === session.revision ? updated.revision : current);
      await refresh();
      setNotice(retainRecapAudio ? 'Saved recap audio is allowed for this lesson. You can request a recap when you are ready.' : 'Saved recap audio is disabled for this lesson. Existing saved recap audio has been removed.');
    });
  }
  async function reloadPrivacy() { await run('privacy', async () => { const updated = await api.session(sessionId); setSession(updated); if (!dirty) { setNotes(updated.notes || ''); setNotesRevision(updated.revision); } await refresh(); setNotice(dirty ? 'Lesson privacy refreshed. Your unsaved notes were kept.' : 'Lesson privacy refreshed.'); }); }
  async function generate(kind: 'study-pack' | 'recap' | 'cards' | 'export') { await run(kind, async () => { await api.createArtifact(sessionId, kind, kind === 'export' ? format : undefined); await refresh(); setNotice(`${kind === 'study-pack' ? 'Study pack' : kind === 'recap' ? 'Audio recap' : kind === 'cards' ? 'Review cards' : 'Export'} requested. Status updates here while you continue learning.`); }); }
  const allowRecap = session?.settings?.preferences.retainRecapAudio ?? false;
  const readyRecap = learning?.artifacts.filter(item => item.kind === 'recap' && item.status === 'ready').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return <ProductShell title={session?.title || 'Your lesson.'} eyebrow="A PLACE TO RETURN TO" description={session ? `${session.mode === 'sample' ? 'Guided sample · prepared content' : 'Live AI lesson'} · ${session.status === 'ended' ? 'Ended' : 'In progress'}` : 'Opening your saved lesson…'} actions={session && <button className={styles.primary} disabled={!!busy} onClick={() => void run('resume', async () => { await api.resume(sessionId); router.push(`/learn/${sessionId}`); })}>Resume lesson</button>}>
    {error && <StatusMessage error>{error}</StatusMessage>}{notice && <StatusMessage>{notice}</StatusMessage>}
    <div className={styles.tabs} aria-label="Lesson materials">{[['pack', 'Study pack'], ['notes', 'My notes'], ['practice', 'Practice'], ['cards', 'Review cards'], ['share', 'Share']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {!session || !learning ? <p role="status">Opening your lesson materials…</p> : <>
      {tab === 'pack' && <><section className={styles.panel}><h2>Bring it all together.</h2><p className={styles.intro}>Prepare a study pack from this saved lesson. Audio recaps use completed narration; interrupted segments stay separate.</p><div className={styles.checks}><label className={styles.check}><input type="checkbox" checked={allowRecap} disabled={!!busy} onChange={event => void saveRecapConsent(event.target.checked)}/> Allow saved recap audio for this lesson</label><p className={styles.muted}>{allowRecap ? 'Turning this off deletes saved recap audio for this lesson.' : 'Enable the checkbox to save and generate an audio recap for this lesson.'}</p><div><button className={styles.secondary} type="button" disabled={!!busy} onClick={() => void reloadPrivacy()}>Reload lesson privacy</button></div></div><div className={styles.actions}><button className={styles.primary} disabled={!!busy || learning.artifacts.some(item => item.kind === 'study-pack' && ['queued', 'running'].includes(item.status))} onClick={() => void generate('study-pack')}>{learning.studyPack ? 'Regenerate study pack' : 'Generate study pack'}</button><button className={styles.secondary} disabled={!!busy || !allowRecap || learning.artifacts.some(item => item.kind === 'recap' && ['queued', 'running'].includes(item.status))} onClick={() => void generate('recap')}>Generate audio recap</button><button className={styles.secondary} disabled={!!busy || learning.artifacts.some(item => item.kind === 'cards' && ['queued', 'running'].includes(item.status))} onClick={() => void generate('cards')}>Generate review cards</button></div><div className={styles.fields} style={{ marginTop: 22 }}><label className={styles.field}>Export format<select value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="markdown">Study pack · Markdown</option><option value="pdf">Study pack · PDF</option><option value="json">Study pack · JSON</option><option value="csv">Review cards · CSV</option></select></label><div className={styles.actions}><button className={styles.secondary} disabled={!!busy} onClick={() => void generate('export')}>Prepare download</button></div></div>
        <ArtifactList artifacts={learning.artifacts} busy={!!busy} allowRecap={allowRecap} onRetry={artifact => void run(artifact.id, async () => { await api.retryArtifact(artifact.id); await refresh(); })} onDownload={artifact => void run(artifact.id, async () => { downloadBlob(await api.artifactDownload(artifact.id), `tokai-${artifact.kind}.${artifact.format === 'markdown' ? 'md' : artifact.format || 'json'}`); })}/>
      </section>{allowRecap && readyRecap && <RecapPlayer key={readyRecap.id} artifact={readyRecap}/ >}{learning.studyPack ? <StudyPackContent pack={learning.studyPack}/> : <StatusMessage>Your study pack will appear here once it is ready. You can keep notes and practice in the meantime.</StatusMessage>}</>}
      {tab === 'notes' && <section className={styles.panel}><h2>Your own words.</h2><p className={styles.intro}>Notes are private unless you explicitly include them in a shared pack.</p><form className={styles.form} onSubmit={event => { event.preventDefault(); void saveNotes(); }}><label className={styles.field}>Lesson notes<textarea value={notes} maxLength={20000} rows={12} onChange={event => { setNotes(event.target.value); setDirty(true); }}/><small>{notes.length.toLocaleString()} / 20,000 characters{dirty ? ' · Unsaved changes' : ''}</small></label><div className={styles.actions}><button className={styles.primary} disabled={!!busy || !dirty}>Save notes</button><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void reloadNotes()}>Reload saved notes</button></div></form></section>}
      {tab === 'practice' && <PracticePanel sessionId={sessionId} onUpdated={() => void refresh()}/>}
      {tab === 'cards' && <><div className={styles.actions} style={{ marginBottom: 22 }}><Link className={styles.primary} href="/review">Review due cards</Link><button className={styles.secondary} disabled={!!busy} onClick={() => void generate('cards')}>Generate review cards</button></div><CardManager cards={learning.cards} onUpdated={() => void refresh()}/></>}
      {tab === 'share' && <ShareManager sessionId={sessionId} ready={!!learning.studyPack}/>}
    </>}
  </ProductShell>;
}

function ArtifactList({ artifacts, busy, allowRecap, onRetry, onDownload }: { artifacts: Artifact[]; busy: boolean; allowRecap: boolean; onRetry: (artifact: Artifact) => void; onDownload: (artifact: Artifact) => void }) {
  return <ul className={styles.fileList} aria-label="Generated material status">{[...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(artifact => <li key={artifact.id}><strong>{artifact.kind.replaceAll('-', ' ')}{artifact.format ? ` · ${artifact.format}` : ''}</strong> <span className={styles.badge}>{artifact.status}</span><small>{new Date(artifact.updatedAt).toLocaleString()}{artifact.error ? ` · ${artifact.error}` : ''}</small><div className={styles.actions}>{artifact.status === 'failed' && <button className={styles.secondary} disabled={busy || artifact.kind === 'recap' && !allowRecap} onClick={() => onRetry(artifact)}>Retry {artifact.kind.replaceAll('-', ' ')}</button>}{artifact.status === 'ready' && (artifact.kind === 'export' || artifact.kind === 'recap' && allowRecap) && <button className={styles.secondary} disabled={busy} onClick={() => onDownload(artifact)}>Download {artifact.format || artifact.kind}</button>}</div></li>)}</ul>;
}
