'use client';
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, Square, PhoneOff, SlidersHorizontal, X, Zap } from 'lucide-react';
import type { Session } from '@tokai/contracts';
import type { useVoiceSession } from '@/hooks/useVoiceSession';
import { VoiceOrb, type OrbState } from './VoiceOrb';
type Voice = ReturnType<typeof useVoiceSession>;
const HANDS_FREE_KEY = 'milli.handsFree';
// Hands-free is the default conversation style; learners can switch to push-to-talk.
function handsFreePreferred() { try { return localStorage.getItem(HANDS_FREE_KEY) !== '0'; } catch { return true; } }
function rememberHandsFree(enabled: boolean) { try { localStorage.setItem(HANDS_FREE_KEY, enabled ? '1' : '0'); } catch { /* Preference stays for this session only. */ } }

export function voiceOrbState(voice: Voice): OrbState {
  if (voice.state === 'connecting' || voice.state === 'reconnecting') return 'connecting';
  if (!voice.connected) return 'off';
  if (voice.recording) return 'listening';
  if (voice.state === 'speaking') return 'speaking';
  if (voice.state === 'thinking' || voice.state === 'recognizing') return 'thinking';
  return 'idle';
}

export function VoiceControls({ voice, session, configured, availability, retryAvailability, locked, beforeStart }: { voice: Voice; session: Session; configured: boolean; availability: 'loading' | 'ready' | 'error'; retryAvailability: () => void; locked: boolean; beforeStart: () => void }) {
  const [options, setOptions] = useState(false);
  const eligible = session.mode === 'live' && availability === 'ready' && configured && session.status === 'active' && !locked;
  const connecting = voice.state === 'connecting';
  const orb = voiceOrbState(voice);
  const hint = session.mode === 'sample' ? 'Voice is available in live lessons.' : availability === 'loading' ? 'Checking voice availability…' : availability === 'error' ? 'We couldn’t check voice availability.' : !configured ? 'Voice needs the tutor and AssemblyAI keys on the server.' : locked ? 'Save your board edits to talk.' : connecting ? 'Connecting…' : ['reconnecting', 'paused', 'error'].includes(voice.state) ? 'Tap to reconnect' : 'Tap to talk with milli';
  const status = voice.recording ? (voice.handsFree ? 'Listening…' : 'Listening… release to send') : voice.state === 'speaking' ? 'milli is speaking' : voice.state === 'thinking' ? 'Thinking…' : voice.state === 'recognizing' ? 'Catching your last words…' : voice.state === 'error' ? 'Needs attention' : !voice.microphone ? 'Type to hear milli' : voice.handsFree ? 'Just start talking' : 'Hold to talk · or hold Space';
  function start(mic: boolean) { beforeStart(); void voice.runtime.start(mic); }
  const pushToTalk = voice.connected && voice.microphone && !voice.handsFree, runtime = voice.runtime;
  const autoHandsFree = useRef(false);
  useEffect(() => {
    if (!voice.connected || !voice.microphone) { if (!voice.connected) autoHandsFree.current = false; return; }
    if (autoHandsFree.current) return; autoHandsFree.current = true;
    if (handsFreePreferred()) runtime.handsFree(true);
  }, [voice.connected, voice.microphone, runtime]);
  useEffect(() => {
    if (!pushToTalk) return;
    // Space anywhere outside a control talks to milli, like a walkie-talkie.
    const idle = (target: EventTarget | null) => target === document.body || target === document.documentElement;
    let held = false;
    const down = (event: KeyboardEvent) => { if (event.key !== ' ' || event.repeat || event.defaultPrevented || !idle(event.target)) return; event.preventDefault(); held = true; runtime.beginTalking(); };
    const up = (event: KeyboardEvent) => { if (event.key !== ' ' || !held) return; event.preventDefault(); held = false; runtime.endTalking(); };
    const blur = () => { if (held) { held = false; runtime.endTalking(); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [pushToTalk, runtime]);
  return <section className={`voice-controls voice-dock-controls ${voice.connected ? 'voice-connected' : ''}`} data-orb={orb} aria-label="Voice conversation">
    {!voice.connected ? <div className="voice-cluster">
      <button className="orb-button" aria-label="Start voice" disabled={!eligible || connecting} onClick={() => start(true)}><VoiceOrb state={eligible || connecting ? orb === 'off' ? 'idle' : orb : 'off'}><Mic size={26}/></VoiceOrb></button>
      <div className="voice-side">
        <p className="voice-hint" role="status">{hint}</p>
        <div className="voice-mini-row">
          <button className="pill-button" aria-label="Start without microphone" title="Listen only, type your questions" disabled={!eligible || connecting} onClick={() => start(false)}><Volume2 size={15}/><span>Listen only</span></button>
          {connecting && <button className="icon-button" aria-label="Cancel voice connection" onClick={() => voice.runtime.stop()}><X size={16}/></button>}
          {session.mode === 'live' && availability !== 'loading' && (availability === 'error' || !configured) && <button className="pill-button" onClick={retryAvailability}>Retry voice availability</button>}
        </div>
      </div>
    </div> : <div className="voice-cluster">
      {voice.microphone && !voice.handsFree ? <button className={`orb-button ${voice.recording ? 'recording' : ''}`} aria-label="Hold to talk" aria-pressed={voice.recording}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); voice.runtime.beginTalking(); }}
        onPointerUp={() => voice.runtime.endTalking()} onPointerCancel={() => voice.runtime.endTalking()}
        onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); voice.runtime.beginTalking(); } }}
        onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); voice.runtime.endTalking(); } }}
        onBlur={() => voice.runtime.endTalking()}><VoiceOrb state={orb} level={voice.level}><Mic size={26}/></VoiceOrb></button>
        : <span className="orb-button orb-static"><VoiceOrb state={orb} level={voice.level}>{voice.microphone ? <Mic size={26}/> : <Volume2 size={26}/>}</VoiceOrb></span>}
      <div className="voice-side">
        <p className="voice-status" role="status">{status}</p>
        <div className="voice-mini-row">
          <button className="round-button" aria-label="Stop tutor" title="Stop milli" onClick={() => voice.runtime.interrupt()}><Square size={14}/></button>
          {voice.microphone && !voice.handsFree && <button className="round-button" aria-label="Toggle microphone recording" title={voice.recording ? 'Send' : 'Tap to record'} aria-pressed={voice.recording} onClick={() => voice.recording ? voice.runtime.endTalking() : voice.runtime.beginTalking()}><span className="rec-dot"/></button>}
          <button className="round-button" aria-label={voice.microphone ? 'Mute microphone' : 'Enable microphone'} title={voice.microphone ? 'Mute' : 'Unmute'} onClick={() => voice.microphone ? voice.runtime.disableMicrophone() : void voice.runtime.changeDevice(voice.deviceId)}>{voice.microphone ? <MicOff size={15}/> : <Mic size={15}/>}</button>
          <button className="round-button" aria-label="Voice options" aria-expanded={options} onClick={() => setOptions(!options)}><SlidersHorizontal size={15}/></button>
          <button className="round-button danger" aria-label="Disconnect voice" title="End voice" onClick={() => voice.runtime.stop()}><PhoneOff size={15}/></button>
          {voice.metrics?.firstAudioMs !== undefined && <span className="latency-pill" title={`First synthesized audio after ${Math.round(voice.metrics.firstAudioMs)} ms. Model response ${Math.round(voice.metrics.llmMs)} ms.`}><Zap size={12}/>{Math.round(voice.metrics.firstAudioMs)} ms</span>}
        </div>
      </div>
      {voice.microphone && <span className="sr-only" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.level * 100)}/>}
      {options && <div className="voice-options" role="group" aria-label="Voice options">
        <label className="handsfree-option"><input type="checkbox" checked={voice.handsFree} disabled={!voice.microphone} onChange={event => { rememberHandsFree(event.target.checked); voice.runtime.handsFree(event.target.checked); }}/> Hands-free</label>
        <p>Talk naturally. Speaking interrupts milli. Headphones help.</p>
        {!!voice.devices.length && <label className="mic-device-label">Microphone<select value={voice.deviceId} onChange={event => void voice.runtime.changeDevice(event.target.value)}><option value="">System default</option>{voice.devices.filter(d => d.id !== 'default').map(device => <option value={device.id} key={device.id}>{device.label}</option>)}</select></label>}
        <p>Hold Space on the orb to talk. Audio isn’t stored.</p>
        <p>Say “show me in 3D”, “open practice”, “repeat that” or “finish lesson”.</p>
      </div>}
    </div>}
    {voice.notice && <p className="voice-notice" role="status">{voice.notice}</p>}
    {voice.error && <p className="voice-error" role="alert">{voice.error} You can keep typing.</p>}
  </section>;
}
