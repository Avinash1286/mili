'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/lib/api';
import { openDictationStream, type DictationStream } from '@/lib/dictation-stream';

export type InlineMicState = 'idle' | 'permission' | 'connecting' | 'listening' | 'transcribing';

// Allow a brief thinking pause between sentences before ending the learner turn.
const ENDPOINT_SILENCE_FRAMES = 26;

export interface UseInlineMicOptions {
  sessionId: string;
  onTranscript: (text: string) => void;
  onStartListening?: () => void;
  onError?: (message: string) => void;
  autoStopOnSilence?: boolean;
}

/**
 * One-tap milli inline microphone hook:
 * Captures 16 kHz mono PCM via `/voice-worklets.js`, reports live RMS level for waveform feedback,
 * automatically stops after ~1.3 seconds of silence once speech has begun, and streams directly to the owned speech relay while the learner speaks.
 */
export function useInlineMic({
  sessionId,
  onTranscript,
  onStartListening,
  onError,
  autoStopOnSilence = true,
}: UseInlineMicOptions) {
  const [state, setState] = useState<InlineMicState>('idle');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);

  const speechStreamRef = useRef<DictationStream | null>(null);
  const epochRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const samplesRef = useRef(0);
  const recordingRef = useRef(false);
  const closingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const speechFramesRef = useRef(0);
  const silenceFramesRef = useRef(0);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onStartRef = useRef(onStartListening);
  onStartRef.current = onStartListening;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const cleanup = useCallback(() => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    if (processorRef.current) {
      processorRef.current.port.onmessage = null;
      try { processorRef.current.port.close(); } catch {}
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (contextRef.current) {
      void contextRef.current.close().catch(() => {});
      contextRef.current = null;
    }
    recordingRef.current = false;
    setLevel(0);
  }, []);

  const cancel = useCallback(() => {
    epochRef.current++;
    speechStreamRef.current?.cancel();
    speechStreamRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    cleanup();
    samplesRef.current = 0;
    closingRef.current = false;
    setState('idle');
    setSeconds(0);
  }, [cleanup]);

  useEffect(() => () => {
    epochRef.current++;
    speechStreamRef.current?.cancel();
    speechStreamRef.current = null;
    abortRef.current?.abort();
    cleanup();
  }, [cleanup]);

  const finish = useCallback(async (currentEpoch: number) => {
    if (currentEpoch !== epochRef.current || closingRef.current) return;
    closingRef.current = true;
    cleanup();
    const streaming = speechStreamRef.current;
    speechStreamRef.current = null;
    samplesRef.current = 0;
    setState('transcribing');
    try {
      if (!streaming) throw new Error('Voice input disconnected. Please try again.');
      const text = await streaming.finish();
      if (currentEpoch === epochRef.current && text.trim()) onTranscriptRef.current(text.trim());
    } catch (error) {
      if (currentEpoch === epochRef.current) onErrorRef.current?.(errorText(error));
    } finally {
      if (currentEpoch === epochRef.current) {
        closingRef.current = false; abortRef.current = null; setState('idle'); setSeconds(0);
      }
    }
  }, [cleanup]);

  const stopAndSend = useCallback((currentEpoch = epochRef.current) => {
    if (currentEpoch !== epochRef.current || !recordingRef.current) return;
    recordingRef.current = false;
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    setState('transcribing');
    setLevel(0);
    processorRef.current?.port.postMessage({ type: 'flush' });
    flushTimerRef.current = setTimeout(() => {
      void finish(currentEpoch);
    }, 180);
  }, [finish]);

  const start = useCallback(async () => {
    const currentEpoch = ++epochRef.current;
    cleanup();
    samplesRef.current = 0;
    closingRef.current = false;
    speechFramesRef.current = 0;
    silenceFramesRef.current = 0;
    setSeconds(0);
    setState('permission');
    onStartRef.current?.();

    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (currentEpoch !== epochRef.current) {
        media.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = media;
      setState('connecting');
      const controller = new AbortController();
      abortRef.current = controller;
      const streaming = await openDictationStream(sessionId, controller.signal);
      if (currentEpoch !== epochRef.current) { streaming.cancel(); return; }
      speechStreamRef.current = streaming;
      const audio = new AudioContext();
      contextRef.current = audio;
      await audio.resume();
      await audio.audioWorklet.addModule('/voice-worklets.js');
      if (currentEpoch !== epochRef.current) return;

      const node = new AudioWorkletNode(audio, 'tokai-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      processorRef.current = node;
      const src = audio.createMediaStreamSource(media);
      sourceRef.current = src;
      src.connect(node);
      node.connect(audio.destination);
      recordingRef.current = true;

      node.port.onmessage = ({ data }: MessageEvent<{ type: string; samples: Int16Array; rms?: number; final?: boolean }>) => {
        if (currentEpoch !== epochRef.current || closingRef.current || data.type !== 'pcm' || !(data.samples instanceof Int16Array)) return;
        const available = 16000 * 30 - samplesRef.current;
        if (available > 0 && data.samples.length) {
          const packet = data.samples.slice(0, available);
          try { speechStreamRef.current?.send(packet); }
          catch (error) { cancel(); onErrorRef.current?.(errorText(error)); return; }
          samplesRef.current += packet.length;
        }
        const rms = typeof data.rms === 'number' ? data.rms : 0;
        setLevel(Math.min(1, rms * 8));

        if (autoStopOnSilence && !data.final) {
          if (rms > 0.018) {
            speechFramesRef.current += 1;
            silenceFramesRef.current = 0;
          } else if (speechFramesRef.current >= 3) {
            silenceFramesRef.current += 1;
            if (silenceFramesRef.current >= ENDPOINT_SILENCE_FRAMES) {
              stopAndSend(currentEpoch);
              return;
            }
          }
        }

        if (data.final) {
          void finish(currentEpoch);
        } else if (samplesRef.current >= 16000 * 30) {
          stopAndSend(currentEpoch);
        }
      };

      const startedAt = Date.now();
      clockRef.current = setInterval(() => {
        if (currentEpoch === epochRef.current) {
          setSeconds(Math.min(30, Math.floor((Date.now() - startedAt) / 1000)));
        }
      }, 250);
      maxTimerRef.current = setTimeout(() => stopAndSend(currentEpoch), 30000);
      setState('listening');
    } catch (err) {
      if (currentEpoch === epochRef.current) {
        speechStreamRef.current?.cancel(); speechStreamRef.current = null;
        cleanup();
        setState('idle');
        onErrorRef.current?.(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone permission was blocked. You can type your question or answer with /.'
            : errorText(err),
        );
      }
    }
  }, [autoStopOnSilence, cancel, cleanup, finish, sessionId, stopAndSend]);

  const toggle = useCallback(() => {
    if (state === 'listening') stopAndSend();
    else if (state === 'idle') void start();
  }, [start, state, stopAndSend]);

  return {
    state,
    level,
    seconds,
    start,
    stopAndSend,
    cancel,
    toggle,
  };
}
