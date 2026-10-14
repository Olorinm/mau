import { useId, useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useFrontendLabels } from './provider';

/** Supplied by the product; the package has no built-in routes. */
export interface NavigationItem {
  id: string; label: string; icon?: ReactNode; badge?: ReactNode; disabled?: boolean;
}
export function Navigation({ items, selectedId, onSelect, footer, label }: {
  items: readonly NavigationItem[]; selectedId?: string; onSelect(id: string): void;
  footer?: ReactNode; label?: string;
}) {
  const { t } = useFrontendLabels();
  return <nav className="af-navigation" aria-label={label ?? t('navigation')}>
    <div className="af-navigation-items">{items.map(item => <button key={item.id} type="button"
      className="af-nav-item" aria-current={item.id === selectedId ? 'page' : undefined}
      disabled={item.disabled} onClick={() => onSelect(item.id)}>
      {item.icon ? <span className="af-nav-icon" aria-hidden="true">{item.icon}</span> : null}
      <span>{item.label}</span>{item.badge ? <span className="af-nav-badge">{item.badge}</span> : null}
    </button>)}</div><div className="af-navigation-footer">{footer}</div>
  </nav>;
}
export function AppShell({ brand, logo, navigation, toolbar, children, className = '' }: {
  brand: ReactNode; logo?: ReactNode; navigation?: ReactNode; toolbar?: ReactNode;
  children: ReactNode; className?: string;
}) {
  const { t } = useFrontendLabels();
  const navigationId = useId();
  const [navigationOpen, setNavigationOpen] = useState(true);
  return <div className={`agent-app af-shell ${className}`} data-navigation-open={navigationOpen && !!navigation}>
    <header className="app-titlebar"><div className="app-titlebar-left">
      {navigation ? <button type="button" className="app-titlebar-control" aria-label={t('toggleNavigation')}
        aria-expanded={navigationOpen} aria-controls={navigationId} onClick={() => setNavigationOpen(open => !open)}>
        {navigationOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </button> : null}
      <span className="app-titlebar-brand"><span className="app-titlebar-brand-mark">{logo}</span>
        <span className="app-titlebar-brand-word">{brand}</span></span>
    </div><div className="app-titlebar-drag-space" /><div className="af-toolbar">{toolbar}</div></header>
    {navigation ? <aside id={navigationId} className="af-navigation-slot" hidden={!navigationOpen}>{navigation}</aside> : null}
    <main className="af-workspace">{children}</main>
  </div>;
}
