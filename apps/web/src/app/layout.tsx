import type { Metadata } from 'next';
import './globals.css';
import './milli.css';
import { PreferenceEffects } from '@/components/product/PreferenceEffects';

export const metadata: Metadata = { title: 'milli · Learn out loud', description: 'A voice-first visual tutor. Talk it through, see it click.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth"><body><PreferenceEffects/><a className="skip-link" href="#main">Skip to content</a>{children}</body></html>;
}
