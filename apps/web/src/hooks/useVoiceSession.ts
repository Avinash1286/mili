'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Session } from '@tokai/contracts';
import { initialVoiceView, VoiceRuntime } from '@/lib/voice-runtime';

export function useVoiceSession(id: string, onSession: (session: Session) => void, selectedNodeId?: string, ended = false) {
  const runtime = useMemo(() => new VoiceRuntime(id), [id]); runtime.onSession = onSession;
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, () => initialVoiceView);
  useEffect(() => { runtime.select(selectedNodeId); }, [runtime, selectedNodeId]);
  useEffect(() => { if (ended) runtime.stop('ended'); }, [runtime, ended]);
  useEffect(() => { const visibility = () => { if (document.hidden) runtime.pauseForVisibility(); }; const pagehide = () => runtime.stop('paused'); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide); return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); runtime.stop(); }; }, [runtime]);
  return { ...view, runtime };
}
