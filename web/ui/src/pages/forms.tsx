// Extracted from web/src/components/rooms/employee-dialog.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useState, type FormEventHandler, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, PortalProvider } from "../app/index";

/**
 * A form in a dialog: the title, the caller's fields on one page, feedback and actions. Menus opened in the form
 * render inside it, within the dialog's focus trap, and Escape closes an open menu before the dialog.
 */
export function ProfileDialog({
  open,
  onOpenChange,
  title,
  children,
  feedback,
  actions,
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
  feedback?: ReactNode;
  actions?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="partner-dialog"
        aria-label={title}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (form?.querySelector(".agent-select-popup[data-open]")) event.preventDefault();
        }}
      >
        <form ref={setForm} onSubmit={onSubmit}>
          <PortalProvider container={form}>
            <div className="partner-dialog-body">
              <DialogTitle>{title}</DialogTitle>
              {children}
              {feedback}
              <div className="modal-actions">{actions}</div>
            </div>
          </PortalProvider>
        </form>
      </DialogContent>
    </Dialog>
  );
}
