import {Download,LoaderCircle,WifiOff} from "lucide-react";
import clsx from "clsx";
import {AppChatIcon} from "./app-chat-icon";
import {UnreadCountAnchor} from "./unread-count";
import {useI18n} from "./i18n";
export function AppChatButton(props: {
  open: boolean;
  compact?: boolean;
  unreadCount?: number;
  pendingReplies: number;
  className?: string;
  onClick(): void;
}) {
  const { t } = useI18n();
  const action = props.compact
    ? props.open
      ? t("compact.backToWorkspace")
      : t("compact.openChat")
    : props.open
      ? t("shell.exitAppDeveloperMode")
      : t("shell.enterAppDeveloperMode");
  const label = [
    props.unreadCount ? t("app.unreadCount", { label: action, count: props.unreadCount }) : action,
    props.pendingReplies > 0 ? t("shell.pendingReplyCount", { count: props.pendingReplies }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      className={clsx("app-titlebar-developer-button", props.className)}
      data-open={props.open ? "true" : "false"}
      data-compact={props.compact ? "true" : undefined}
      type="button"
      onClick={props.onClick}
      aria-label={label}
      title={label}
    >
      <UnreadCountAnchor count={props.unreadCount ?? 0}>
        <span className="app-chat-button-face">
          <AppChatIcon open={props.open} />
        </span>
      </UnreadCountAnchor>
      {props.pendingReplies > 0 ? <span className="app-titlebar-developer-badge" aria-hidden="true" /> : null}
    </button>
  );
}

export function AccountServiceStatus(props: {
  state?: "checking" | "offline";
  retrying: boolean;
  errorReference?: string;
  onRetry(): void;
}) {
  const { t } = useI18n();
  const offline = props.state === "offline";
  const detail = offline
    ? [
        t("auth.degradedLocalCopy"),
        props.errorReference ? t("auth.errorReference", { reference: props.errorReference }) : "",
      ]
        .filter(Boolean)
        .join("\n")
    : t("auth.accountServiceConnecting");
  return (
    <div className="app-titlebar-account-status-live" role="status" aria-live="polite" aria-atomic="true">
      {props.state ? (
        <div className="app-titlebar-account-status" data-state={props.state} title={detail}>
          {offline ? <WifiOff size={13} aria-hidden="true" /> : <LoaderCircle size={13} aria-hidden="true" />}
          <span>{offline ? t("auth.degradedLocalTitle") : t("auth.accountServiceConnecting")}</span>
          {offline && props.errorReference ? <small>{props.errorReference}</small> : null}
          {offline ? (
            <button
              className="app-titlebar-account-status-retry"
              type="button"
              onClick={props.onRetry}
              disabled={props.retrying}
            >
              {props.retrying ? t("gate.retrying") : t("mountedApp.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TitlebarLongTaskStatus(props: { label: string; progress?: number }) {
  return (
    <div className="app-titlebar-account-status-live" role="status" aria-live="polite">
      <div className="app-titlebar-account-status" data-state="task">
        <LoaderCircle size={13} aria-hidden="true" />
        <span>{props.label}</span>
        {typeof props.progress === "number" ? <small>{Math.round(props.progress)}%</small> : null}
      </div>
    </div>
  );
}

export function TitlebarUpdateButton(props:{visible:boolean;busy?:boolean;label:string;title?:string;progress?:number;disabled?:boolean;onSelect?():void}){
 if(!props.visible)return null;if(props.busy)return <TitlebarLongTaskStatus label={props.label} progress={props.progress}/>;
 return <button className="app-titlebar-update-button" type="button" onClick={props.onSelect} aria-label={props.label} title={props.title??props.label} disabled={props.disabled||!props.onSelect}><Download aria-hidden="true"/></button>;
}
