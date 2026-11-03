import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'Tokai · Make room for curiosity', description: 'A little curiosity. A clearer understanding. Explore ideas with a visual tutor and a whiteboard that makes learning feel natural.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth"><body><a className="skip-link" href="#main">Skip to content</a>{children}</body></html>;
}
