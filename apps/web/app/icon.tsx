import { ImageResponse } from 'next/og';
import { IconArt } from './icon-art';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<IconArt pixels={64} />, size);
}
