import { QRCodeSVG } from "@rc-component/qrcode";
import { safeExternalUrl } from "../api/http";
import { useI18n } from "../i18n";

/** Router returns a terminal QR; the browser renders its own from the https link. */
export function LinkCode({ url }: { url: string | undefined }) {
  const { t } = useI18n();
  const safe = safeExternalUrl(url);
  if (!safe) return null;
  return (
    <div className="mau-link-code">
      <QRCodeSVG value={safe} size={184} marginSize={2} aria-hidden="true" />
      <a className="ghost-button" href={safe} target="_blank" rel="noopener noreferrer">{t("common.open")}</a>
    </div>
  );
}
