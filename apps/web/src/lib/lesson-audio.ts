'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';

// One silent PCM sample. A blob URL complies with the app's media policy.
const SILENT_WAV = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAgLsAAAB3AQACABAAZGF0YQIAAAAAAA==';

let unlockedAudioElement: HTMLAudioElement | null = null;

/** Call synchronously inside a click/submit handler before navigating to `/learn/[id]`. */
export function unlockLessonAudio() {
  if (typeof window === 'undefined' || unlockedAudioElement) return;
  try {
    const bytes = Uint8Array.from(atob(SILENT_WAV), byte => byte.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const element = new Audio(url);
    unlockedAudioElement = element;
    void element.play().catch(() => {
      if (element.src === url) unlockedAudioElement = null;
    }).finally(() => URL.revokeObjectURL(url));
  } catch {
    // Ignore environments without HTMLAudioElement playback support.
  }
}

export interface SpeakOptions {
  sessionId: string;
  text?: string;
  stepId?: string;
  part?: 'concept' | 'question' | 'step' | 'body' | 'explanation';
  mode: 'sample' | 'live';
  speechConfigured: boolean;
  manual?: boolean;
  onStart?: () => void;
  onComplete?: () => void;
}

const audioBlobCache = new Map<string, Blob>();

export interface UseLessonAudioOptions {
  onSpeechUnreachable?: (message: string, manual: boolean) => void;
}

/**
 * AssemblyAI-only TTS playback hook (no browser `speechSynthesis` fallback).
 * When AssemblyAI is unreachable or unconfigured in a live lesson, surfaces a clear error
 * and notifies the caller so the learner continues seamlessly via chat.
 */
export function useLessonAudio(hookOptions: UseLessonAudioOptions = {}) {
  const [speaking, setSpeaking] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [speechError, setSpeechError] = useState('');

  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const lastOptionsRef = useRef<SpeakOptions | null>(null);
  const mutedRef = useRef(false);
  const onUnreachableRef = useRef(hookOptions.onSpeechUnreachable);
  onUnreachableRef.current = hookOptions.onSpeechUnreachable;

  const cleanupPlayback = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      try {
        audioRef.current.pause();
      } catch {}
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    epochRef.current++;
    cleanupPlayback();
    setSpeaking(false);
    setLoadingAudio(false);
  }, [cleanupPlayback]);

  useEffect(() => () => {
    epochRef.current++;
    cleanupPlayback();
  }, [cleanupPlayback]);

  const speak = useCallback(async (options: SpeakOptions) => {
    lastOptionsRef.current = options;
    const currentEpoch = ++epochRef.current;
    cleanupPlayback();
    setNeedsTapToPlay(false);

    if (mutedRef.current) {
      setSpeaking(false);
      setLoadingAudio(false);
      return;
    }

    // Guided sample lessons are offline and do not invoke AssemblyAI.
    if (options.mode === 'sample') {
      setSpeaking(false);
      setLoadingAudio(false);
      if (options.manual) {
        const msg = 'Voice is disabled in offline sample mode. Continue with chat below.';
        setSpeechError(msg);
        onUnreachableRef.current?.(msg, true);
      }
      return;
    }

    if (!options.speechConfigured) {
      setSpeaking(false);
      setLoadingAudio(false);
      const msg = 'AssemblyAI speech is unreachable right now. Continue the lesson with chat.';
      setSpeechError(msg);
      onUnreachableRef.current?.(msg, Boolean(options.manual));
      return;
    }

    const cacheKey = `${options.sessionId}:${options.stepId || ''}:${options.part || 'step'}:${options.text || ''}`;
    let blob = audioBlobCache.get(cacheKey);

    if (!blob) {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoadingAudio(true);

      try {
        blob = await api.courseSpeech(
          options.sessionId,
          { stepId: options.stepId, part: options.part ?? 'step', text: options.text },
          options.part ?? 'step',
          controller.signal,
        );
        if (epochRef.current !== currentEpoch) return;
        if (audioBlobCache.size >= 40) {
          const oldest = audioBlobCache.keys().next().value;
          if (oldest) audioBlobCache.delete(oldest);
        }
        audioBlobCache.set(cacheKey, blob);
      } catch (err) {
        if (epochRef.current !== currentEpoch || controller.signal.aborted) return;
        setLoadingAudio(false);
        setSpeaking(false);
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setNeedsTapToPlay(true);
          return;
        }
        const msg = errorText(err);
        setSpeechError(msg);
        onUnreachableRef.current?.(msg, Boolean(options.manual));
        return;
      }
    }

    if (epochRef.current !== currentEpoch) return;
    setSpeechError('');

    try {
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const el = unlockedAudioElement ?? new Audio();
      el.src = url;
      el.volume = 1;
      audioRef.current = el;
      el.onended = () => {
        if (epochRef.current !== currentEpoch) return;
        setSpeaking(false);
        setLoadingAudio(false);
        options.onComplete?.();
      };
      el.onerror = () => {
        if (epochRef.current !== currentEpoch) return;
        setSpeaking(false);
        setLoadingAudio(false);
        const msg = 'AssemblyAI speech audio could not be played. Continue the lesson with chat.';
        setSpeechError(msg);
        onUnreachableRef.current?.(msg, Boolean(options.manual));
      };
      setLoadingAudio(false);
      await el.play();
      if (epochRef.current === currentEpoch) {
        setSpeaking(true);
        options.onStart?.();
      }
    } catch (err) {
      if (epochRef.current !== currentEpoch) return;
      setLoadingAudio(false);
      setSpeaking(false);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setNeedsTapToPlay(true);
        return;
      }
      const msg = 'Speech audio could not be played. Continue the lesson with chat.';
      setSpeechError(msg);
      onUnreachableRef.current?.(msg, Boolean(options.manual));
    }
  }, [cleanupPlayback]);

  const replayLast = useCallback(() => {
    unlockLessonAudio();
    setNeedsTapToPlay(false);
    setSpeechError('');
    if (lastOptionsRef.current) {
      void speak({ ...lastOptionsRef.current, manual: true });
    }
  }, [speak]);

  const clearSpeechError = useCallback(() => setSpeechError(''), []);

  const setMuted = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setMutedState(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      mutedRef.current = next;
      if (next) {
        epochRef.current++;
        cleanupPlayback();
        setSpeaking(false);
        setLoadingAudio(false);
      }
      return next;
    });
  }, [cleanupPlayback]);

  return {
    speaking,
    loadingAudio,
    muted,
    setMuted,
    needsTapToPlay,
    speechError,
    clearSpeechError,
    speak,
    stop,
    replayLast,
  };
}
