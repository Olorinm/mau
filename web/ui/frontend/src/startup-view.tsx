import {useEffect,useState,type ReactNode} from "react";
import {useI18n} from "./presentation/i18n";
export function StartupView(props:{brandLabel:string;logo?:ReactNode;statusLabel:string;timedOut?:boolean;longWait?:boolean;blocker?:{message:string;actions:readonly string[]};exporting?:boolean;exportedFileName?:string;exportedEvidenceComplete?:boolean;exportError?:string;resolvingAction?:string;resolutionError?:string;onRetry():void;onExport?():void;onResolve?(action:string):void}){
 const {t}=useI18n();const {blocker,timedOut,longWait,exporting,exportedFileName,exportedEvidenceComplete,exportError,resolvingAction,resolutionError}=props;
 const blocked=!!blocker;const resolveBlocker=(action:string)=>props.onResolve?.(action);
  const exportButton = props.onExport ? (
    <button
      className="og-button cloud-auth-timeout-action"
      type="button"
      onClick={props.onExport}
      disabled={exporting}
    >
      {exporting ? t("gate.exporting") : t("gate.exportDiagnostics")}
    </button>
  ) : null;
  const exportFeedback = (
    <>
      {exportedFileName ? (
        <p className="cloud-auth-status">{t("gate.exportedFile", { name: exportedFileName })}</p>
      ) : null}
      {exportedEvidenceComplete === false ? (
        <p className="bridge-token-error">{t("gate.exportedFileIncomplete")}</p>
      ) : null}
      {exportError ? <p className="bridge-token-error">{exportError}</p> : null}
    </>
  );

  return (
    <main className="cloud-auth-shell cloud-auth-loading-shell" aria-label={props.brandLabel}>
      <div className="cloud-auth-window-drag-region" aria-hidden="true" />
      {blocked || timedOut ? (
        <section className="cloud-auth-timeout-panel" role="alert">
          <div className="cloud-auth-loading-mark" aria-hidden="true">
            {props.logo}
          </div>
          <h1>{t(blocked ? "gate.startupBlockedTitle" : "gate.startupIncompleteTitle")}</h1>
          <p>{t(blocked ? "gate.startupBlockedCopy" : "gate.startupIncompleteCopy")}</p>
          {blocker ? <p className="bridge-token-error">{blocker.message}</p> : null}
          <div className="rooms-guide-actions">
            {blocker?.actions.includes("stop_blocking_process") ? (
              <button
                className="og-button og-button--primary cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("stop_blocking_process")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.stopBlockingServiceAndRetry")}
              </button>
            ) : null}
            {blocker?.actions.includes("repair_state_access") ? (
              <button
                className="og-button og-button--primary cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("repair_state_access")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.repairStateAccessAndRetry")}
              </button>
            ) : null}
            <button
              className={
                blocker
                  ? "og-button cloud-auth-timeout-action"
                  : "og-button cloud-auth-timeout-action cloud-auth-timeout-action--neutral"
              }
              type="button"
              onClick={props.onRetry}
              disabled={exporting || Boolean(resolvingAction)}
            >
              {t(blocker ? "gate.recheck" : "mountedApp.retry")}
            </button>
            {blocker?.actions.includes("open_data_dir") && props.onResolve ? (
              <button
                className="og-button cloud-auth-timeout-action"
                type="button"
                onClick={() => void resolveBlocker("open_data_dir")}
                disabled={exporting || Boolean(resolvingAction)}
              >
                {t("gate.openDataDirectory")}
              </button>
            ) : null}
            {exportButton}
          </div>
          {exportFeedback}
          {resolutionError ? <p className="bridge-token-error">{resolutionError}</p> : null}
        </section>
      ) : (
        <section className="cloud-auth-startup-panel">
          <StartupProgress label={props.statusLabel} logo={props.logo} />
          {longWait ? (
            <div className="cloud-auth-long-wait" aria-live="polite">
              <p>{t("gate.desktopStartupLongWaitCopy")}</p>
              {exportButton}
              {exportFeedback}
            </div>
          ) : null}
        </section>
      )}
    </main>
  );
}
export function StartupProgress(props: {label:string;logo?:ReactNode}) {
  const [animationCycle, setAnimationCycle] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => setAnimationCycle((cycle) => cycle + 1), 4_600);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="cloud-auth-loading-progress" role="status" aria-live="polite" aria-atomic="true">
      <div className="cloud-auth-loading-mark" aria-hidden="true" key={animationCycle}>
        {props.logo}
      </div>
      <p className="cloud-auth-loading-status">
        {props.label}
        <span className="cloud-auth-loading-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </p>
    </div>
  );
}
