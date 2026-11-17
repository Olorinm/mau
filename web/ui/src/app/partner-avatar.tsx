import { createContext, createElement, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { NameAvatar } from "./name-avatar.js";
import { PixelAvatar, type PixelAvatarSpecies, type PixelAvatarState } from "./pixel-avatar.js";

/**
 * How a partner is drawn: `pixel` is a pixel-art animal (the default), `illustrated` the Notionists
 * face. Both are derived from the same seed, so switching keeps every partner distinct.
 */
export type PartnerAvatarAppearance = "pixel" | "illustrated";
const PartnerAvatarAppearanceContext = createContext<PartnerAvatarAppearance>("pixel");

/** Sets the avatar appearance for every `PartnerAvatar` below it that does not choose its own. */
export function PartnerAvatarAppearanceProvider(props: { appearance: PartnerAvatarAppearance; children?: ReactNode }) {
  return createElement(PartnerAvatarAppearanceContext.Provider, { value: props.appearance }, props.children);
}

export function usePartnerAvatarAppearance(): PartnerAvatarAppearance {
  return useContext(PartnerAvatarAppearanceContext);
}

/**
 * 伙伴头像：seed（通常用伙伴 id）确定性生成 Notionists 插画脸。
 * 本地纯函数生成，无网络请求；同一 seed 永远同脸，换 seed 即换脸。
 * 用 img 加载 SVG data URI，让每个头像拥有独立 SVG 文档，避免 mask id 串台。
 */
const PARTNER_AVATAR_CACHE_LIMIT = 128;
const partnerAvatarDataUriCache = new Map<string, string>();
const pendingPartnerAvatarDataUris = new Map<string, Promise<string>>();
let partnerAvatarGeneratorPromise: Promise<(seed: string) => string> | undefined;

/**
 * 同一个逻辑伙伴可能同时存在“全局定义”和“App/会话绑定”，两者的 member id
 * 可以不同，但 partnerDefinitionId 相同。头像必须优先使用逻辑定义 id，
 * 才能保证通讯录、聊天、标题栏和 App 内嵌聊天显示同一张脸。
 */
export function partnerAvatarSeedForMember(member: { id: string; partnerDefinitionId?: string }): string {
  return member.partnerDefinitionId?.trim() || member.id.trim() || "agent";
}

export async function partnerAvatarDataUri(seed: string): Promise<string> {
  const normalizedSeed = seed.trim() || "agent";
  const cached = readCachedPartnerAvatar(normalizedSeed);
  if (cached) return cached;
  const pending = pendingPartnerAvatarDataUris.get(normalizedSeed);
  if (pending) return pending;
  const generation = loadPartnerAvatarGenerator()
    .then((generate) => {
      const dataUri = generate(normalizedSeed);
      cachePartnerAvatar(normalizedSeed, dataUri);
      return dataUri;
    })
    .finally(() => pendingPartnerAvatarDataUris.delete(normalizedSeed));
  pendingPartnerAvatarDataUris.set(normalizedSeed, generation);
  return generation;
}

export function usePartnerAvatarDataUri(seed: string, enabled = true): string {
  const normalizedSeed = seed.trim() || "agent";
  const [src, setSrc] = useState(() => (enabled ? (readCachedPartnerAvatar(normalizedSeed) ?? "") : ""));

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setSrc("");
      return () => {
        cancelled = true;
      };
    }
    const cached = readCachedPartnerAvatar(normalizedSeed);
    if (cached) {
      setSrc(cached);
      return () => {
        cancelled = true;
      };
    }
    setSrc("");
    void partnerAvatarDataUri(normalizedSeed)
      .then((dataUri) => {
        if (!cancelled) setSrc(dataUri);
      })
      .catch(() => {
        // NameAvatar remains visible when the optional generated asset fails.
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedSeed]);

  return src;
}

export function PartnerAvatar(props: {
  seed: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  fallbackName?: string;
  /** Defaults to the nearest `PartnerAvatarAppearanceProvider`, or `pixel`. */
  appearance?: PartnerAvatarAppearance;
  /** Pixel appearance only: the partner's state, shown by the eyes. */
  state?: PixelAvatarState;
  /** Pixel appearance only: a chosen animal instead of the one the seed picks. */
  species?: PixelAvatarSpecies;
  /** Pixel appearance only: hover and press motion (on by default). */
  animated?: boolean;
}) {
  const size = props.size ?? 32;
  const inherited = usePartnerAvatarAppearance();
  const appearance = props.appearance ?? inherited;
  const src = usePartnerAvatarDataUri(props.seed, appearance === "illustrated");
  if (appearance === "pixel")
    return (
      <PixelAvatar seed={props.seed} size={size} className={props.className} style={props.style} title={props.title}
        state={props.state} species={props.species} animated={props.animated} />
    );

  const style: CSSProperties = {
    display: "block",
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    background: "var(--c-surface-hover)",
    objectFit: "cover",
    ...props.style,
  };

  return (
    <NameAvatar
      name={props.fallbackName || props.seed}
      value={props.seed}
      src={src}
      size={size}
      className={props.className}
      title={props.title}
      style={style}
    />
  );
}

async function loadPartnerAvatarGenerator(): Promise<(seed: string) => string> {
  if (!partnerAvatarGeneratorPromise) {
    partnerAvatarGeneratorPromise = import("./partner-avatar-notionists.js")
      .then((module) => module.generatePartnerAvatarDataUri)
      .catch((error) => {
        partnerAvatarGeneratorPromise = undefined;
        throw error;
      });
  }
  return partnerAvatarGeneratorPromise;
}

function readCachedPartnerAvatar(seed: string): string | undefined {
  const cached = partnerAvatarDataUriCache.get(seed);
  if (!cached) return undefined;
  partnerAvatarDataUriCache.delete(seed);
  partnerAvatarDataUriCache.set(seed, cached);
  return cached;
}

function cachePartnerAvatar(seed: string, dataUri: string) {
  partnerAvatarDataUriCache.delete(seed);
  partnerAvatarDataUriCache.set(seed, dataUri);
  while (partnerAvatarDataUriCache.size > PARTNER_AVATAR_CACHE_LIMIT) {
    const oldestSeed = partnerAvatarDataUriCache.keys().next().value;
    if (typeof oldestSeed !== "string") break;
    partnerAvatarDataUriCache.delete(oldestSeed);
  }
}
