import HistoryGame from './history-game';

export default async function HistoryGamePage({ params }: Readonly<{ params: Promise<{ joinId: string }> }>) {
  const { joinId } = await params;
  return <HistoryGame joinId={joinId} />;
}
