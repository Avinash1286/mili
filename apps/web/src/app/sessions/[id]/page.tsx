import { SessionPage } from '@/components/product/SessionPage';
export default async function SavedLessonPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <SessionPage sessionId={id}/>; }
