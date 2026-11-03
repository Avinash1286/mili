import { SharedPackPage } from '@/components/product/SharedPackPage';
export default async function SharedLessonPage({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <SharedPackPage token={token}/>; }
