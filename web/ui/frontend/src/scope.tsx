import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PortalProvider } from "@olorinm/agent-ui/app";

export type FrontendTheme = "light" | "dark" | "system";
const Scoped = createContext(false);

/** A layout-transparent boundary; it never writes to document or product storage. */
export function FrontendScope({
  children,
  theme = "system",
  style,
}: {
  children: ReactNode;
  theme?: FrontendTheme;
  style?: CSSProperties;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return (
    <div
      className="af-scope"
      data-theme={theme}
      data-resolved-theme={resolved}
      style={{ display: "contents", ...style }}
    >
      <Scoped.Provider value>
        <PortalProvider container={container}>{children}</PortalProvider>
      </Scoped.Provider>
      <div
        ref={setContainer}
        data-frontend-portals=""
        style={{ display: "contents" }}
      />
    </div>
  );
}

/** Standalone application/auth surfaces keep their defaults without extra setup. */
export function DefaultScope({ children }: { children: ReactNode }) {
  return useContext(Scoped) ? (
    children
  ) : (
    <FrontendScope>{children}</FrontendScope>
  );
}
