'use client';
import { useSyncExternalStore } from 'react';

const GESTURES_KEY = 'milli.gestures';
const listeners = new Set<() => void>();

export function setGesturesEnabled(enabled: boolean) {
  try { if (enabled) localStorage.setItem(GESTURES_KEY, '1'); else localStorage.removeItem(GESTURES_KEY); } catch { /* Storage can be unavailable; the default stays off. */ }
  listeners.forEach(listener => listener());
}
function read() { try { return localStorage.getItem(GESTURES_KEY) === '1'; } catch { return false; } }
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === GESTURES_KEY) listener(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}
/** Camera hand gestures are an opt-in experiment, off by default to keep lessons voice-first. */
export function useGesturesEnabled() { return useSyncExternalStore(subscribe, read, () => false); }
