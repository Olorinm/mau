import { createContext, useContext, type KeyboardEvent, type ReactNode } from "react";

/**
 * What opens a partner named in a run's activity, by its name; nothing for a name the caller does not know.
 * Navigation belongs to the caller.
 */
export type PartnerLinkResolver = (name: string) => (() => void) | undefined;
const none: PartnerLinkResolver = () => undefined;
const Context = createContext<PartnerLinkResolver>(none);
export const PartnerLinkProvider = Context.Provider;

/** The figure of a partner named in a run's activity, by its name; nothing for a name the caller does not know. */
export type PartnerFigureResolver = (name: string) => ReactNode | undefined;
const FigureContext = createContext<PartnerFigureResolver>(() => undefined);
export const PartnerFigureProvider = FigureContext.Provider;

/** The icon of a row about a partner: that partner's figure where the caller has one, the row's own icon otherwise. */
export function PartnerFigure({ name, children }: { name: string; children: ReactNode }) {
  return <>{useContext(FigureContext)(name) ?? children}</>;
}

/** A partner's name in an activity row: a link in the row's own link style when the caller can open it, text otherwise. */
export function PartnerLink({ name }: { name: string }) {
  const open = useContext(Context)(name);
  if (!open) return <>{name}</>;
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  };
  return (
    <span className="thread-activity-edit-file" role="button" tabIndex={0} data-partner={name} onClick={open} onKeyDown={onKeyDown}>
      {name}
    </span>
  );
}
