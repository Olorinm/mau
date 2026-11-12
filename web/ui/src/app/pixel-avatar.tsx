import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement } from "react";
import clsx from "clsx";

/**
 * Pixel-art animal avatars. A seed (usually the agent id) always resolves to the same animal and
 * colour. The figure is an inline SVG on a 10×10 grid, so it stays crisp at any size and needs no
 * network request.
 *
 * The eyes carry the state: open when idle, looking aside while working, closed and greyed out when
 * offline. The figure only moves on hover (or when its surrounding control is hovered) and bounces
 * once when that control is pressed.
 */
export type PixelAvatarState = "idle" | "working" | "offline";

interface Species {
  /** Ten rows of ten cells: `X` body, `o` body shade, `w` body tint, `k` dark, `t` orange, `p` pink, `.` empty. */
  rows: readonly string[];
  /** Body colours this animal may take; the seed picks one. */
  colors: readonly string[];
  /** Top-left cell of each eye (1×2 cells); the default sits on rows 5–6. */
  eyes?: readonly (readonly [number, number])[];
  eyeColor?: string;
}

const pink = "oklch(74% 0.16 5)", blue = "oklch(70% 0.14 250)", yellow = "oklch(84% 0.15 90)", orange = "oklch(72% 0.17 45)";
const teal = "oklch(76% 0.14 165)", brown = "oklch(66% 0.1 55)", purple = "oklch(74% 0.12 300)", cyan = "oklch(70% 0.14 210)";
const red = "oklch(66% 0.19 25)", green = "oklch(74% 0.16 145)", grey = "oklch(74% 0.012 260)", tan = "oklch(78% 0.09 75)";

const SPECIES = {
  cat: { rows: [".X......X.", ".XX....XX.", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXXXXXXX.", "..XX..XX.."], colors: [yellow, orange, grey, purple] },
  dog: { rows: ["..XXXXXX..", "ooXXXXXXoo", "ooXXXXXXoo", "ooXXXXXXoo", "oXXXXXXXXo", ".XXXXXXXX.", ".XXXXXXXX.", ".XXXkkXXX.", ".XXwwwwXX.", "..XXXXXX.."], colors: [tan, brown, grey], eyes: [[3, 4.6], [6, 4.6]] },
  bunny: { rows: [".XX....XX.", ".Xp....pX.", ".Xp....pX.", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXX..XXX."], colors: [purple, grey, blue, tan] },
  bear: { rows: [".XX....XX.", "XooX..XooX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXwkkwXXX", ".XXwwwwXX.", "..XXXXXX.."], colors: [brown, tan, teal], eyes: [[3, 4.4], [6, 4.4]] },
  fox: { rows: ["X........X", "XX......XX", "XXX....XXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "wwXXXXXXww", ".wwwXXwww.", "..wwkkww.."], colors: [orange, red] },
  pig: { rows: [".XX....XX.", ".XXX..XXX.", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXooooXXX", "XXXooooXXX", ".XXXXXXXX.", "..XX..XX.."], colors: ["oklch(82% 0.09 0)"], eyes: [[3, 4], [6, 4]] },
  mouse: { rows: ["XXX....XXX", "XpXX..XXpX", "XXXXXXXXXX", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXppXXXX", ".XXXXXXXX.", "..XXXXXX.."], colors: [grey, tan, blue] },
  panda: { rows: [".kk....kk.", "kkkXXXXkkk", ".XXXXXXXX.", "XXXXXXXXXX", "XXkkXXkkXX", "XXkkXXkkXX", "XXkkXXkkXX", "XXXXkkXXXX", ".XXXXXXXX.", "..XXXXXX.."], colors: ["oklch(91% 0.004 260)"], eyes: [[3, 4.5], [6, 4.5]], eyeColor: "#fff" },
  frog: { rows: [".XX....XX.", "XXXX..XXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XooooooooX", "XXXXXXXXXX", ".XXXXXXXX.", "XX.XXXX.XX"], colors: [green, teal], eyes: [[1.5, 0.5], [7.5, 0.5]] },
  chick: { rows: ["....XX....", "...XXXX...", "..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXttXXXX", ".XXXXXXXX.", "..tt..tt.."], colors: ["oklch(87% 0.15 97)"] },
  penguin: { rows: ["...XXXX...", "..XXXXXX..", ".XXXXXXXX.", ".XXXXXXXX.", "XXXwwwwXXX", "XXwwwwwwXX", "XXwwwwwwXX", "XXwwttwwXX", ".XwwwwwwX.", "..tt..tt.."], colors: ["oklch(40% 0.04 260)"] },
  owl: { rows: ["X........X", "XX......XX", "XXXXXXXXXX", "XXXXXXXXXX", "XwwwXXwwwX", "XwwwXXwwwX", "XwwwttwwwX", "XXXXttXXXX", ".XXXXXXXX.", "..XX..XX.."], colors: ["oklch(60% 0.08 60)", purple], eyes: [[2, 4.4], [7, 4.4]] },
  bee: { rows: ["..k....k..", "...k..k...", "..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "kkkkkkkkkk", ".XXXXXXXX.", "..kkkkkk.."], colors: ["oklch(86% 0.16 95)"] },
  crab: { rows: ["XX......XX", "X.X....X.X", "XXX....XXX", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXXXXXXX.", "X.X.XX.X.X"], colors: [red, orange] },
  octopus: { rows: ["..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "X.X.XX.X.X", "X.X.XX.X.X"], colors: ["oklch(68% 0.15 315)", pink, cyan] },
  ghost: { rows: ["...XXXX...", ".XXXXXXXX.", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "X.XX.XX.XX"], colors: [blue, purple, teal, pink] },
  sprout: { rows: ["....XX.X..", ".....XX...", "..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXXXXXXX.", "..XXXXXX.."], colors: [pink, green, yellow, cyan] },
  robot: { rows: ["..X....X..", "...X..X...", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XX....XX."], colors: [orange, blue, grey, teal] },
  bean: { rows: ["....XX....", "....XX....", "..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXXXXXXX.", ".XX....XX."], colors: [teal, pink, purple, yellow] },
  drop: { rows: ["....XX....", "...XXXX...", "..XXXXXX..", ".XXXXXXXX.", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", "XXXXXXXXXX", ".XXXXXXXX.", "..XXXXXX.."], colors: [cyan, blue, red, green] },
} as const satisfies Record<string, Species>;

export type PixelAvatarSpecies = keyof typeof SPECIES;
export const PIXEL_AVATAR_SPECIES = Object.keys(SPECIES) as PixelAvatarSpecies[];

const cellClass: Record<string, string> = { X: "b", o: "o", w: "w", k: "k", t: "t", p: "p" };
const bodies = new Map<PixelAvatarSpecies, ReactElement[]>();
function body(species: PixelAvatarSpecies) {
  let cells = bodies.get(species);
  if (cells) return cells;
  cells = [];
  SPECIES[species].rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const cell = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === cell) end++;
      // Rows overlap by a hair so no seam shows between them at fractional sizes.
      if (cell !== ".") cells!.push(<rect key={`${x}-${y}`} className={cellClass[cell]} x={x} y={y} width={end - x} height={1.03} />);
      x = end;
    }
  });
  bodies.set(species, cells);
  return cells;
}

function hash(value: string) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/** The animal and body colour a seed resolves to. Pass `species` to keep a chosen animal and only derive its colour. */
export function pixelAvatarFor(seed: string, species?: PixelAvatarSpecies): { species: PixelAvatarSpecies; color: string } {
  const value = hash(seed.trim() || "agent");
  const resolved = species ?? PIXEL_AVATAR_SPECIES[value % PIXEL_AVATAR_SPECIES.length]!;
  const colors: readonly string[] = SPECIES[resolved].colors;
  return { species: resolved, color: colors[(value >>> 8) % colors.length]! };
}

const pressTargets = "button, a, [role='button'], [role='option'], [data-avatar-hover]";

export function PixelAvatar(props: {
  seed: string;
  /** Overrides the animal the seed would pick. */
  species?: PixelAvatarSpecies;
  size?: number;
  state?: PixelAvatarState;
  /** Hover and press motion; turn off where many avatars repeat, such as a message list. */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const size = props.size ?? 32, state = props.state ?? "idle", animated = props.animated ?? true;
  const { species, color } = useMemo(() => pixelAvatarFor(props.seed, props.species), [props.seed, props.species]);
  const definition: Species = SPECIES[species];
  const eyes = definition.eyes ?? [[3, 5], [6, 5]];
  const root = useRef<HTMLSpanElement>(null);
  // A press on the surrounding control bounces the figure once.
  useEffect(() => {
    const element = root.current, target = element?.closest<HTMLElement>(pressTargets) ?? element;
    if (!animated || !element || !target) return;
    const bounce = () => {
      element.removeAttribute("data-bounce");
      void element.offsetWidth;
      element.setAttribute("data-bounce", "");
    };
    const settle = (event: AnimationEvent) => { if (event.animationName === "agent-pixel-avatar-bounce") element.removeAttribute("data-bounce"); };
    target.addEventListener("pointerdown", bounce);
    element.addEventListener("animationend", settle);
    return () => { target.removeEventListener("pointerdown", bounce); element.removeEventListener("animationend", settle); };
  }, [animated]);
  return (
    <span ref={root} className={clsx("agent-pixel-avatar", props.className)} data-state={state} data-species={species}
      data-animated={animated ? "" : undefined} title={props.title}
      {...(props.title ? { role: "img", "aria-label": props.title } : { "aria-hidden": true })}
      style={{ width: size, height: size, "--pixel-avatar-color": color, ...props.style } as CSSProperties}>
      <svg viewBox="0 0 10 10" shapeRendering="crispEdges" focusable="false" aria-hidden="true">
        {body(species)}
        <g className="eyes" {...(definition.eyeColor ? { style: { fill: definition.eyeColor } } : {})}>
          {eyes.map(([x, y], index) => state === "offline"
            ? <rect key={index} x={x - 0.5} y={y + 1.1} width={2} height={0.8} />
            : <rect key={index} x={x} y={y} width={1} height={2} />)}
        </g>
      </svg>
    </span>
  );
}

/** A group shown as up to three of its members' figures stacked together. */
export function PixelAvatarGroup(props: { seeds: readonly string[]; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  const size = props.size ?? 32, seeds = props.seeds.slice(0, 3);
  const cell = Math.round(size * 0.56);
  const places: CSSProperties[] = seeds.length === 1 ? [{ left: (size - cell) / 2, top: (size - cell) / 2 }]
    : seeds.length === 2 ? [{ left: 0, top: (size - cell) / 2 }, { right: 0, top: (size - cell) / 2 }]
    : [{ left: (size - cell) / 2, top: 0 }, { left: 0, bottom: 0 }, { right: 0, bottom: 0 }];
  return (
    <span className={clsx("agent-pixel-avatar-group", props.className)} title={props.title}
      {...(props.title ? { role: "img", "aria-label": props.title } : { "aria-hidden": true })}
      style={{ width: size, height: size, ...props.style }}>
      {seeds.map((seed, index) => <PixelAvatar key={seed} seed={seed} size={cell} style={{ position: "absolute", ...places[index] }} />)}
    </span>
  );
}
