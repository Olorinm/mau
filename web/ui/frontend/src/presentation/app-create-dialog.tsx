// Original dialog composition from web/src/app.tsx at 8b365ed.
import type { ComponentProps, ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@olorinm/agent-ui/app";
import { AppCreateWizard } from "./app-create-wizard";
import { useI18n } from "./i18n";

export function AppCreateDialog({
  open,
  onOpenChange,
  notice,
  ...wizard
}: ComponentProps<typeof AppCreateWizard> & {
  open: boolean;
  onOpenChange(open: boolean): void;
  notice?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        mobilePresentation="page"
        className="app-create-dialog"
        aria-label={t("app.createApp")}
      >
        <DialogTitle>{t("app.createApp")}</DialogTitle>
        {notice}
        <AppCreateWizard {...wizard} />
      </DialogContent>
    </Dialog>
  );
}
