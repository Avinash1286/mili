import Link from 'next/link';
export function Mark({ small = false }: { small?: boolean }) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 5v22M5 16h22M8 8l16 16M8 24 24 8" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><circle cx="16" cy="16" r="5" fill="currentColor"/></svg></span>; }
export function Brand() { return <Link className="brand" href="/" aria-label="Tokai home"><Mark /><span>tokai<span className="brand-period">.</span></span></Link>; }
