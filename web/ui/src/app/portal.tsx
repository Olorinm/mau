import { createContext, useContext, type ReactNode } from "react";

const PortalContainer = createContext<HTMLElement | null | undefined>(undefined);

/** Keep overlays in the embedding application's theme and style boundary. */
export function PortalProvider({ container, children }: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return <PortalContainer.Provider value={container}>{children}</PortalContainer.Provider>;
}

export function usePortalContainer() {
  return useContext(PortalContainer);
}
