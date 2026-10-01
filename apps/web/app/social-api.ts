import { SERVER_URL } from './account-api';

export type SocialAccount = { id: string; username: string | null; displayName: string | null; avatarDataUrl: string | null };
export type SocialOverview = {
  friends: SocialAccount[];
  incoming: { id: string; from: SocialAccount }[];
  outgoing: { id: string; to: SocialAccount }[];
  invitations: { id: string; from: SocialAccount; joinId: string; roomStatus: string }[];
};

export async function loadSocial(): Promise<SocialOverview> {
  const response = await globalThis.fetch(`${SERVER_URL}/social`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Social unavailable');
  return await response.json() as SocialOverview;
}

export async function loadInvitations(): Promise<{ invitations: SocialOverview['invitations']; pendingFriendRequests: number }> {
  const response = await globalThis.fetch(`${SERVER_URL}/social/invitations`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Invitations unavailable');
  const payload = await response.json() as { invitations?: unknown; pendingFriendRequests?: unknown };
  if (!Array.isArray(payload.invitations) || !Number.isSafeInteger(payload.pendingFriendRequests)) throw new Error('Invalid invitations');
  return payload as { invitations: SocialOverview['invitations']; pendingFriendRequests: number };
}

export async function requestFriend(username: string): Promise<string> {
  const response = await globalThis.fetch(`${SERVER_URL}/social/friend-requests`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }),
  });
  if (response.ok) return 'בקשת החברות נשלחה.';
  if (response.status === 404) return 'לא מצאנו משתמש בשם הזה.';
  if (response.status === 409) return 'כבר קיימת חברות או בקשה ממתינה בין החשבונות.';
  throw new Error('Friend request failed');
}

export async function answerFriendRequest(id: string, accept: boolean): Promise<void> {
  const response = await globalThis.fetch(`${SERVER_URL}/social/friend-requests/${encodeURIComponent(id)}`, {
    method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept }),
  });
  if (!response.ok) throw new Error('Friend answer failed');
}

export async function removeFriend(id: string): Promise<void> {
  const response = await globalThis.fetch(`${SERVER_URL}/social/friends/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  if (!response.ok) throw new Error('Friend removal failed');
}

export async function inviteFriend(joinId: string, friendId: string): Promise<void> {
  const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/invites`, {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ friendId }),
  });
  if (!response.ok) throw new Error('Invite failed');
}

export async function answerGameInvite(id: string, accept: boolean): Promise<string | null> {
  const response = await globalThis.fetch(`${SERVER_URL}/social/invitations/${encodeURIComponent(id)}`, {
    method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept }),
  });
  if (!response.ok) throw new Error('Invite answer failed');
  const payload = await response.json() as { joinPath?: unknown };
  return typeof payload.joinPath === 'string' && /^\/r\/[a-f0-9]{16}$/i.test(payload.joinPath) ? payload.joinPath : null;
}
