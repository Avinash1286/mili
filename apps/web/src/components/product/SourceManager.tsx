'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { Source } from '@tokai/contracts';
import { api, downloadBlob, errorText } from '@/lib/api';
import { fileExpired, useFileExpiry } from '@/lib/file-expiry';
import { EmptyState, StatusMessage } from './ProductShell';
import styles from './Product.module.css';

export function SourceManager({ selectedIds, onSelection, compact = false }: { selectedIds?: string[]; onSelection?: (ids: string[]) => void; compact?: boolean }) {
  const [sources, setSources] = useState<Source[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState<string>(), [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null), serial = useRef(0);
  const expiryNow = useFileExpiry(sources);
  const refresh = useCallback(async () => { const current = ++serial.current; try { const values = await api.sources(); if (current === serial.current) { setSources(values); setError(''); } } catch (e) { if (current === serial.current) setError(errorText(e)); } finally { if (current === serial.current) setLoading(false); } }, []);
  useEffect(() => { void refresh(); return () => { serial.current++; }; }, [refresh]);
  useEffect(() => { if (!sources.some(source => ['queued', 'processing'].includes(source.status))) return; const timer = setInterval(() => { void refresh(); }, 2500); return () => clearInterval(timer); }, [sources, refresh]);
  async function upload(value: File) { setBusy('upload'); setError(''); try { await api.uploadSource(value); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(undefined); if (file.current) file.current.value = ''; } }
  async function action(source: Source, kind: 'retry' | 'delete' | 'download') {
    if (kind === 'delete' && !window.confirm(`Delete “${source.title}” and its indexed content?`)) return;
    setBusy(source.id); setError('');
    try { if (kind === 'download') downloadBlob(await api.sourceDownload(source.id), source.filename); else { if (kind === 'delete') { await api.deleteSource(source.id); onSelection?.((selectedIds ?? []).filter(id => id !== source.id)); } else await api.retrySource(source.id); await refresh(); } }
    catch (e) { setError(errorText(e)); } finally { setBusy(undefined); }
  }
  return <section className={compact ? undefined : styles.panel} aria-label="Lesson sources">
    <h2>Your sources</h2><p className={styles.intro}>PDF, PNG, JPEG or text, up to 10 MB.</p>
    <div className={styles.actions}><button className={styles.secondary} type="button" disabled={!!busy} onClick={() => file.current?.click()}><Upload size={15}/>{busy === 'upload' ? 'Uploading…' : 'Upload a source'}</button><input ref={file} hidden tabIndex={-1} type="file" accept="application/pdf,image/png,image/jpeg,text/plain" disabled={!!busy} aria-label="Upload lesson source" onChange={event => { const selected = event.target.files?.[0]; if (selected) void upload(selected); }}/><button className={styles.secondary} type="button" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={15}/> Refresh sources</button></div>
    {error && <StatusMessage error>{error}</StatusMessage>}
    {loading ? <p className={styles.muted} role="status">Opening your source library…</p> : !sources.length ? <div style={{ marginTop: 18 }}><EmptyState title="A place for your references.">Your uploaded notes and readings will appear here.</EmptyState></div> : <ul className={styles.fileList}>{sources.map(source => <li key={source.id}><div className={styles.row}><div>{onSelection ? <label><input type="checkbox" checked={selectedIds?.includes(source.id) ?? false} disabled={source.status !== 'ready' || !selectedIds?.includes(source.id) && (selectedIds?.length ?? 0) >= 8} onChange={event => onSelection(event.target.checked ? [...(selectedIds ?? []), source.id] : (selectedIds ?? []).filter(id => id !== source.id))}/><strong>{source.title}</strong></label> : <strong><FileText size={14}/> {source.title}</strong>}<small>{source.filename} · {Math.ceil(source.bytes / 1024)} KB · {source.status}{source.pages !== undefined ? ` · ${source.pages} pages` : ''}</small>{source.fileExpiresAt && <p className={styles.muted}>{fileExpired(source, expiryNow) ? source.status === 'ready' ? 'The original file expired. Indexed text remains available for teaching until its retention period ends or you delete this source.' : 'The original file expired. Upload it again to process this source.' : <>Original file available until <time dateTime={source.fileExpiresAt}>{new Date(source.fileExpiresAt).toLocaleString()}</time>.</>}</p>}{source.error && <p>{source.error}</p>}</div><div className={styles.actions}>{source.status === 'failed' && !fileExpired(source, expiryNow) && <button className={styles.secondary} type="button" disabled={!!busy} onClick={() => void action(source, 'retry')}>Retry processing</button>}{source.status === 'ready' && <button className={styles.secondary} type="button" aria-label={`Download ${source.title}`} disabled={!!busy || fileExpired(source, expiryNow)} onClick={() => void action(source, 'download')}><Download size={15}/></button>}<button className={styles.danger} type="button" aria-label={`Delete source ${source.title}`} disabled={!!busy} onClick={() => void action(source, 'delete')}><Trash2 size={15}/></button></div></div></li>)}</ul>}
    {onSelection && <p className={styles.muted}>{selectedIds?.length ?? 0} of 8 sources selected. Uploaded text is reference material, never instructions for the application.</p>}
  </section>;
}
