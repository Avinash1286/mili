'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Session, Board, ConceptMap, SelectionContext } from '@tokai/contracts';
import { initialVoiceView, VoiceRuntime } from '@/lib/voice-runtime';

export function useVoiceSession(id: string, onSession: (session: Session) => void, selectedNodeId?: string, ended = false, selection?: SelectionContext, onBoard?: (board: Board, beatId?: string, signal?: AbortSignal, map?: ConceptMap, focusIds?: string[]) => Promise<boolean>, onMap?: (map: ConceptMap) => void) {
  const runtime = useMemo(() => new VoiceRuntime(id), [id]); runtime.onSession = onSession;
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, () => initialVoiceView);
  if (onBoard) runtime.onBoard = onBoard; if (onMap) runtime.onMap = onMap;
  useEffect(() => { const timer = setTimeout(() => runtime.select(selectedNodeId, selection), 120); return () => clearTimeout(timer); }, [runtime, selectedNodeId, selection]);
  useEffect(() => { if (ended) runtime.stop('ended'); }, [runtime, ended]);
  useEffect(() => { const visibility = () => { if (document.hidden) runtime.pauseForVisibility(); }; const pagehide = () => runtime.stop('paused'); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide); return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); runtime.stop(); }; }, [runtime]);
  return { ...view, runtime };
}
