import { useMutation } from "@tanstack/react-query";
import { ListRow, SettingsSection, StatusLine, TextButton, useConfirm, useToast } from "@olorinm/agent-ui/app";
import { mauApi, type AgentSummary, type DeviceConnection, type Pairing } from "../api/client";
import type { Session } from "../api/session";
import { useI18n } from "../i18n";

const tones: Record<DeviceConnection, "success" | "warning" | "neutral"> = { online: "success", offline: "neutral", pairing: "warning" };
/** Whether the partner's computer is connected, in a word. */
export function DeviceStatus({ connection }: { connection: DeviceConnection }) {
  const { t } = useI18n();
  return <StatusLine tone={tones[connection]}>{t(`device.${connection}`)}</StatusLine>;
}

/** A pairing code and the command that uses it, each with a way to copy it. */
export function PairingRows({ pairing }: { pairing: Pairing }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast({ kind: "success", title: t("device.copied") }));
  return <>
    <ListRow title={t("device.code")} subtitle={<strong className="mau-pairing-code-value">{pairing.code}</strong>}
      trailing={<TextButton onClick={() => copy(pairing.code)}>{t("device.copy")}</TextButton>} />
    <ListRow title={t("device.command")} subtitle={<code className="mau-pairing-command">{pairing.command}</code>}
      trailing={<TextButton onClick={() => copy(pairing.command)}>{t("device.copy")}</TextButton>} />
  </>;
}

/** The computer of a partner that runs on it: what it is, whether it is connected, and pairing it. */
export function DeviceSection(props: { session: Session; summary: AgentSummary; onChanged(): unknown; onFailed(error: unknown): void }) {
  const { t, language } = useI18n();
  const confirm = useConfirm();
  const api = mauApi(props.session.token), { agent, device, kernel } = props.summary, connection = props.summary.connection ?? "pairing";
  const pair = useMutation({ mutationFn: () => api.pairDevice(agent.id), onError: props.onFailed });
  const unpair = useMutation({ mutationFn: () => api.unpairDevice(agent.id), onSuccess: () => { pair.reset(); return props.onChanged(); }, onError: props.onFailed });
  const value = (text: string) => <span className="mau-profile-value">{text}</span>;
  const remove = async () => {
    const result = await confirm({ title: t("device.removeTitle", { name: agent.name }), body: t("device.removeBody"), confirmLabel: t("device.remove"), danger: true });
    if (result === "primary") unpair.mutate();
  };
  // A code is shown until a computer has paired with it.
  const pairing = pair.data && !(device && Date.parse(device.pairedAt) >= pair.submittedAt) ? pair.data : undefined;
  return <SettingsSection title={t("device.title")}>
    <ListRow title={t("env.state")} trailing={<DeviceStatus connection={connection} />} />
    {device ? <>
      <ListRow title={t("device.name")} trailing={value(device.name)} />
      <ListRow title={t("device.platform")} trailing={value(device.platform)} />
      <ListRow title={t("create.kernel")} trailing={value(kernel ?? device.kernel)} />
      <ListRow title={t("device.lastSeen")} trailing={value(device.lastOnlineAt ? new Date(device.lastOnlineAt).toLocaleString(language, { dateStyle: "short", timeStyle: "short" }) : "—")} />
    </> : null}
    {pairing ? <PairingRows pairing={pairing} /> : null}
    <ListRow tone="action" disabled={pair.isPending} title={t(device ? "device.pairAgain" : "device.pair")} onClick={() => pair.mutate()} />
    {device ? <ListRow tone="danger" disabled={unpair.isPending} title={t("device.remove")} onClick={() => void remove()} /> : null}
  </SettingsSection>;
}
