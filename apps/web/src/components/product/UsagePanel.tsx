'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageKind, UsageSummary } from '@tokai/contracts';
import { StatusMessage } from './ProductShell';
import styles from './Product.module.css';
import usageStyles from './UsagePanel.module.css';

function units(kind: UsageKind, amount: number) {
  if (kind === 'transcription') return `${(amount / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} seconds`;
  if (kind === 'ingestion') return `${(amount / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
  return `${amount.toLocaleString()} ${kind === 'speech' ? 'characters' : 'requests'}`;
}

export function UsagePanel({ load }: { load: () => Promise<UsageSummary> }) {
  const [summary, setSummary] = useState<UsageSummary>(), [pending, setPending] = useState(true), [error, setError] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current; setPending(true); setError(false);
    try { const value = await load(); if (current === request.current) setSummary(value); }
    catch { if (current === request.current) setError(true); }
    finally { if (current === request.current) setPending(false); }
  }, [load]);
  useEffect(() => { void refresh(); return () => { request.current++; }; }, [refresh]);
  return <section className={styles.panel} aria-labelledby="usage-heading">
    <h2 id="usage-heading">Your daily learning allowance.</h2>
    <p className={styles.intro}>These limits cover activity in this Tokai workspace. Provider account credits and invoices are managed in your provider dashboard.</p>
    {pending && !summary && <p role="status">Checking your allowance…</p>}
    {error && <StatusMessage error>We couldn’t refresh your allowance. Your preferences and saved learning remain available.</StatusMessage>}
    {summary && <>
      <div className={usageStyles.grid}>{summary.kinds.map(item => <div className={usageStyles.item} key={item.kind}>
        <h3>{item.label}</h3><p><strong>{units(item.kind, item.remaining)}</strong> remaining</p>
        <progress aria-label={`${item.label} used`} value={Math.min(item.used, Math.max(item.limit, 1))} max={Math.max(item.limit, 1)}/>
        <p>{units(item.kind, item.used)} reserved of {units(item.kind, item.limit)} per day.</p>
        {!!item.active && <p>{item.active} request{item.active === 1 ? '' : 's'} currently running.</p>}
      </div>)}</div>
      <p className={styles.muted}>Resets at <time dateTime={summary.resetsAt}>{new Date(summary.resetsAt).toLocaleString(undefined, { timeZone: 'UTC' })} UTC</time>. Failed requests keep their reserved units. Saved lessons and guided samples remain available when the allowance is used.</p>
      {summary.pricing === 'configured' && summary.estimatedUsd !== undefined ? <p className={styles.muted}>Estimated provider usage: {summary.estimatedUsd.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })}{summary.priceDate ? ` using prices dated ${summary.priceDate}` : ''}. This estimate is separate from your provider invoice.</p> : <p className={styles.muted}>A provider price estimate is not configured.</p>}
      <p className={styles.muted}>{summary.note}</p>
    </>}
    <button className={styles.secondary} style={{ marginTop: 16 }} disabled={pending} onClick={() => void refresh()}>{pending ? 'Checking allowance…' : 'Refresh allowance'}</button>
  </section>;
}
