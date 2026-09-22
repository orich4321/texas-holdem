export function ProfileImage({ dataUrl, className, fallback }: { dataUrl?: string | null; className: string; fallback: string }) {
  return <span className={className} aria-hidden="true" style={dataUrl ? { backgroundImage: `url(${dataUrl})` } : undefined}>{dataUrl ? null : fallback}</span>;
}
