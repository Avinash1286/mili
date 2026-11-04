import Link from 'next/link';
export function Mark({ small = false }: { small?: boolean }) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="15" fill="currentColor"/><path d="M10 13v6M14 9.5v13M18 11.5v9M22 14v4" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"/></svg></span>; }
export function Brand() { return <Link className="brand" href="/" aria-label="milli home"><Mark /><span>milli</span></Link>; }
