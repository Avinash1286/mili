'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Session } from '@tokai/contracts';
import { api, errorText, type Me } from '@/lib/api';
import { EmptyState, ProductShell, StatusMessage } from './ProductShell';
import { SourceManager } from './SourceManager';
import styles from './Product.module.css';

export function LearningHome({ library = false }: { library?: boolean }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]), [me, setMe] = useState<Me>(), [due, setDue] = useState(0), [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('active'), [mode, setMode] = useState('all'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(''), [title, setTitle] = useState('');
  const load = useCallback(async () => { setError(''); try { const [items, identity, reviews] = await Promise.all([api.list(), api.me(), api.dueReviews()]); setSessions(items); setMe(identity); setDue(reviews.total); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function action(session: Session, kind: 'rename' | 'archive' | 'resume' | 'delete') {
    if (kind === 'delete' && !confirm(`Permanently delete “${session.title}” and its saved lesson data?`)) return;
    setBusy(session.id); setError(''); setNotice('');
    try {
      if (kind === 'delete') { await api.remove(session.id); setSessions(items => items.filter(item => item.id !== session.id)); setNotice('Lesson deleted.'); }
      else { const updated = kind === 'resume' ? await api.resume(session.id) : await api.editSession(session.id, kind === 'rename' ? { title: title.trim() } : { archived: !session.archived }); setSessions(items => items.map(item => item.id === session.id ? updated : item)); setEditing(''); if (kind === 'resume') router.push(`/learn/${session.id}`); else setNotice(kind === 'rename' ? 'Lesson renamed.' : updated.archived ? 'Lesson archived. You can restore it from the archive.' : 'Lesson restored.'); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  const visible = [...sessions].filter(session => (filter === 'all' || (filter === 'archived' ? !!session.archived : !session.archived && (filter === 'active' || session.status === (filter === 'active-only' ? 'active' : filter)))) && (mode === 'all' || session.mode === mode) && `${session.title} ${session.topic} ${session.notes || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <ProductShell title={library ? 'Library' : 'My learning'} identity={me?.identity}>
    {error && <StatusMessage error>{error} <button className={styles.secondary} onClick={() => void load()}>Try again</button></StatusMessage>}{notice && <StatusMessage>{notice}</StatusMessage>}
    {!library && <><div className={styles.metrics}><div className={styles.metric}><strong>{sessions.filter(item => !item.archived).length}</strong><span>Lessons in your space</span></div><div className={styles.metric}><strong>{sessions.filter(item => item.status === 'ended').length}</strong><span>Lessons brought to a close</span></div><Link href="/review" className={styles.metric}><strong>{due}</strong><span>Cards ready to revisit →</span></Link></div><section className={styles.panel}><h2>Learn something new</h2><p className={styles.intro}>Any topic, your own sources, your pace.</p><div className={styles.actions}><Link href="/learn/new" className={styles.primary}>Plan a new lesson</Link><Link href="/review" className={styles.secondary}>Review my cards</Link></div></section></>}
    <section className={styles.panel} aria-label="Lesson history"><h2>{library ? 'Saved lessons' : 'Your lessons'}</h2><div className={styles.fields} style={{ marginBottom: 20 }}><label className={`${styles.field} ${styles.wide}`}>Search your lessons<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title, topic, or notes"/></label><label className={styles.field}>Lesson status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="active">Unarchived lessons</option><option value="active-only">In progress</option><option value="ended">Ended lessons</option><option value="archived">Archived lessons</option><option value="all">All lessons</option></select></label><label className={styles.field}>Lesson mode<select value={mode} onChange={event => setMode(event.target.value)}><option value="all">All modes</option><option value="sample">Guided samples</option><option value="live">Live AI lessons</option></select></label></div>
      {loading ? <p role="status">Opening your learning space…</p> : !visible.length ? <EmptyState title="A little space for your next idea.">{sessions.length ? 'No lessons match these filters.' : 'Your lessons will appear here after you begin.'}</EmptyState> : <div className={styles.list}>{visible.map(session => <article className={styles.row} key={session.id}><div>{editing === session.id ? <form className={styles.form} onSubmit={event => { event.preventDefault(); void action(session, 'rename'); }}><label className={styles.field}>Lesson title<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={200}/></label><div className={styles.actions}><button className={styles.primary} disabled={!!busy || !title.trim()}>Save title</button><button type="button" className={styles.secondary} onClick={() => setEditing('')}>Cancel rename</button></div></form> : <><h3><Link href={`/sessions/${session.id}`}>{session.title}</Link></h3><p>{session.mode === 'sample' ? 'Guided sample · prepared content' : 'Live AI lesson'} · {new Date(session.updatedAt).toLocaleDateString()} · {session.archived ? 'Archived' : session.status === 'ended' ? 'Ended' : 'In progress'}</p></>}</div><div className={styles.actions}><button className={styles.primary} disabled={!!busy} onClick={() => void action(session, 'resume')}>Resume</button><Link className={styles.secondary} href={`/sessions/${session.id}`}>Study pack</Link><button className={styles.secondary} disabled={!!busy} onClick={() => { setEditing(session.id); setTitle(session.title); }}>Rename</button><button className={styles.secondary} disabled={!!busy} onClick={() => void action(session, 'archive')}>{session.archived ? 'Restore' : 'Archive'}</button><button className={styles.danger} disabled={!!busy} aria-label={`Delete ${session.title}`} onClick={() => void action(session, 'delete')}>Delete</button></div></article>)}</div>}
    </section>{library && <SourceManager/>}
  </ProductShell>;
}
