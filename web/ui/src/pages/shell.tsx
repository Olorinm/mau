import { type ReactNode } from "react";
import { useCompactLayout } from "./presentation/use-compact-layout";
import { DefaultScope } from "./scope";

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

export interface Destination {
  id: string;
  label: string;
  icon: ReactNode;
}

/**
 * The frame of the console: the mark, the destinations and the page.
 * In a wide window the mark is at the top left and the destinations stand under it, down the left edge. Pressing
 * the mark (an arrow while the capsule is pointed at) puts them away: it tucks behind the edge with its ears showing, and the page takes the width.
 * In a narrow one they are a capsule at the foot of the screen, which a page marked `data-app-page` puts away.
 */
export function AppShell({
  logo,
  label,
  destinations,
  selectedId,
  expandedId,
  dropTarget,
  collapsed,
  collapseLabel,
  onCollapse,
  onSelect,
  children,
  className = "",
}: {
  logo?: ReactNode;
  /** The accessible name of the destinations. */
  label: string;
  destinations: readonly Destination[];
  selectedId?: string;
  /** The destination that has opened something over the page (a list to choose from), when one has. */
  expandedId?: string;
  /** Whether something held over the destinations would be added to them if let go. */
  dropTarget?: boolean;
  /** Whether the destinations are put away in a wide window. */
  collapsed?: boolean;
  /** The accessible name of the mark as the button that puts the destinations away and brings them back. */
  collapseLabel?: string;
  /** Called with what `collapsed` should become. Without it the mark is not a button. */
  onCollapse?(collapsed: boolean): void;
  onSelect(id: string): void;
  children: ReactNode;
  className?: string;
}) {
  const compact = useCompactLayout();
  return (
    <DefaultScope>
      <div
        className={"app-shell react-app agent-app af-shell " + className}
        data-compact={compact ? "true" : "false"}
        data-collapsed={collapsed && !compact ? "true" : undefined}
      >
        <header className="app-topbar">
          {onCollapse ? (
            <button type="button" className="app-mark" aria-label={collapseLabel} title={collapseLabel}
              aria-expanded={!collapsed} onClick={() => onCollapse(!collapsed)}>
              <span className="app-mark-logo">{logo}</span>
              <svg className="app-mark-arrow" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5.5 6.5 10l4.5 4.5M15 5.5 10.5 10l4.5 4.5" />
              </svg>
            </button>
          ) : (
            <span className="app-mark" aria-hidden="true">
              {logo}
            </span>
          )}
          <nav className="app-switch" aria-label={label} data-drop={dropTarget || undefined}>
            {destinations.map((item) => (
              <button
                key={item.id}
                type="button"
                className="app-switch-item"
                data-id={item.id}
                aria-current={item.id === selectedId ? "page" : undefined}
                aria-expanded={expandedId === undefined ? undefined : item.id === expandedId}
                title={item.label}
                onClick={() => onSelect(item.id)}
              >
                {item.icon}
                <span className="app-switch-label">{item.label}</span>
              </button>
            ))}
          </nav>
        </header>
        <main className="workspace af-workspace">{children}</main>
      </div>
    </DefaultScope>
  );
}
