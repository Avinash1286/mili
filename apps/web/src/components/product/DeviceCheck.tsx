'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Mic, Volume2 } from 'lucide-react';
import styles from './Product.module.css';

export function DeviceCheck() {
  const [pending, setPending] = useState<string>(), [message, setMessage] = useState('Text and keyboard controls work without a microphone or camera.');
  const generation = useRef(0), audio = useRef<AudioContext | undefined>(undefined);
  useEffect(() => () => { generation.current++; void audio.current?.close().catch(() => undefined); }, []);
  function cancel() { generation.current++; void audio.current?.close().catch(() => undefined); audio.current = undefined; setPending(undefined); setMessage('Device check cancelled. Any camera or microphone granted afterward will be stopped.'); }
  async function capture(kind: 'microphone' | 'camera') {
    const current = ++generation.current; setPending(kind); setMessage(`Waiting for ${kind} permission…`);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser needs localhost or HTTPS for device access.');
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'camera' ? { video: true, audio: false } : { audio: true, video: false });
      stream.getTracks().forEach(track => track.stop());
      if (current === generation.current) setMessage(`${kind === 'camera' ? 'Camera' : 'Microphone'} access works. The device has been stopped; this check did not record or upload anything.`);
    } catch (error) {
      if (current === generation.current) setMessage(error instanceof DOMException && error.name === 'NotAllowedError' ? `${kind === 'camera' ? 'Camera' : 'Microphone'} permission was denied. You can continue with text and keyboard controls.` : `We could not open the ${kind}. Check its connection, or continue without it.`);
    } finally { if (current === generation.current) setPending(undefined); }
  }
  async function tone() {
    const current = ++generation.current; setPending('sound');
    try {
      const context = new AudioContext(); audio.current = context; await context.resume();
      if (current !== generation.current) { await context.close(); return; }
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 440; gain.gain.value = .035; oscillator.connect(gain).connect(context.destination);
      oscillator.onended = () => { void context.close().catch(() => undefined); if (audio.current === context) audio.current = undefined; };
      oscillator.start(); oscillator.stop(context.currentTime + .25);
      setMessage('A short test tone was sent to your output device. Adjust your volume if you did not hear it.');
    } catch { if (current === generation.current) setMessage('Audio output could not start. Text remains available; check your browser sound settings.'); }
    finally { if (current === generation.current) setPending(undefined); }
  }
  return <section className={styles.panel} aria-labelledby="device-check-title"><h2 id="device-check-title">Make yourself comfortable.</h2><p className={styles.intro}>These optional checks request device access only when selected. You can start a lesson without them.</p><div className={styles.actions}><button className={styles.secondary} type="button" disabled={!!pending} onClick={() => void capture('microphone')}><Mic size={16}/> Check microphone</button><button className={styles.secondary} type="button" disabled={!!pending} onClick={() => void capture('camera')}><Camera size={16}/> Check camera</button><button className={styles.secondary} type="button" disabled={!!pending} onClick={() => void tone()}><Volume2 size={16}/> Play test sound</button>{pending && <button className={styles.secondary} type="button" onClick={cancel}>Cancel device check</button>}</div><p className={styles.intro} style={{ marginTop: 15, marginBottom: 0 }} role="status">{message}</p></section>;
}
