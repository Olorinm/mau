import type { ReactNode } from 'react';
export interface CatalogItem {
  id: string; title: ReactNode; description?: ReactNode; icon?: ReactNode; metadata?: ReactNode; actions?: ReactNode;
}
/** Apps, extensions, templates and tools can share this layout; operations stay with the caller. */
export function Catalog({ items, header, empty }: { items: readonly CatalogItem[]; header?: ReactNode; empty?: ReactNode }) {
  return <section className="af-catalog">{header}<div className="af-catalog-grid">
    {items.length ? items.map(item => <article className="af-catalog-card" key={item.id}>
      <div className="af-catalog-heading">{item.icon}<h3>{item.title}</h3></div>
      {item.description ? <p>{item.description}</p> : null}{item.metadata}<div className="af-catalog-actions">{item.actions}</div>
    </article>) : empty}
  </div></section>;
}
