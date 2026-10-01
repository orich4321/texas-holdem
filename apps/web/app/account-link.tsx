'use client';

import { useEffect, useState } from 'react';
import { loadAccount, profilePath } from './account-api';
import { ProfileImage } from './profile-image';

export function AccountLink({ next, className = 'table-profile-button' }: { next: string; className?: string }) {
  const [avatar, setAvatar] = useState<string | null>();
  useEffect(() => {
    void loadAccount().then((account) => {
      if (account.enabled && account.profile?.displayName) setAvatar(account.profile.avatarDataUrl);
    }).catch(() => undefined);
  }, []);
  if (avatar === undefined) return null;
  return <a className={className} href={profilePath(next)} aria-label="הגדרות הפרופיל שלי" title="הגדרות הפרופיל שלי"><ProfileImage className="account-link-avatar" dataUrl={avatar} fallback="♙" /></a>;
}
