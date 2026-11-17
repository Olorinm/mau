// Extracted from web/src/components/rooms/employee-dialog.tsx at 8b365ed. See source-manifest.json for boundary changes.
import { useState, type FormEventHandler, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  PortalProvider,
  ProductIcon,
} from "../app/index";
import identity from "./styles/app-identity.module.css";
import settings from "./styles/app-settings.module.css";

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

export function AppCreateForm({
  icon,
  title,
  description,
  source,
  onTitleChange,
  onDescriptionChange,
  onSourceChange,
  onChooseFolder,
  disabled,
  labels,
  feedback,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  source: string;
  onTitleChange(value: string): void;
  onDescriptionChange(value: string): void;
  onSourceChange(value: string): void;
  onChooseFolder?(): void;
  disabled?: boolean;
  labels: {
    name: string;
    description: string;
    descriptionPlaceholder?: string;
    directory: string;
    sourcePlaceholder?: string;
    chooseFolder: string;
  };
  feedback?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="app-create-wizard">
      <div className="app-create-hero">{icon}</div>

      <section className="app-create-section">
        <h3>{labels.name}</h3>
        <div className="app-create-group">
          <label className="app-create-row">
            <span>{labels.name}</span>
            <input
              value={title}
              disabled={disabled}
              placeholder="Sample Workbench"
              onChange={(event) => onTitleChange(event.target.value)}
            />
          </label>
          <label className="app-create-row app-create-description-row">
            <span>{labels.description}</span>
            <textarea
              value={description}
              disabled={disabled}
              placeholder={labels.descriptionPlaceholder}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="app-create-section">
        <h3>{labels.directory}</h3>
        <div className="app-create-group">
          <label className="app-create-row">
            <span>{labels.directory}</span>
            <div className="app-create-source-field">
              <input
                value={source}
                disabled={disabled}
                placeholder={labels.sourcePlaceholder}
                onChange={(event) => onSourceChange(event.target.value)}
              />
              <button
                type="button"
                disabled={disabled || !onChooseFolder}
                onClick={onChooseFolder}
                title={labels.chooseFolder}
                aria-label={labels.chooseFolder}
              >
                <ProductIcon name="external" size={17} />
              </button>
            </div>
          </label>
        </div>
      </section>

      {feedback}
      <div className="settings-form-actions">{actions}</div>
    </div>
  );
}

export function AppIdentityEditor({
  icon,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  disabled,
  labels,
}: {
  icon?: ReactNode;
  name: string;
  description: string;
  onNameChange(value: string): void;
  onDescriptionChange(value: string): void;
  disabled?: boolean;
  labels: { name: string; description: string };
}) {
  return (
    <div className={identity.editor}>
      {icon}
      <div className={identity.fields}>
        <label className={identity.row}>
          <span>
            {labels.name} <em>*</em>
          </span>
          <input
            value={name}
            disabled={disabled}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </label>
        <label className={`${identity.row} ${identity.stacked}`}>
          <span>{labels.description}</span>
          <textarea
            value={description}
            disabled={disabled}
            rows={4}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

export function AppSettingsDialog({
  open,
  onOpenChange,
  title,
  children,
  feedback,
  actions,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
  feedback?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        mobilePresentation="page"
        className={settings.dialog}
        aria-label={title}
      >
        <DialogTitle>{title}</DialogTitle>
        {children}
        {feedback}
        <div className="settings-form-actions">{actions}</div>
      </DialogContent>
    </Dialog>
  );
}
