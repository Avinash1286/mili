'use client';
import { useEffect, useState } from 'react';

export const fileExpired = (item: { fileExpiresAt?: string }, now: number) => Boolean(item.fileExpiresAt && Date.parse(item.fileExpiresAt) <= now);

/** Refresh at the next file deadline even when the saved-material screen is idle. */
export function useFileExpiry(items: { fileExpiresAt?: string }[]) {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(Infinity, ...items.map(item => Date.parse(item.fileExpiresAt ?? '')).filter(value => Number.isFinite(value) && value > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, next - Date.now() + 20)));
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}
