'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { Identity } from '@tokai/contracts';
import { Brand } from './Brand';

const links = [
  { href: '/', label: 'Learn' },
  { href: '/review', label: 'Review' },
  { href: '/settings', label: 'Settings' },
];

export function AppNav({ identity }: { identity?: Identity }) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || href !== '/' && pathname.startsWith(`${href}/`);
  return <header className="app-nav">
    <div className="app-nav-inner">
      <Brand/>
      <nav aria-label="Learning space" className="app-nav-links">{links.map(link => <Link key={link.href} href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</Link>)}</nav>
      <div className="app-nav-end">
        <Link href="/learn/new" className="chunky-button small" aria-label="New lesson"><Plus size={16}/><span>New lesson</span></Link>
        <Link href="/settings" className="avatar" aria-label={identity?.kind === 'user' ? `Signed in as ${identity.displayName ?? 'you'}` : 'Guest · settings'}>{(identity?.displayName || 'Y').slice(0, 1).toUpperCase()}</Link>
      </div>
    </div>
    <nav className="app-nav-mobile" aria-label="Mobile learning space">{links.map(link => <Link key={link.href} href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</Link>)}</nav>
  </header>;
}
