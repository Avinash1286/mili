'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, errorText } from '@/lib/api';
import { ProductShell, StatusMessage } from './ProductShell';
import { notifyPreferences } from './PreferenceEffects';
import styles from './Product.module.css';

export function SignInPage() {
  const router = useRouter();
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<typeof api.authCapabilities>>>();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in'), [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { setCapabilities(await api.authCapabilities()); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function submit() {
    setBusy(true); setError('');
    try {
      const me = mode === 'sign-up' ? await api.nativeSignUp({ name: name.trim(), email: email.trim(), password }) : await api.nativeSignIn({ email: email.trim(), password });
      setPassword(''); notifyPreferences(me.preferences); router.replace('/dashboard');
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  async function providerSignIn() { setBusy(true); setError(''); try { window.location.assign(await api.login()); } catch (e) { setError(errorText(e)); setBusy(false); } }
  return <ProductShell title="Sign in" description="Your guest lessons move to your account.">
    {error && <StatusMessage error>{error}{!capabilities && <button className={styles.secondary} disabled={loading} onClick={() => void load()}>Retry sign-in options</button>}</StatusMessage>}
    {loading ? <p role="status">Checking sign-in options…</p> : <>
      {capabilities?.native && <section className={styles.panel}><h2>{mode === 'sign-up' ? 'Create your learning account.' : 'Welcome back.'}</h2>
        <div className={styles.tabs} role="group" aria-label="Account action"><button type="button" disabled={busy} aria-pressed={mode === 'sign-in'} onClick={() => { setMode('sign-in'); setPassword(''); setError(''); }}>Sign in</button><button type="button" disabled={busy} aria-pressed={mode === 'sign-up'} onClick={() => { setMode('sign-up'); setPassword(''); setError(''); }}>Create account</button></div>
        <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
          {mode === 'sign-up' && <label className={styles.field}>Your name<input required maxLength={80} autoComplete="name" value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>}
          <label className={styles.field}>Email address<input type="email" required maxLength={254} autoComplete="email" value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/></label>
          <label className={styles.field}>Password<input type="password" required minLength={12} maxLength={128} autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} value={password} disabled={busy} onChange={event => setPassword(event.target.value)}/><small>Use 12–128 characters. Email verification and password-reset email are not configured on this installation.</small></label>
          <div><button className={styles.primary} type="submit" disabled={busy}>{busy ? 'Opening your account…' : mode === 'sign-up' ? 'Create my account' : 'Sign in to my account'}</button></div>
        </form>
        <p className={styles.muted} style={{ marginTop: 18 }}>Email addresses on these accounts are unverified.</p>
      </section>}
      {capabilities?.oidc && <section className={styles.panel}><h2>Use your connected identity provider.</h2><p className={styles.intro}>Continue through the sign-in provider configured for this installation.</p><button className={styles.secondary} disabled={busy} onClick={() => void providerSignIn()}>Continue with identity provider</button></section>}
      {capabilities && !capabilities.native && !capabilities.oidc && <StatusMessage>Account sign-in is not configured here. Your guest learning remains available in this browser.</StatusMessage>}
    </>}
    <Link className={styles.link} href="/dashboard">Continue to my learning space</Link>
  </ProductShell>;
}
