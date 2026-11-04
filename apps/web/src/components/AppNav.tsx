'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, ChevronDown, CircleUser, LogIn, Settings } from 'lucide-react';
import type { Identity } from '@milli/contracts';
import { Brand } from './Brand';

const links = [{ href: '/learn', label: 'Learn' }];

export function AppNav({ identity }: { identity?: Identity }) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || href !== '/' && pathname.startsWith(`${href}/`);
  return <header className="app-nav">
    <div className="app-nav-inner">
      <Brand/>
      <nav aria-label="Learning space" className="app-nav-links">{links.map(link => <Link key={link.href} href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</Link>)}</nav>
      <div className="app-nav-end">
        <details className="profile-menu">
          <summary aria-label={identity?.kind === 'user' ? `Open profile menu for ${identity.displayName ?? 'you'}` : 'Open guest profile menu'}>
            <span className="avatar">{(identity?.displayName || 'Y').slice(0, 1).toUpperCase()}</span><ChevronDown size={16}/>
          </summary>
          <div className="profile-popover">
            <p className="profile-label">{identity?.kind === 'user' ? identity.displayName ?? 'Your account' : 'Learning as a guest'}</p>
            <Link href="/courses"><BookOpen size={16}/> Courses</Link>
            <Link href="/settings"><Settings size={16}/> Settings</Link>
            {identity?.kind === 'user' ? <Link href="/settings#account"><CircleUser size={16}/> Account</Link> : <Link href="/sign-in"><LogIn size={16}/> Sign in</Link>}
          </div>
        </details>
      </div>
    </div>
    <nav className="app-nav-mobile" aria-label="Mobile learning space">{links.map(link => <Link key={link.href} href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</Link>)}</nav>
  </header>;
}
