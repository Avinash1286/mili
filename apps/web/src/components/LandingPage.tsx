'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Mic, Sparkles } from 'lucide-react';
import type { Identity } from '@milli/contracts';
import { api } from '@/lib/api';
import { AppNav } from './AppNav';
import { MilliMascot } from './course/MilliMascot';

export function LandingPage() {
  const [identity, setIdentity] = useState<Identity>();
  useEffect(() => { void api.me().then(value => setIdentity(value.identity)).catch(() => undefined); }, []);
  return <div className="milli-landing">
    <AppNav identity={identity}/>
    <main id="main">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-kicker"><Sparkles size={15}/> Learning that talks back</p>
          <h1>Make the next <em>“oh, I get it”</em> happen.</h1>
          <p className="landing-lede">milli is a live learning companion that explains, demonstrates, listens, and waits for your thinking—not just your answer.</p>
          <div className="landing-actions">
            <Link className="chunky-button" href="/learn">Start learning <ArrowRight size={18}/></Link>
            {identity?.kind === 'user' ? <Link className="pill-button" href="/courses">My courses</Link> : <Link className="pill-button" href="/sign-in">Save my progress</Link>}
          </div>
          <ul className="landing-points" aria-label="milli features">
            <li><CheckCircle2 size={17}/> Ask out loud or type</li><li><CheckCircle2 size={17}/> Try hands-on challenges</li><li><CheckCircle2 size={17}/> Learn at your pace</li>
          </ul>
        </div>
        <div className="landing-stage" aria-label="An example milli tutoring exchange">
          <div className="landing-orbit orbit-one"/><div className="landing-orbit orbit-two"/>
          <div className="landing-message learner">Why does a plant look green?</div>
          <div className="landing-orb"><MilliMascot mood="speaking" label="milli is ready to teach"/></div>
          <div className="landing-message tutor"><span><Mic size={14}/> milli</span>Great question. Let’s trace what sunlight does when it hits a leaf.</div>
          <div className="landing-task"><strong>Try it yourself</strong><span>Move the light and watch the leaf respond.</span></div>
        </div>
      </section>
      <section className="landing-proof" aria-label="How milli teaches">
        <article><span>01</span><h2>Start with curiosity</h2><p>Say what you want to understand. milli turns it into a focused lesson.</p></article>
        <article><span>02</span><h2>Learn by doing</h2><p>Predict, adjust, explain, and see what changes—not just what a textbook says.</p></article>
        <article><span>03</span><h2>Get a real response</h2><p>milli follows your answer, gives a nudge when needed, and celebrates the click.</p></article>
      </section>
    </main>
  </div>;
}
