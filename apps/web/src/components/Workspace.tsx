'use client';

import { LessonPlayer } from './course/LessonPlayer';

/** Legacy import alias — all lessons now render in the milli step-by-step LessonPlayer. */
export function Workspace({ id }: { id: string }) {
  return <LessonPlayer id={id} />;
}
