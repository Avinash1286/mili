'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, RefreshCw } from 'lucide-react';
import type { Identity, Session } from '@milli/contracts';
import { api, errorText } from '@/lib/api';
import { AppNav } from './AppNav';

export function CoursesPage() {
  const [courses, setCourses] = useState<Session[]>([]), [identity, setIdentity] = useState<Identity>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const [items, me] = await Promise.all([api.list(), api.me()]); setCourses(items); setIdentity(me.identity); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="courses-page"><AppNav identity={identity}/><main id="main" className="courses-wrap">
    <p className="eyebrow">YOUR LEARNING SPACE</p><div className="courses-heading"><div><h1>Courses</h1><p>Everything you have started with milli, in one place.</p></div><Link className="chunky-button small" href="/learn">Start a topic <ArrowRight size={16}/></Link></div>
    {error ? <div className="error-banner" role="alert"><p>{error}</p><button className="pill-button" onClick={() => void load()}><RefreshCw size={15}/> Try again</button></div> : loading ? <p className="courses-status" role="status">Loading your courses…</p> : courses.length ? <div className="courses-grid">{courses.map(course => <Link key={course.id} href={`/learn/${course.id}`} className="course-card"><div className="course-icon"><BookOpen size={21}/></div><div><p className="course-meta">{course.mode === 'live' ? 'Live tutor' : 'Guided demo'} · {course.archived ? 'Archived' : course.status === 'ended' ? 'Completed' : 'In progress'}</p><h2>{course.title}</h2><p className="course-date">Updated {new Date(course.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p></div><ArrowRight className="course-arrow" size={19}/></Link>)}</div> : <section className="courses-empty"><BookOpen size={28}/><h2>Your first course starts with a question.</h2><p>Type or say a topic, and milli will make a lesson around it.</p><Link className="chunky-button small" href="/learn">Choose a topic <ArrowRight size={16}/></Link></section>}
  </main></div>;
}
