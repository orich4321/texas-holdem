import { CoachScreen } from '../coach-screen';

export default async function CoachPage({ params }: { params: Promise<{ joinId: string }> }) {
  const { joinId } = await params;
  return <CoachScreen joinId={joinId} />;
}
