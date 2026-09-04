import LobbyClient from './lobby-client';

export default async function RoomPage({
  params,
}: Readonly<{ params: Promise<{ joinId: string }> }>) {
  const { joinId } = await params;
  return <LobbyClient joinId={joinId} />;
}
