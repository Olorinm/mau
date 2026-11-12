// Extracted from web/src/components/app-shell/compact-navigation-dialog.tsx at 8b365ed. See source-manifest.json for boundary changes.
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "./i18n";
import { Dialog, DialogContent, DialogTitle } from "@olorinm/agent-ui/app";

export function CompactNavigationDialog(props: {
  navigationId?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  triggerId: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        placement="left"
        className="compact-navigation-dialog"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .getElementById(props.triggerId)
            ?.focus({ preventScroll: true });
        }}
      >
        <header className="compact-navigation-header">
          <DialogTitle>{props.title}</DialogTitle>
          <button
            type="button"
            className="app-titlebar-control"
            onClick={() => props.onOpenChange(false)}
            aria-label={t("common.close")}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div id={props.navigationId} className="compact-navigation-body">
          {props.children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
