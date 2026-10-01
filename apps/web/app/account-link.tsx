'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { loadAccount, profilePath } from './account-api';
import { ProfileImage } from './profile-image';

export function AccountLink({ next, className = 'table-profile-button' }: { next: string; className?: string }) {
  const [avatar, setAvatar] = useState<string | null>();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void loadAccount().then((account) => {
      if (account.enabled && account.profile?.displayName) setAvatar(account.profile.avatarDataUrl);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);
  if (avatar === undefined) return null;
  return <div className="account-menu-wrap" ref={menuRef}>
    <button type="button" className={className} aria-label="פתיחת תפריט הפרופיל" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ProfileImage className="account-link-avatar" dataUrl={avatar} fallback="♙" /></button>
    {open ? <nav className="account-menu" aria-label="תפריט הפרופיל">
      <a href={profilePath(next)}>עריכת שם ותמונה</a>
      <Link href="/history">היסטוריית משחקים וידיים</Link>
    </nav> : null}
  </div>;
}
