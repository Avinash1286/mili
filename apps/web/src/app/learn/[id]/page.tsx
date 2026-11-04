import { LessonPlayer } from '@/components/course/LessonPlayer';
export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <LessonPlayer id={id} />; }
