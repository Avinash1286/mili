'use client';

import { useEffect, useState } from 'react';
import type { StudyPack } from '@tokai/contracts';
import { api, errorText } from '@/lib/api';
import { ProductShell, StatusMessage } from './ProductShell';
import { StudyPackContent } from './StudyPackContent';

export function SharedPackPage({ token }: { token: string }) {
  const [pack, setPack] = useState<StudyPack>(), [error, setError] = useState('');
  useEffect(() => { let live = true; void api.publicShare(token).then(value => { if (live) setPack(value); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, [token]);
  return <ProductShell title={pack?.title || 'A shared idea.'} eyebrow="READ-ONLY STUDY PACK" description="A lesson shared with you. The owner chooses which notes and cards to include.">{error ? <StatusMessage error>{error} This link may have expired or been revoked.</StatusMessage> : pack ? <StudyPackContent pack={pack} includeCards/> : <p role="status">Opening the shared study pack…</p>}</ProductShell>;
}
