'use client';
import type { CSSProperties, ReactNode } from 'react';

export type OrbState = 'off' | 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

/** Decorative animated orb; callers wrap it in an accessible control. */
export function VoiceOrb({ state, level = 0, size = 'large', children }: { state: OrbState; level?: number; size?: 'large' | 'small'; children?: ReactNode }) {
  return <span className={`voice-orb orb-${size}`} data-state={state} style={{ '--level': Math.min(1, level * 2.2).toFixed(3) } as CSSProperties} aria-hidden="true">
    <span className="orb-glow"/><span className="orb-ring"/><span className="orb-core">
      {state === 'speaking' ? <span className="orb-bars"><i/><i/><i/><i/><i/></span> : children}
    </span>
  </span>;
}
