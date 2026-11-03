'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import { api, errorText } from '@/lib/api';
import styles from './Product.module.css';

/** Captures at most 30 seconds locally, then sends bounded 16 kHz PCM on Stop. */
export function DictationInput({ onTranscript, disabled = false }: { onTranscript: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'permission' | 'recording' | 'transcribing'>('idle'), [message, setMessage] = useState(''), [seconds, setSeconds] = useState(0);
  const epoch = useRef(0), stream = useRef<MediaStream | undefined>(undefined), context = useRef<AudioContext | undefined>(undefined), processor = useRef<AudioWorkletNode | undefined>(undefined), source = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const packets = useRef<Int16Array[]>([]), samples = useRef(0), closing = useRef(false), recording = useRef(false), request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), clock = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const callback = useRef(onTranscript); callback.current = onTranscript;
  const cleanup = useCallback(() => {
    clearTimeout(timer.current); clearTimeout(flushTimer.current); clearInterval(clock.current);
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined;
    source.current?.disconnect(); source.current = undefined;
    if (processor.current) { processor.current.port.onmessage = null; processor.current.port.close(); processor.current.disconnect(); processor.current = undefined; }
    void context.current?.close().catch(() => undefined); context.current = undefined; recording.current = false;
  }, []);
  const cancel = useCallback(() => { epoch.current++; request.current?.abort(); cleanup(); packets.current = []; samples.current = 0; closing.current = false; setState('idle'); setMessage('Dictation cancelled. The recording was discarded.'); }, [cleanup]);
  useEffect(() => () => { epoch.current++; request.current?.abort(); cleanup(); packets.current = []; }, [cleanup]);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);
  async function finish(current: number) {
    if (current !== epoch.current || closing.current) return;
    closing.current = true; cleanup();
    const chunks = packets.current; packets.current = []; const count = samples.current; samples.current = 0;
    if (!count) { setState('idle'); setMessage('No audio was captured. Try again or type your answer.'); closing.current = false; return; }
    setState('transcribing'); setMessage('Transcribing your recording…');
    const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer); let offset = 0;
    for (const chunk of chunks) for (const sample of chunk) { if (offset >= count) break; view.setInt16(offset++ * 2, sample, true); }
    let binary = ''; for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    const controller = new AbortController(); request.current = controller; const deadline = setTimeout(() => controller.abort(), 48000);
    try { const text = await api.dictation(btoa(binary), controller.signal); if (current === epoch.current) { callback.current(text); setMessage('Transcript added. Check it before submitting your answer.'); } }
    catch (error) { if (current === epoch.current) setMessage(controller.signal.aborted ? 'Transcription took too long. Your typed answer is still here; you can retry.' : errorText(error)); }
    finally { clearTimeout(deadline); if (current === epoch.current) { closing.current = false; setState('idle'); request.current = undefined; } }
  }
  function stop(current = epoch.current) {
    if (current !== epoch.current || !recording.current) return;
    recording.current = false; clearTimeout(timer.current); clearInterval(clock.current);
    // Release the physical microphone before waiting for the worklet's final packet.
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined; source.current?.disconnect(); source.current = undefined;
    setState('transcribing'); processor.current?.port.postMessage({ type: 'flush' });
    flushTimer.current = setTimeout(() => { void finish(current); }, 200);
  }
  async function start() {
    const current = ++epoch.current; cleanup(); packets.current = []; samples.current = 0; closing.current = false; setSeconds(0); setState('permission'); setMessage('Waiting for microphone permission…');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== epoch.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media; const audio = new AudioContext(); context.current = audio; await audio.resume(); await audio.audioWorklet.addModule('/voice-worklets.js');
      if (current !== epoch.current) return;
      const node = new AudioWorkletNode(audio, 'tokai-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); processor.current = node;
      source.current = audio.createMediaStreamSource(media); source.current.connect(node); node.connect(audio.destination); recording.current = true;
      node.port.onmessage = ({ data }: MessageEvent<{ type: string; samples: Int16Array; final?: boolean }>) => {
        if (current !== epoch.current || closing.current || data.type !== 'pcm' || !(data.samples instanceof Int16Array)) return;
        const available = 16000 * 30 - samples.current;
        if (available > 0 && data.samples.length) { const packet = data.samples.slice(0, available); packets.current.push(packet); samples.current += packet.length; }
        if (data.final) void finish(current); else if (samples.current >= 16000 * 30) stop(current);
      };
      node.onprocessorerror = () => { if (current === epoch.current) { cancel(); setMessage('Microphone processing stopped. Type your answer or try dictation again.'); } };
      const startedAt = Date.now(); clock.current = setInterval(() => { if (current === epoch.current) setSeconds(Math.min(30, Math.floor((Date.now() - startedAt) / 1000))); }, 250);
      timer.current = setTimeout(() => stop(current), 30000); setState('recording'); setMessage('Recording locally. Stop to send for transcription, or Cancel to discard.');
    } catch (error) { if (current === epoch.current) { cleanup(); setState('idle'); setMessage(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone permission was denied. You can type the same answer.' : 'The microphone could not start. You can keep typing.'); } }
  }
  return <div><div className={styles.actions}>{state === 'idle' ? <button type="button" className={styles.secondary} disabled={disabled} onClick={() => void start()}><Mic size={15}/> Dictate answer</button> : <>{state === 'recording' && <button type="button" className={styles.primary} onClick={() => stop()}><Square size={14}/> Stop and transcribe · {seconds}s</button>}<button type="button" className={styles.secondary} onClick={cancel}><X size={14}/> Cancel dictation</button></>}</div>{message && <p className={styles.muted} role="status" style={{ marginTop: 9 }}>{message}</p>}</div>;
}
