 'use client';

import { ThinkingOrb } from 'thinking-orbs';

export type MascotMood = 'idle' | 'happy' | 'thinking' | 'speaking' | 'listening' | 'curious';
const states = { idle: 'breathing', happy: 'connecting', thinking: 'solving', speaking: 'composing', listening: 'listening', curious: 'searching' } as const;

/** State-driven, reduced-motion-aware orb by Thinking Orbs (MIT). */
export function MilliMascot({ mood = 'idle', onClick, label = 'Ask milli for help' }: {
  mood?: MascotMood; onClick?: () => void; label?: string;
}) {
  const orb = <ThinkingOrb state={states[mood]} size={64} theme="light" aria-hidden="true" />;
  return onClick
    ? <button type="button" onClick={onClick} aria-label={label} className={`milli-mascot is-${mood}`}>{orb}</button>
    : <span role="img" aria-label={label} className={`milli-mascot is-${mood}`}>{orb}</span>;
}

/** Lightweight inline formatter for **bold**, `code` and simple $math$ without unsafe HTML. */
export function FormattedStepText({ text }: { text: string }) {
  const paragraphs = text.split(/\n\n+/);
  return (
    <div className="milli-course-prose">
      {paragraphs.map((p, pi) => (
        <p key={pi}>{renderInline(p)}</p>
      ))}
    </div>
  );
}

function renderInline(line: string): React.ReactNode[] {
  const clean = line
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\,/g, ' ')
    .replace(/\^\{([^{}]+)\}/g, '^$1');
  const parts = clean.split(/(\*\*[^*]+\*\*|\$[^$]+\$|`[^`]+`)/g);
  return parts.map((tok, i) => {
    if (tok.startsWith('**') && tok.endsWith('**')) return <strong key={i}>{tok.slice(2, -2)}</strong>;
    if (tok.startsWith('$') && tok.endsWith('$')) return <span key={i} className="milli-course-math">{tok.slice(1, -1)}</span>;
    if (tok.startsWith('`') && tok.endsWith('`')) return <code key={i}>{tok.slice(1, -1)}</code>;
    return <span key={i}>{tok}</span>;
  });
}
