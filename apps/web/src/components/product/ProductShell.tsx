'use client';

import { BookOpen } from 'lucide-react';
import type { Identity } from '@tokai/contracts';
import { AppNav } from '../AppNav';
import styles from './Product.module.css';

export function ProductShell({ title, description, identity, children, actions }: {
  title: string; eyebrow?: string; description?: string; identity?: Identity; children: React.ReactNode; actions?: React.ReactNode;
}) {
  return <div className={styles.shell}>
    <AppNav identity={identity}/>
    <main id="main" className={styles.content}>
      <div className={styles.pageHeading}><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className={styles.actions}>{actions}</div>}</div>
      {children}
    </main>
  </div>;
}

export function StatusMessage({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return <div className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={styles.empty}><BookOpen size={25}/><h2>{title}</h2><p>{children}</p></div>;
}
