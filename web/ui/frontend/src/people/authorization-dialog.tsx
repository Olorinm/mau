import {Dialog,DialogContent,DialogTitle} from "@olorinm/agent-ui/app";
import {useI18n} from "../presentation/i18n";
import styles from "./remote-agent-panel.module.css";
export function NetworkAuthorizationDialog(props:{open:boolean;url:string;canceling?:boolean;cancelError?:boolean;onCancel():void}){const {t}=useI18n();return (      <Dialog
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onCancel();
        }}
      >
        <DialogContent className={styles["remote-agent-dialog"]}>
          <DialogTitle>{t("remoteAgent.authorizeTitle")}</DialogTitle>
          <p>{t("remoteAgent.authorizeHint")}</p>
          <a className="primary-button" href={props.url || undefined} target="_blank" rel="noopener noreferrer">
            {t("remoteAgent.authorizeOpen")}
          </a>
          <p className={styles["remote-agent-muted"]}>{t("remoteAgent.authorizeWaiting")}</p>
          {props.cancelError ? <p role="alert">{t("remoteAgent.cancelAuthorizationError")}</p> : null}
          <button className="ghost-button" type="button" disabled={props.canceling} onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
        </DialogContent>
      </Dialog>);}
