'use client';

import { useId, useState } from 'react';
import { ProfileImage } from './profile-image';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 48 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Invalid image')); };
    image.src = url;
  });
}

async function prepareAvatar(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > MAX_SOURCE_BYTES) throw new Error('Invalid image');
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = (image.naturalWidth - sourceSize) / 2;
  const sourceY = (image.naturalHeight - sourceSize) / 2;
  for (const [size, quality] of [[128, 0.78], [112, 0.65], [96, 0.55]] as const) {
    canvas.width = size;
    canvas.height = size;
    context.fillStyle = '#10251d';
    context.fillRect(0, 0, size, size);
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const decodedBytes = Math.floor(encoded.length * 3 / 4);
    if (decodedBytes <= MAX_AVATAR_BYTES) return dataUrl;
  }
  throw new Error('Image remained too large');
}

export function AvatarPicker({ value, onChange, disabled = false }: { value?: string; onChange: (value?: string) => void; disabled?: boolean }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const avatar = await prepareAvatar(file);
      onChange(avatar);
    } catch {
      setError('בחרו תמונת JPG, PNG או WebP בגודל של עד 10MB.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="avatar-picker">
    <ProfileImage className="avatar-picker-preview" dataUrl={value} fallback="♠" />
    <div><label htmlFor={inputId}>{value ? 'החלפת תמונת פרופיל' : 'הוספת תמונת פרופיל'}</label><small>{busy ? 'מכינים את התמונה…' : 'אופציונלי · התמונה תופיע לידכם בשולחן'}</small></div>
    <input id={inputId} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
    {value ? <button type="button" disabled={disabled || busy} onClick={() => onChange(undefined)}>הסרה</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
