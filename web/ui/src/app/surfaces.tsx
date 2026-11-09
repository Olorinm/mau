import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Select } from "@base-ui/react/select";
import clsx from "clsx";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { ProductIcon } from "./product-icon.js";
import { PortalProvider, usePortalContainer } from "./portal.js";

/** Standard: settings, connectors and channels. Compact: run details, events, approvals and logs. */
export type Density = "standard" | "compact";

/** Settings, consent and confirmation surfaces switch to full-screen pages below this width. */
export const SETTINGS_PAGE_QUERY = "(max-width: 640px)";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Escape closes an open menu first, not the modal around it. */
function keepOpenForMenu(content: HTMLElement | null) {
  return (event: KeyboardEvent) => {
    if (content?.querySelector(".agent-select-popup[data-open]")) event.preventDefault();
  };
}

/** True where settings and modals use their full-screen mobile presentation. */
export function useSettingsPageLayout(): boolean {
  return useMediaQuery(SETTINGS_PAGE_QUERY);
}

/** Sets the density for every surface inside it without adding a layout box. */
export function DensityScope({ value, children }: { value: Density; children: ReactNode }) {
  return (
    <div className="agent-density-scope" data-density={value}>
      {children}
    </div>
  );
}

/** A solid, borderless group of rows. */
export function GroupPanel({
  children,
  density,
  className,
}: {
  children: ReactNode;
  density?: Density | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={clsx("agent-group-panel", className)} data-density={density}>
      {children}
    </div>
  );
}

/** A grey section label above a group panel, with an optional action on the right and a note below. */
export function SettingsSection({
  title,
  action,
  note,
  children,
  density,
  className,
  panel = true,
}: {
  title?: ReactNode | undefined;
  action?: ReactNode | undefined;
  note?: ReactNode | undefined;
  children: ReactNode;
  density?: Density | undefined;
  className?: string | undefined;
  /** False renders the children without the grey panel (for featured cards). */
  panel?: boolean | undefined;
}) {
  return (
    <section className={clsx("agent-settings-section", className)} data-density={density}>
      {title || action ? (
        <header className="agent-settings-section-header">
          {title ? <h3>{title}</h3> : <span />}
          {action}
        </header>
      ) : null}
      {panel ? <GroupPanel>{children}</GroupPanel> : children}
      {note ? <p className="agent-settings-section-note">{note}</p> : null}
    </section>
  );
}

/**
 * One row of a group panel: an optional icon, a title (and an optional secondary line), and a trailing control.
 * `onClick` makes the leading part a button; the trailing control stays a separate target.
 */
export function ListRow({
  icon,
  title,
  subtitle,
  trailing,
  onClick,
  ariaLabel,
  disabled,
  muted,
  tone,
  className,
}: {
  icon?: ReactNode | undefined;
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  trailing?: ReactNode | undefined;
  onClick?: (() => void) | undefined;
  ariaLabel?: string | undefined;
  disabled?: boolean | undefined;
  /** Grey title, for unavailable operations. */
  muted?: boolean | undefined;
  /** A row that is itself an action (断开, 添加账户). */
  tone?: "action" | "danger" | undefined;
  className?: string | undefined;
}) {
  const main = (
    <>
      {icon ? <span className="agent-list-row-icon">{icon}</span> : null}
      <span className="agent-list-row-text">
        <span className="agent-list-row-title">{title}</span>
        {subtitle ? <span className="agent-list-row-subtitle">{subtitle}</span> : null}
      </span>
    </>
  );
  return (
    <div
      className={clsx("agent-list-row", className)}
      data-has-icon={icon ? "" : undefined}
      data-muted={muted ? "" : undefined}
      data-tone={tone}
      data-two-line={subtitle ? "" : undefined}
    >
      {onClick ? (
        <button type="button" className="agent-list-row-main" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
          {main}
        </button>
      ) : (
        <span className="agent-list-row-main">{main}</span>
      )}
      {trailing ? <span className="agent-list-row-trailing">{trailing}</span> : null}
    </div>
  );
}

/** A borderless text action in the primary (or danger) color. */
export function TextButton({
  tone = "primary",
  className,
  type,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "danger" | "neutral" }) {
  return <button {...props} type={type ?? "button"} className={clsx("agent-text-button", className)} data-tone={tone} />;
}

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

/** Text with a chevron and no border, opening a list of choices (允许 / 请求 / 不允许). */
export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  readOnly,
  className,
}: {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange(value: T): void;
  /** Accessible name of the control, usually the row's title. */
  label: string;
  disabled?: boolean | undefined;
  /** Shows the current choice as plain text. */
  readOnly?: boolean | undefined;
  className?: string | undefined;
}) {
  const container = usePortalContainer();
  const current = options.find((option) => option.value === value);
  if (readOnly)
    return (
      <span className={clsx("agent-select-trigger", className)} data-readonly="">
        {current?.label ?? value}
      </span>
    );
  return (
    <Select.Root
      value={value}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as T);
      }}
      disabled={disabled}
      modal={false}
    >
      <Select.Trigger className={clsx("agent-select-trigger", className)} aria-label={label}>
        <Select.Value />
        <Select.Icon className="agent-select-chevron">
          <ProductIcon name="expand" size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner className="agent-select-positioner" sideOffset={6} align="end" alignItemWithTrigger={false}>
          <Select.Popup className="agent-select-popup">
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="agent-select-item">
                <Select.ItemIndicator className="agent-select-indicator">
                  <ProductIcon name="check" size={14} />
                </Select.ItemIndicator>
                <span className="agent-select-item-text">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  /** For example a count shown after the label. */
  badge?: ReactNode | undefined;
}

/** A fully rounded segmented control; the selected segment is a white pill. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string | undefined;
}) {
  return (
    <div className={clsx("agent-segmented", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.badge !== undefined ? <span className="agent-segmented-badge">{option.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A fully rounded search field with a leading icon and a clear button. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  className,
}: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string | undefined;
  clearLabel?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <label className={clsx("agent-search-field", className)}>
      <ProductIcon name="search" size={16} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && clearLabel ? (
        <button type="button" aria-label={clearLabel} onClick={() => onChange("")}>
          <ProductIcon name="close" size={14} />
        </button>
      ) : null}
    </label>
  );
}

/** A rounded-square tile for an app's mark: 32 px in rows, 40 px in cards and detail headers. */
export function AppIcon({
  children,
  size = "row",
  className,
}: {
  children: ReactNode;
  size?: "row" | "card" | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={clsx("agent-app-icon", className)} data-size={size} aria-hidden="true">
      {children}
    </span>
  );
}

/** A near-square grey card with an app icon (an `AppIcon` of size "card"), name and short description. */
export function FeaturedCard({
  icon,
  title,
  description,
  onClick,
  ariaLabel,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode | undefined;
  onClick(): void;
  ariaLabel?: string | undefined;
}) {
  return (
    <button type="button" className="agent-featured-card" onClick={onClick} aria-label={ariaLabel}>
      {icon}
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </button>
  );
}

/** Featured cards in a responsive grid of near-square tiles. */
export function FeaturedGrid({ children }: { children: ReactNode }) {
  return <div className="agent-featured-grid">{children}</div>;
}

/** A white circular button with a soft shadow. */
export function CircleButton({
  icon,
  label,
  onClick,
  className,
}: {
  icon: "previous" | "close";
  label: string;
  onClick(): void;
  className?: string | undefined;
}) {
  return (
    <button type="button" className={clsx("agent-circle-button", className)} aria-label={label} onClick={onClick}>
      <ProductIcon name={icon} size={icon === "close" ? 16 : 18} />
    </button>
  );
}

export function CircleBackButton(props: { label: string; onClick(): void; className?: string }) {
  return <CircleButton icon="previous" {...props} />;
}

/** Centered icon (an `AppIcon` of size "card"), title and subtitle at the top of a detail page. */
export function DetailHero({
  icon,
  title,
  subtitle,
  titleRef,
}: {
  icon?: ReactNode | undefined;
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  return (
    <header className="agent-detail-hero">
      {icon}
      <h2 ref={titleRef} tabIndex={-1}>
        {title}
      </h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}

/** A circle-shaped initial for an account or Agent. */
export function InitialAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span className={clsx("agent-initial-avatar", className)} aria-hidden="true">
      {Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

type SettingsContextValue = { page: boolean; backToNavigation(): void; backLabel: string };
const SettingsContext = createContext<SettingsContextValue | null>(null);

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: ReactNode | undefined;
  /** Shown apart at the bottom (退出). */
  footer?: boolean | undefined;
  /** Runs instead of selecting a page (退出). */
  onSelect?: (() => void) | undefined;
}

/**
 * The settings modal: a left navigation with icons and the selected page. Below 640 px it fills the screen; the
 * navigation is the first page and each page gets a back button and its title instead.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  title,
  items,
  selectedId,
  onSelect,
  closeLabel,
  backLabel,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  items: readonly SettingsNavItem[];
  /** `null` shows the navigation on its own (mobile). */
  selectedId: string | null;
  onSelect(id: string | null): void;
  closeLabel: string;
  backLabel: string;
  children: ReactNode;
}) {
  const container = usePortalContainer();
  const page = useSettingsPageLayout();
  const main = useRef<HTMLDivElement>(null);
  // Menus opened inside the modal render inside it, so the modal's focus trap and pointer lock include them.
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    main.current?.scrollTo?.(0, 0);
  }, [selectedId]);
  const navOnly = page && selectedId === null;
  const button = (item: SettingsNavItem) => (
    <button
      key={item.id}
      type="button"
      className="agent-settings-nav-item"
      aria-current={!page && item.id === selectedId ? "page" : undefined}
      onClick={() => (item.onSelect ? item.onSelect() : onSelect(item.id))}
    >
      {item.icon ? <span className="agent-settings-nav-icon">{item.icon}</span> : null}
      <span>{item.label}</span>
      {page && !item.onSelect ? <ProductIcon name="next" size={14} className="agent-settings-nav-chevron" /> : null}
    </button>
  );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className="agent-modal-overlay" />
        <DialogPrimitive.Content
          ref={setContent}
          className="agent-settings-dialog"
          data-page={page ? "" : undefined}
          data-nav-only={navOnly ? "" : undefined}
          aria-describedby={undefined}
          onEscapeKeyDown={keepOpenForMenu(content)}
          onOpenAutoFocus={(event) => {
            // Keep focus on the dialog itself, not on the first navigation item.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus?.();
          }}
        >
          <DialogPrimitive.Title className="agent-visually-hidden">{title}</DialogPrimitive.Title>
          {!page || navOnly ? (
            <nav className="agent-settings-nav" aria-label={title}>
              {page ? (
                <header className="agent-settings-nav-header">
                  <h2>{title}</h2>
                </header>
              ) : null}
              <div className="agent-settings-nav-items">{items.filter((item) => !item.footer).map(button)}</div>
              <div className="agent-settings-nav-footer">{items.filter((item) => item.footer).map(button)}</div>
            </nav>
          ) : null}
          {!navOnly ? (
            <div className="agent-settings-main" ref={main}>
              <SettingsContext.Provider value={{ page, backToNavigation: () => onSelect(null), backLabel }}>
                <PortalProvider container={content}>{children}</PortalProvider>
              </SettingsContext.Provider>
            </div>
          ) : null}
          <DialogPrimitive.Close asChild>
            <button type="button" className="agent-circle-button agent-settings-close" aria-label={closeLabel}>
              <ProductIcon name="close" size={16} />
            </button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A page inside the settings modal. A sub-page passes `onBack` (circular back button); on mobile every page has a
 * back button, which returns to the navigation unless `onBack` is set.
 */
export function SettingsPage({
  title,
  onBack,
  backLabel,
  hero,
  children,
  className,
}: {
  title?: ReactNode | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  hero?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const settings = useContext(SettingsContext);
  const back = onBack ?? (settings?.page ? settings.backToNavigation : undefined);
  return (
    <div className={clsx("agent-settings-page", className)}>
      {back || title ? (
        <header className="agent-settings-page-header" data-has-back={back ? "" : undefined}>
          {back ? <CircleBackButton label={backLabel ?? settings?.backLabel ?? "Back"} onClick={back} /> : null}
          {title ? <h2>{title}</h2> : null}
        </header>
      ) : null}
      {hero}
      <div className="agent-settings-page-body">{children}</div>
    </div>
  );
}

/** A centered modal (512 px, radius 20) with a circular close button; full screen on mobile. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  icon,
  closeLabel,
  children,
  actions,
  className,
  titleAlign = "center",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  closeLabel: string;
  children?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  className?: string | undefined;
  titleAlign?: "center" | "start" | undefined;
}) {
  const container = usePortalContainer();
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className="agent-modal-overlay" />
        <DialogPrimitive.Content
          ref={setContent}
          className={clsx("agent-modal", className)}
          data-title-align={titleAlign}
          aria-describedby={undefined}
          onEscapeKeyDown={keepOpenForMenu(content)}
        >
          <DialogPrimitive.Close asChild>
            <button type="button" className="agent-circle-button agent-modal-close" aria-label={closeLabel}>
              <ProductIcon name="close" size={16} />
            </button>
          </DialogPrimitive.Close>
          <header className="agent-modal-header">
            {icon}
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description ? <p>{description}</p> : null}
          </header>
          <PortalProvider container={content}>
            {children ? <div className="agent-modal-body">{children}</div> : null}
            {actions ? <div className="agent-modal-actions">{actions}</div> : null}
          </PortalProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A full-width pill primary button above a plain-text cancel. */
export function ModalActions({
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  pending,
  disabled,
  danger,
}: {
  confirmLabel: string;
  cancelLabel?: string | undefined;
  onConfirm(): void;
  onCancel?: (() => void) | undefined;
  pending?: boolean | undefined;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
}) {
  return (
    <>
      <button
        type="button"
        className="agent-pill-button"
        data-tone={danger ? "danger" : undefined}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
      {cancelLabel && onCancel ? (
        <button type="button" className="agent-modal-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
      ) : null}
    </>
  );
}

export interface ConsentItem {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
}

/** The consent dialog shown before connecting an app: what it can access, where credentials live, and control. */
export function ConsentDialog({
  open,
  onOpenChange,
  icon,
  title,
  description,
  items,
  footnote,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  icon?: ReactNode | undefined;
  title: ReactNode;
  description?: ReactNode | undefined;
  items: readonly ConsentItem[];
  /** For example the privacy policy link. */
  footnote?: ReactNode | undefined;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  onConfirm(): void;
  pending?: boolean | undefined;
  error?: ReactNode | undefined;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      icon={icon}
      title={title}
      description={description}
      closeLabel={closeLabel}
      className="agent-consent-dialog"
      actions={
        <>
          {footnote ? <p className="agent-consent-footnote">{footnote}</p> : null}
          {error ? (
            <p className="agent-consent-error" role="alert">
              {error}
            </p>
          ) : null}
          <ModalActions
            confirmLabel={confirmLabel}
            cancelLabel={cancelLabel}
            pending={pending}
            onConfirm={onConfirm}
            onCancel={() => onOpenChange(false)}
          />
        </>
      }
    >
      <ul className="agent-consent-items">
        {items.map((item, index) => (
          <li key={index}>
            <span className="agent-consent-icon">{item.icon}</span>
            <span>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
