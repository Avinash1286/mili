'use client';

import { useEffect, useRef, useState } from 'react';
import type { Artifact } from '@tokai/contracts';
import { api, errorText } from '@/lib/api';
import { StatusMessage } from './ProductShell';
import styles from './Product.module.css';

export function RecapPlayer({ artifact }: { artifact: Artifact }) {
  const audio = useRef<HTMLAudioElement>(null), objectUrl = useRef<string | undefined>(undefined), epoch = useRef(0);
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [time, setTime] = useState(0), [speed, setSpeed] = useState(1);
  useEffect(() => () => { epoch.current++; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  async function load() { const current = ++epoch.current; setBusy(true); setError(''); try { const blob = await api.artifactDownload(artifact.id); if (current !== epoch.current) return; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = URL.createObjectURL(blob); setUrl(objectUrl.current); } catch (e) { if (current === epoch.current) setError(errorText(e)); } finally { if (current === epoch.current) setBusy(false); } }
  return <section className={styles.panel} aria-label="Lesson audio recap"><h2>A recap to return to.</h2><p className={styles.muted}>Generated audio recap{artifact.durationMs ? ` · ${Math.ceil(artifact.durationMs / 1000)} seconds` : ''}. Use the transcript below alongside the audio.</p>{error && <StatusMessage error>{error}</StatusMessage>}{!url ? <button className={styles.secondary} disabled={busy} onClick={() => void load()}>{busy ? 'Opening recap…' : 'Load audio recap'}</button> : <><audio ref={audio} className={styles.audio} controls src={url} onTimeUpdate={event => setTime(event.currentTarget.currentTime * 1000)} onLoadedMetadata={event => { event.currentTarget.playbackRate = speed; }} onError={() => setError('This audio could not be played. The text recap is still available.')}/><label className={styles.field}>Recap playback speed<select value={speed} onChange={event => { const value = Number(event.target.value); setSpeed(value); if (audio.current) audio.current.playbackRate = value; }}>{[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label></>}
    {!!artifact.captions?.length && <div style={{ marginTop: 20 }} role="group" aria-label="Recap captions">{artifact.captions.map((caption, index) => <span className={styles.caption} key={index} aria-current={time >= caption.startMs && time < caption.endMs ? 'true' : undefined}>{caption.text}</span>)}</div>}
  </section>;
}
