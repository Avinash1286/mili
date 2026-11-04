'use client';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { TUTOR_VOICES, type LearnerPreferences } from '@tokai/contracts';
import { api, errorText } from '@/lib/api';
import styles from './Product.module.css';

export function VoicePicker({ value, language, onChange, disabled = false }: { value: LearnerPreferences['voiceId']; language: LearnerPreferences['language']; onChange: (voiceId: LearnerPreferences['voiceId']) => void; disabled?: boolean }) {
  const [playing, setPlaying] = useState<string>(), [loadingId, setLoadingId] = useState<string>(), [message, setMessage] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null), url = useRef<string | null>(null), request = useRef(0);
  const native = TUTOR_VOICES.filter(voice => voice.language === language);
  const voices = language === 'english' ? native : [...native, ...TUTOR_VOICES.filter(voice => voice.language === 'english').slice(0, 3)];
  function stop() { request.current++; audio.current?.pause(); audio.current = null; if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPlaying(undefined); setLoadingId(undefined); }
  useEffect(() => stop, []);
  async function preview(id: string) {
    if (playing === id || loadingId === id) { stop(); return; }
    stop(); const current = ++request.current; setLoadingId(id); setMessage('');
    try {
      const blob = await api.voicePreview(id); if (current !== request.current) return;
      url.current = URL.createObjectURL(blob); const sound = new Audio(url.current); audio.current = sound;
      sound.onended = stop; setPlaying(id); setLoadingId(undefined); await sound.play();
    } catch (error) { if (current === request.current) { stop(); setMessage(errorText(error)); } }
  }
  return <fieldset className={`${styles.wide} ${styles.voicePicker}`} disabled={disabled}>
    <legend>milli’s voice</legend>
    <div className={styles.voiceGrid} role="radiogroup" aria-label="Tutor voice">{voices.map(voice => <div key={voice.id} className={styles.voiceCard} data-selected={value === voice.id}>
      <label><input type="radio" name="tutor-voice" value={voice.id} checked={value === voice.id} onChange={() => onChange(voice.id)}/><strong>{voice.name}</strong><small>{voice.description}</small></label>
      <button type="button" className={styles.voicePlay} aria-label={`${playing === voice.id ? 'Stop' : 'Preview'} ${voice.name}`} aria-busy={loadingId === voice.id} onClick={() => void preview(voice.id)}>{playing === voice.id ? <Pause size={14}/> : <Play size={14}/>}</button>
    </div>)}</div>
    {message && <p className={styles.muted} role="status">{message}</p>}
  </fieldset>;
}
