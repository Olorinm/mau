// Presentation extracted from OpenGrove 8b365ed; caller owns data and service operations.
import { Dialog, DialogContent, DialogTitle } from "@olorinm/agent-ui/app";
import { useI18n } from "../presentation/i18n";
import styles from "./remote-agent-panel.module.css";
export function RemoteAgentDialog(props: {
 open: boolean; onOpenChange(open: boolean): void;
 address: string; name: string; busy?: boolean; error?: string;
 onAddressChange(value: string): void; onNameChange(value: string): void;
 onSubmit(value: {address: string; name: string}): void;
}) {
 const { t } = useI18n();
 const { address, name, busy, error, onAddressChange: setAddress, onNameChange: setName } = props;
  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className={styles["remote-agent-dialog"]}>
          <DialogTitle>{t("remoteAgent.add")}</DialogTitle>
          <p className={styles["remote-agent-muted"]}>{t("remoteAgent.addHint")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && address.trim()) props.onSubmit({ address: address.trim(), name: name.trim() });
            }}
          >
            <label>
              {t("remoteAgent.address")}
              <input
                maxLength={512}
                value={address}
                placeholder={t("remoteAgent.addressExample")}
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </label>
            <label>
              {t("remoteAgent.name")}
              <input maxLength={80} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
            </label>
            {error ? (
              <p role="alert" className={styles["remote-agent-error"]}>
                {error}
              </p>
            ) : null}
            <div className={styles["remote-agent-actions"]}>
              <button className="ghost-button" type="button" disabled={busy} onClick={() => props.onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={busy || !address.trim()}>
                {busy ? t("remoteAgent.connecting") : t("remoteAgent.add")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
