// Extracted from web/src/bridge-settings-types.ts at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import type { TranslationFn } from "./i18n";
export interface KernelProxySettings {
  enabled: boolean;
  injected?: boolean;
  proxyUrl: string;
  noProxy: string;
  nodeUseEnvProxy: boolean;
  environmentProxyUrl?: string;
  source?: string;
}
export type VoiceSttProviderId =
  | "openai"
  | "groq"
  | "local-whisper"
  | "browser";
export interface VoiceSettings {
  stt: VoiceSttSettings;
  sttProviders?: VoiceSttProviderInfo[];
}
export interface VoiceSttSettings {
  provider: VoiceSttProviderId;
  language: string;
  openai: VoiceCloudSttProviderSettings;
  groq: VoiceCloudSttProviderSettings;
  localWhisper: VoiceLocalWhisperSettings;
  browser: VoiceBrowserSttSettings;
}
export interface VoiceCloudSttProviderSettings {
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv: string;
}
export interface VoiceLocalWhisperSettings {
  model: string;
  command?: string;
  language: string;
}
export interface VoiceBrowserSttSettings {
  language: string;
}
export interface VoiceSttProviderInfo {
  id: VoiceSttProviderId;
  label: string;
  mode: "browser" | "recorded-upload" | "local-command";
  configured: boolean;
  defaultModel?: string;
  notes?: string[];
}
export interface MountedAppSettings {
  id: string;
  path: string;
  workspacePath?: string;
  enabled: boolean;
  title?: string;
  appBuilderEnabled?: boolean;
  policyIssue?: string;
}
export interface KernelPathOverride {
  binaryPath?: string;
  configHome?: string;
}
export interface KernelOption {
  label: string;
  available: boolean;
  installed?: boolean;
  binaryPath?: string;
  configHome?: string;
  id: string;
  icon?: ReactNode;
  installAction?: { id: string; title?: string };
}

export function effectiveProxyValue(
  proxy: KernelProxySettings,
  t: TranslationFn,
): string {
  if (proxy.enabled) return proxy.proxyUrl || t("settings.proxySourceNone");
  return proxy.environmentProxyUrl || t("settings.proxySourceNone");
}
export function effectiveProxyDescription(
  proxy: KernelProxySettings,
  t: TranslationFn,
): string {
  if (proxy.enabled) return t("settings.effectiveProxyApplication");
  if (proxy.environmentProxyUrl) return t("settings.effectiveProxyEnvironment");
  return t("settings.effectiveProxyNone");
}
