import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useFrontendLabels } from './provider';

export interface ListItem {
  id: string; title: ReactNode; description?: ReactNode; leading?: ReactNode;
  trailing?: ReactNode; disabled?: boolean;
}
export function ItemList({ items, selectedId, onSelect, label, empty }: {
  items: readonly ListItem[]; selectedId?: string; onSelect(id: string): void;
  label: string; empty?: ReactNode;
}) {
  return <div className="af-item-list" aria-label={label}>
    {items.length ? items.map(item => <button key={item.id} type="button" className="af-list-item"
      aria-current={item.id === selectedId ? 'true' : undefined} disabled={item.disabled} onClick={() => onSelect(item.id)}>
      {item.leading ? <span className="af-list-leading">{item.leading}</span> : null}
      <span className="af-list-copy"><strong>{item.title}</strong>{item.description ? <small>{item.description}</small> : null}</span>
      {item.trailing ? <span className="af-list-trailing">{item.trailing}</span> : null}
    </button>) : empty}
  </div>;
}
/** Caller-controlled selection also determines which panel appears on small screens. */
export function ListDetailLayout({ list, detail, detailOpen, onBack, backLabel, empty }: {
  list: ReactNode; detail?: ReactNode; detailOpen: boolean; onBack(): void;
  backLabel?: string; empty?: ReactNode;
}) {
  const { t } = useFrontendLabels();
  return <div className="af-list-detail rooms-view" data-detail-open={detailOpen}>
    <section className="af-list-panel rooms-list-panel">{list}</section>
    <section className="af-detail-panel room-main-panel">
      {detailOpen ? <><button type="button" className="af-compact-back" onClick={onBack}>
        <ChevronLeft size={16} />{backLabel ?? t('back')}</button>{detail}</> : empty}
    </section>
  </div>;
}
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <header className="af-page-header"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{actions}</header>;
}
export function DetailPanel({ title, description, avatar, actions, children }: {
  title: ReactNode; description?: ReactNode; avatar?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return <><header className="room-header"><div className="room-header-main">{avatar}<div className="room-header-copy">
    <h2>{title}</h2>{description ? <p>{description}</p> : null}</div></div>{actions}</header><div className="af-detail-body">{children}</div></>;
}
