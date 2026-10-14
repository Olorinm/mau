import type { ReactNode } from 'react';
import { ItemList, ListDetailLayout, PageHeader } from './layout';
export interface SettingsSection { id: string; label: string; icon?: ReactNode; content: ReactNode }
export function SettingsLayout({ title, sections, selectedId, onSelect, empty }: {
  title: string; sections: readonly SettingsSection[]; selectedId?: string;
  onSelect(id: string | undefined): void; empty?: ReactNode;
}) {
  const selected = sections.find(section => section.id === selectedId);
  return <ListDetailLayout detailOpen={!!selected} onBack={() => onSelect(undefined)} empty={empty}
    list={<><PageHeader title={title} /><ItemList label={title} selectedId={selectedId} onSelect={onSelect}
      items={sections.map(section => ({ id: section.id, title: section.label, leading: section.icon }))} /></>}
    detail={selected ? <div className="af-settings-content"><PageHeader title={selected.label} />{selected.content}</div> : undefined} />;
}
