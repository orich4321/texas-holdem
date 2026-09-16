import LobbyClient from '../lobby-client';

/**
 * Hosts reach a distinct route after opening a room. The server, rather than
 * this pathname, verifies the host's httpOnly player session for every action.
 */
export default async function HostRoomPage({
  params,
}: Readonly<{ params: Promise<{ joinId: string }> }>) {
  const { joinId } = await params;
  return <LobbyClient joinId={joinId} />;
}
