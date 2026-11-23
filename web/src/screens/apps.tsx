import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { ProductIcon } from "@olorinm/agent-ui/app";
import type { AppSummary } from "../api/client";

/** How many apps can stand among the destinations, beside the conversations and the list of all apps. */
export const maxPinned = 3;
const storageKey = "mau.pinnedApps";
const listeners = new Set<() => void>();
let stored: readonly string[] = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
})();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The apps the owner keeps among the destinations. The choice belongs to this browser. */
export function usePinnedApps(apps: readonly AppSummary[]) {
  const ids = useSyncExternalStore(subscribe, () => stored);
  const pinned = ids.flatMap((id) => apps.find((app) => app.id === id) ?? []).slice(0, maxPinned);
  const isPinned = (id: string) => pinned.some((app) => app.id === id);
  return {
    pinned,
    isPinned,
    /** Whether `id` can be pinned or unpinned now. */
    canToggle: (id: string) => isPinned(id) || pinned.length < maxPinned,
    toggle(id: string) {
      if (!isPinned(id) && pinned.length >= maxPinned) return;
      stored = isPinned(id) ? pinned.flatMap((app) => app.id === id ? [] : app.id) : [...pinned.map((app) => app.id), id];
      try { localStorage.setItem(storageKey, JSON.stringify(stored)); } catch { /* kept for this page only */ }
      for (const listener of listeners) listener();
    },
  };
}
export type PinnedApps = ReturnType<typeof usePinnedApps>;

/** An app opens beside the console, in a tab of its own. */
export const openApp = (app: AppSummary) => { window.open(app.url, "_blank", "noopener"); };

// Names that differ by one character get colours far apart.
const hue = (text: string) => { let sum = 0; for (const char of text) sum = (sum * 31 + char.codePointAt(0)!) % 9973; return Math.round(sum * 137.508) % 360; };
/** An app's icon, or its name's first letter on a colour of its own. */
export function AppMark({ app, size }: { app: AppSummary; size: number }) {
  return app.icon
    ? <img className="mau-app-mark" src={app.icon} alt="" width={size} height={size} draggable={false} />
    : <span className="mau-app-mark" aria-hidden="true"
        style={{ width: size, height: size, fontSize: size * 0.42, background: `oklch(60% 0.13 ${hue(app.id)})` }}>{[...app.name][0]}</span>;
}

const pin = <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 2l8 8-4 1-3 3 1 5-2 2-5-5-6 6v-2l5-6-5-5 2-2 5 1 3-3z" /></svg>;
type Labels = { title: string; pinned(count: number): string; pin: string; unpin: string; create: string; hint: string };

/**
 * All of the owner's apps, opened from the apps destination.
 * In a wide window they are a grid under the destinations, each with its pin.
 * On a narrow screen they are a dial above the destinations: a drag turns it, a press opens an app, and a held app
 * can be carried onto the destinations to pin it. The app in the middle has its name and its pin under it.
 */
export function AppLauncher({ apps, pins, compact, labels, onClose, onCreate, onDropping }: {
  apps: readonly AppSummary[]; pins: PinnedApps; compact: boolean; labels: Labels;
  onClose(): void; onCreate(): void;
  /** Whether a held app is over the destinations, where letting go pins it. */
  onDropping(over: boolean): void;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const open = (app: AppSummary) => { onClose(); openApp(app); };
  const pinButton = (app: AppSummary, className: string, text?: boolean) => {
    const on = pins.isPinned(app.id), label = on ? labels.unpin : labels.pin;
    return <button type="button" className={className} aria-pressed={on} disabled={!pins.canToggle(app.id)}
      aria-label={`${label} · ${app.name}`} title={label} onClick={() => pins.toggle(app.id)}>{pin}{text ? <span>{label}</span> : null}</button>;
  };
  return <>
    <div className="mau-apps-veil" onClick={onClose} />
    {compact
      ? <AppDial apps={apps} pins={pins} labels={labels} onOpen={open} onCreate={() => { onClose(); onCreate(); }} onDropping={onDropping} pinButton={pinButton} />
      : <section className="mau-apps-grid" role="dialog" aria-label={labels.title}>
        <header><strong>{labels.title}</strong><small>{labels.pinned(pins.pinned.length)}</small></header>
        <div className="mau-apps-tiles">
          {apps.map((app) => <div key={app.id} className="mau-app-tile" data-app={app.id}>
            <button type="button" className="mau-app-open" onClick={() => open(app)}><AppMark app={app} size={48} /><span>{app.name}</span></button>
            {pinButton(app, "mau-app-pin")}
          </div>)}
          <div className="mau-app-tile">
            <button type="button" className="mau-app-open" onClick={() => { onClose(); onCreate(); }}>
              <span className="mau-app-mark mau-app-add" style={{ width: 48, height: 48 }}><ProductIcon name="add" /></span><span>{labels.create}</span>
            </button>
          </div>
        </div>
      </section>}
  </>;
}

const step = 13.5 * Math.PI / 180, radius = 270, holdMs = 420;
function AppDial({ apps, pins, labels, onOpen, onCreate, onDropping, pinButton }: {
  apps: readonly AppSummary[]; pins: PinnedApps; labels: Labels; onOpen(app: AppSummary): void; onCreate(): void;
  onDropping(over: boolean): void; pinButton(app: AppSummary, className: string, text?: boolean): React.ReactNode;
}) {
  const last = Math.max(0, apps.length - 1);
  // Which app is in the middle; between two of them while the dial is being turned.
  const [turn, setTurn] = useState(Math.min(last, 2));
  // The app that is being carried, and how far from where it was picked up.
  const [carried, setCarried] = useState<{ id: string; x: number; y: number }>();
  const gesture = useRef<{ x: number; y: number; turn: number; id: string | undefined; moved: boolean; hold: ReturnType<typeof setTimeout> | undefined; carrying: boolean }>(undefined);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clamp = (value: number) => Math.max(0, Math.min(last, value));
  const middle = apps[Math.round(clamp(turn))];
  const overDock = (event: { clientX: number; clientY: number }) => {
    const box = document.querySelector(".app-switch")?.getBoundingClientRect();
    return !!box && event.clientY > box.top - 16 && event.clientX > box.left - 16 && event.clientX < box.right + 16;
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    const id = (event.target as Element).closest<HTMLElement>("[data-app]")?.dataset.app;
    const state = { x: event.clientX, y: event.clientY, turn, id, moved: false, carrying: false,
      hold: id ? setTimeout(() => { state.carrying = true; setCarried({ id, x: 0, y: 0 }); }, holdMs) : undefined };
    gesture.current = state;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (state.carrying && state.id) {
      setCarried({ id: state.id, x: dx, y: dy });
      onDropping(overDock(event) && pins.canToggle(state.id) && !pins.isPinned(state.id));
      return;
    }
    if (!state.moved && Math.hypot(dx, dy) < 6) return;
    state.moved = true;
    clearTimeout(state.hold);
    setTurn(clamp(state.turn - dx / 64));
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    gesture.current = undefined;
    if (!state) return;
    clearTimeout(state.hold);
    if (state.carrying && state.id) {
      // Let go over the destinations: the app is pinned there. Anywhere else it goes back.
      if (overDock(event) && !pins.isPinned(state.id) && pins.canToggle(state.id)) pins.toggle(state.id);
      setCarried(undefined);
      onDropping(false);
    } else if (state.moved) setTurn((value) => Math.round(value));
    else { const app = apps.find((item) => item.id === state.id); if (app) onOpen(app); }
  };
  return (
    <section className="mau-apps-dial" role="dialog" aria-label={labels.title}>
      <div className="mau-dial-middle">
        {middle ? <><strong>{middle.name}</strong>{pinButton(middle, "mau-dial-pin", true)}</> : null}
        <button type="button" className="mau-dial-create" onClick={onCreate}><ProductIcon name="add" size={14} /><span>{labels.create}</span></button>
      </div>
      <div className="mau-dial-track" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onWheel={(event) => { setTurn((value) => clamp(value + (event.deltaX || event.deltaY) / 90));
          clearTimeout(settle.current); settle.current = setTimeout(() => setTurn((value) => Math.round(value)), 160); }}>
        {apps.map((app, index) => {
          const off = index - turn, away = Math.abs(off);
          if (away > 3.1) return null;
          const lifted = carried?.id === app.id;
          return <button key={app.id} type="button" className="mau-dial-app" data-app={app.id} data-middle={away < 0.5 || undefined}
            data-carried={lifted || undefined} aria-label={app.name} onFocus={() => setTurn(index)}
            // A press is the track's: it tells a tap from a turn. The keyboard opens the app here.
            onClick={(event) => { if (event.detail === 0) onOpen(app); }}
            style={{ translate: `${radius * Math.sin(off * step) + (lifted ? carried.x : 0)}px ${radius * (1 - Math.cos(off * step)) + (lifted ? carried.y : 0)}px`,
              scale: String(lifted ? 1.2 : Math.max(0.5, 1.22 - 0.2 * away)) }}>
            <AppMark app={app} size={52} />
            {pins.isPinned(app.id) ? <span className="mau-dial-pinned">{pin}</span> : null}
          </button>;
        })}
      </div>
      <p className="mau-dial-hint">{labels.hint} · {labels.pinned(pins.pinned.length)}</p>
    </section>
  );
}
