'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { LearnerPreferencesSchema, type LearnerPreferences } from '@milli/contracts';
import { api } from '@/lib/api';
import './preferences.css';

const eventName = 'tokai:preferences', cacheKey = 'tokai.accessibility.v1';
export function notifyPreferences(preferences: LearnerPreferences) { window.dispatchEvent(new CustomEvent(eventName, { detail: preferences })); }
function apply(preferences: Pick<LearnerPreferences, 'reducedMotion' | 'highContrast' | 'fontScale'>) {
  document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
  document.documentElement.dataset.highContrast = String(preferences.highContrast);
  document.documentElement.dataset.fontScale = preferences.fontScale;
  try { localStorage.setItem(cacheKey, JSON.stringify({ reducedMotion: preferences.reducedMotion, highContrast: preferences.highContrast, fontScale: preferences.fontScale })); } catch { /* Accessibility still works when storage is unavailable. */ }
}
export function PreferenceEffects() {
  const pathname = usePathname();
  useEffect(() => {
    try { const cached = localStorage.getItem(cacheKey); if (cached) { const parsed = LearnerPreferencesSchema.safeParse(JSON.parse(cached)); if (parsed.success) apply(parsed.data); } } catch { /* Ignore an unavailable or invalid local preference cache. */ }
    const changed = (event: Event) => { const parsed = LearnerPreferencesSchema.safeParse((event as CustomEvent).detail); if (parsed.success) apply(parsed.data); };
    window.addEventListener(eventName, changed); return () => window.removeEventListener(eventName, changed);
  }, []);
  useEffect(() => { if (pathname.startsWith('/share/')) return; let live = true; void api.me().then(value => { if (live) apply(value.preferences); }).catch(() => undefined); return () => { live = false; }; }, [pathname]);
  return null;
}
