import type { ReactNode } from 'react';

export function AppBrand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`app-brand${compact ? ' app-brand-compact' : ''}`}>
      <span className="app-brand-cards" aria-hidden="true">
        <i>♠</i><i>♥</i>
      </span>
      <span>
        <strong>HOLD&apos;EM</strong>
        <small>PRIVATE TABLE</small>
      </span>
    </span>
  );
}

export function IconBadge({ children }: { children: ReactNode }) {
  return <span className="icon-badge" aria-hidden="true">{children}</span>;
}

export function StateScreen({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <main className="state-screen">
      <section className="state-card">
        <span className="state-icon" aria-hidden="true">{icon}</span>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}
