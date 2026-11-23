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
 * In a wide window the destinations are a capsule in the middle of a row at the top, with the mark at its left.
 * In a narrow one they are a capsule at the foot of the screen, which a page marked `data-app-page` puts away.
 */
export function AppShell({
  logo,
  label,
  destinations,
  selectedId,
  onSelect,
  children,
  className = "",
}: {
  logo?: ReactNode;
  /** The accessible name of the destinations. */
  label: string;
  destinations: readonly Destination[];
  selectedId?: string;
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
      >
        <header className="app-topbar">
          <span className="app-mark" aria-hidden="true">
            {logo}
          </span>
          <nav className="app-switch" aria-label={label}>
            {destinations.map((item) => (
              <button
                key={item.id}
                type="button"
                className="app-switch-item"
                data-id={item.id}
                aria-current={item.id === selectedId ? "page" : undefined}
                title={item.label}
                onClick={() => onSelect(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </header>
        <main className="workspace af-workspace">{children}</main>
      </div>
    </DefaultScope>
  );
}
