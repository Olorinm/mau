import type { ReactNode } from "react";
import { frontendOptions, type FrontendFeature } from "../../host";
import { useI18n } from "../../i18n";
import { EmptyState } from "../ui/empty-state";

export function FeatureBoundary({ feature, children }: { feature: string; children: ReactNode }) {
  const { language } = useI18n();
  const reason = frontendOptions().unavailableFeatures?.[feature as FrontendFeature];
  return reason ? <EmptyState title={language === "zh-CN" ? "尚未接入" : "Not connected yet"} description={reason} /> : children;
}
