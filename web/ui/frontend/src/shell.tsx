import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
  type CSSProperties,
  type ComponentProps,
} from "react";
import { AppRail } from "./presentation/app-rail";
import { AppNavigationPanel } from "./presentation/app-navigation-panel";
import { AppTitlebar } from "./presentation/app-titlebar";
import { useAppRailLayout } from "./presentation/use-app-rail-layout";
import { useCompactLayout } from "./presentation/use-compact-layout";
const RailContext = createContext(true);
const CloseNavigation = createContext(() => {});
export interface NavigationItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}
export interface NavigationGroup {
  id: string;
  label?: string;
  compactLabel?: string;
  items: readonly NavigationItem[];
}
export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

export function Navigation({
  items = [],
  groups,
  ...props
}: Omit<ComponentProps<typeof AppRail>, "expanded" | "groups"> & {
  items?: readonly NavigationItem[];
  groups?: readonly NavigationGroup[];
}) {
  const expanded = useContext(RailContext);
  const close = useContext(CloseNavigation);
  return (
    <AppRail
      {...props}
      onSelect={(id) => {
        props.onSelect(id);
        close();
      }}
      expanded={expanded}
      groups={groups ?? [{ id: "navigation", items }]}
    />
  );
}
/** Composition of original titlebar, rail controller and navigation panel. */
export function AppShell({
  brand,
  logo,
  navigation,
  toolbar,
  children,
  className = "",
  initialNavigationWidth = 126,
  navigationWidth,
  onNavigationWidthChange,
}: {
  brand: ReactNode;
  logo?: ReactNode;
  navigation?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  initialNavigationWidth?: number;
  navigationWidth?: number;
  onNavigationWidthChange?(width: number): void;
}) {
  const railLayout = useAppRailLayout(
    initialNavigationWidth,
    navigationWidth,
    onNavigationWidthChange,
  );
  const compact = useCompactLayout();
  const id = useId();
  const toggleId = id + "-toggle";
  const navigationId = id + "-navigation";
  const [compactOpen, setCompactOpen] = useState(false);
  useEffect(() => setCompactOpen(false), [compact]);
  return (
    <div
      className={"app-shell react-app agent-app af-shell " + className}
      data-compact={compact ? "true" : "false"}
      style={
        {
          "--af-rail-width":
            navigation && !compact ? railLayout.width + "px" : "0px",
          "--opengrove-rail-width": railLayout.width + "px",
        } as CSSProperties
      }
    >
      <AppTitlebar
        brand={brand}
        logo={logo}
        toolbar={toolbar}
        toggleId={toggleId}
        navigationId={navigationId}
        railVisible={compact ? compactOpen : railLayout.mode !== "hidden"}
        onToggleRail={
          navigation
            ? () =>
                compact ? setCompactOpen((open) => !open) : railLayout.toggle()
            : undefined
        }
      />
      {navigation ? (
        <AppNavigationPanel
          toggleId={toggleId}
          navigationId={navigationId}
          layout={railLayout}
          overlayOpen={false}
          compact={compact}
          compactOpen={compactOpen}
          onCompactOpenChange={setCompactOpen}
        >
          {(expanded) => (
            <CloseNavigation.Provider value={() => setCompactOpen(false)}>
              <RailContext.Provider value={expanded}>
                {navigation}
              </RailContext.Provider>
            </CloseNavigation.Provider>
          )}
        </AppNavigationPanel>
      ) : null}
      <main className="workspace af-workspace">{children}</main>
    </div>
  );
}
