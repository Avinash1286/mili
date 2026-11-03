'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, BookOpen, Compass, Layers, LayoutDashboard, Plus, Settings, Sprout } from 'lucide-react';
import type { Identity } from '@tokai/contracts';
import { Brand } from '../Brand';
import styles from './Product.module.css';

const navigation = [
  { href: '/', label: 'Discover', icon: Compass },
  { href: '/dashboard', label: 'My learning', icon: LayoutDashboard },
  { href: '/library', label: 'Library', icon: BookOpen },
  { href: '/review', label: 'Review', icon: Layers },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function ProductShell({ title, eyebrow = 'YOUR LEARNING, UNFOLDING', description, identity, children, actions }: {
  title: string; eyebrow?: string; description?: string; identity?: Identity; children: React.ReactNode; actions?: React.ReactNode;
}) {
  const pathname = usePathname();
  return <div className={styles.shell}>
    <aside className={styles.sidebar}>
      <Brand />
      <nav aria-label="Learning space" className={styles.navigation}>{navigation.map(item => {
        const active = pathname === item.href || item.href !== '/' && pathname.startsWith(`${item.href}/`);
        return <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}><item.icon size={18}/><span>{item.label}</span></Link>;
      })}</nav>
      <div className={styles.sidebarNote}><Sprout size={31}/><p>Small steps.<br/><em>Lasting understanding.</em></p></div>
      <Link href="/settings" className={styles.identity}><span>{(identity?.displayName || 'Y').slice(0, 1).toUpperCase()}</span><div><strong>{identity?.displayName || 'Your learning space'}</strong><small>{identity?.kind === 'user' ? 'Signed in' : identity?.kind === 'guest' ? 'Guest workspace' : 'Preferences and access'}</small></div><ArrowRight size={14}/></Link>
    </aside>
    <div className={styles.main}>
      <header className={styles.topbar}><div className={styles.mobileBrand}><Brand/></div><span className={styles.breadcrumb}>Your workspace / {title}</span><Link href="/learn/new" className={styles.primary}><Plus size={15}/> New lesson</Link></header>
      <nav className={styles.mobileNavigation} aria-label="Mobile learning space">{navigation.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}><item.icon size={16}/>{item.label}</Link>)}</nav>
      <main id="main" className={styles.content}>
        <div className={styles.pageHeading}><div><span className={styles.eyebrow}>{eyebrow}</span><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className={styles.actions}>{actions}</div>}</div>
        {children}
      </main>
      <footer className={styles.footer}>Take your time. Understanding is worth it.</footer>
    </div>
  </div>;
}

export function StatusMessage({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return <div className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={styles.empty}><BookOpen size={25}/><h2>{title}</h2><p>{children}</p></div>;
}
