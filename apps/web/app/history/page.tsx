import Link from 'next/link';
import { AppBrand } from '../ui';
import { HistoryList } from './history-list';

export default function HistoryPage() {
  return <main className="history-shell">
    <header className="history-topbar"><Link href="/"><AppBrand compact /></Link><Link href="/profile">הפרופיל שלי</Link></header>
    <section className="history-panel"><HistoryList /></section>
  </main>;
}
