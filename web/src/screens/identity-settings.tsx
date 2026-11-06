import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InlineNotice } from "@olorinm/agent-frontend";
import { Button, ProductIcon } from "@olorinm/agent-ui/app";
import { ApiError } from "../api/http";
import { ledgerApi, ledgerFeatures, type PairingCode, type PersonIdentity } from "../api/ledger";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";

const providers: Record<string, [string, string]> = {
  matrix: ["Matrix", "Matrix"], feishu: ["飞书", "Feishu"], "feishu-union": ["飞书（跨应用）", "Feishu (all apps)"],
  "grove-mail": ["邮件", "Mail"], agentmail: ["邮件", "Mail"], telegram: ["Telegram", "Telegram"], weixin: ["微信", "WeChat"],
  "cloudflare-access": ["登录邮箱", "Sign-in email"], web: ["网页", "Web"],
};
const verified: Record<string, [string, string]> = {
  config: ["部署配置", "Configuration"], pairing: ["关联码", "Pairing code"], login: ["登录", "Sign-in"], admin: ["管理员", "Administrator"],
};
const pick = (table: Record<string, [string, string]>, value: string, zh: boolean) => table[value]?.[zh ? 0 : 1] ?? value;
/** Remaining time as m:ss; 0:00 once expired. */
export function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mau-connector-section"><h2>{title}</h2><div className="mau-connector-panel">{children}</div></section>;
}

/**
 * "身份与配对" (ADR 0005 18.5): the owner's linked identities, pending pairing codes and a new code with its
 * countdown. Shown only when Router advertises `limits.features.identity`.
 */
export function IdentitySettings({ session }: { session: Session }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const api = useMemo(() => ledgerApi(session.token), [session.token]);
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["ledger-me", session.owner], queryFn: ({ signal }) => api.me(signal), retry: false });
  const enabled = ledgerFeatures(me.data).has("identity");
  const identities = useQuery({ queryKey: ["identities", session.owner], queryFn: ({ signal }) => api.identities(signal), enabled });
  const codes = useQuery({ queryKey: ["pairing-codes", session.owner], queryFn: ({ signal }) => api.pairingCodes(signal), enabled, refetchInterval: 30_000 });
  const [issued, setIssued] = useState<PairingCode | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [issued]);
  const failed = (cause: unknown) => setError(errorMessage(t, cause instanceof ApiError ? cause.code : "request_failed"));
  const refresh = () => { void client.invalidateQueries({ queryKey: ["pairing-codes", session.owner] }); void client.invalidateQueries({ queryKey: ["identities", session.owner] }); };
  const create = useMutation({ mutationFn: () => api.createPairingCode(), onMutate: () => setError(null),
    onSuccess: (code) => { setIssued(code); setNow(Date.now()); refresh(); }, onError: failed });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelPairingCode(id), onMutate: () => setError(null),
    onSuccess: (_data, id) => { if (issued?.id === id) setIssued(null); refresh(); }, onError: (cause) => { failed(cause); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeIdentity(id), onMutate: () => setError(null),
    onSuccess: () => { setConfirm(null); refresh(); }, onError: (cause) => { setConfirm(null); failed(cause); refresh(); } });

  if (me.isPending) return <p className="mau-panel-note">{zh ? "正在读取…" : "Loading…"}</p>;
  if (!enabled) return <InlineNotice title={zh ? "尚未开启" : "Not enabled"}>
    {zh ? "这个 Router 尚未开启身份与配对（limits.features.identity）。" : "This Router has not enabled identities and pairing (limits.features.identity)."}
  </InlineNotice>;
  const expired = issued && Date.parse(issued.expiresAt) <= now;
  return <div className="mau-identity-settings">
    {error && <p className="mau-error" role="alert">{error}</p>}
    <Section title={zh ? "已关联的身份" : "Linked identities"}>
      {identities.isPending ? <p className="mau-panel-note">{zh ? "正在读取…" : "Loading…"}</p>
        : identities.isError ? <p className="mau-error" role="alert">{errorMessage(t, identities.error instanceof ApiError ? identities.error.code : "request_failed")}</p>
        : identities.data.data.length === 0 ? <p className="mau-panel-note">{zh ? "暂无关联的身份。" : "No linked identities."}</p>
        : identities.data.data.map((item: PersonIdentity) => <div className="mau-permission-row" key={item.identityId} data-identity={item.identityId}>
          <span><strong>{pick(providers, item.provider, zh)}</strong> <span className="mau-muted">{item.subject}</span><br />
            <span className="mau-muted">{pick(verified, item.verifiedBy, zh)}{item.lastSeenAt ? ` · ${zh ? "最近使用" : "Last used"} ${new Date(item.lastSeenAt).toLocaleString(language)}` : ""}</span></span>
          {item.removable ? confirm === item.identityId
            ? <span className="mau-connector-buttons">
                <Button variant="primary" disabled={revoke.isPending} onClick={() => revoke.mutate(item.identityId)}>{zh ? "确认解除" : "Confirm"}</Button>
                <Button onClick={() => setConfirm(null)}>{zh ? "取消" : "Cancel"}</Button>
              </span>
            : <Button onClick={() => setConfirm(item.identityId)}>{zh ? "解除关联" : "Unlink"}</Button>
          : <span className="mau-muted">{item.fixed === "identity_in_use" ? zh ? "当前登录" : "Signed in" : zh ? "由配置固定" : "Fixed by configuration"}</span>}
        </div>)}
    </Section>
    <Section title={zh ? "关联新渠道" : "Link a channel"}>
      <p className="mau-panel-note">{zh ? "生成关联码后，在要关联的渠道里私聊你的任一 Agent 发送 /link 关联码。关联码 1 小时内有效，只能使用一次。邮件默认不支持关联。"
        : "Generate a code, then send /link <code> to any of your Agents in a direct chat on the channel to link. Codes are valid for one hour and work once. Mail does not support pairing by default."}</p>
      {issued && !expired && <div className="mau-pairing-code" aria-live="polite">
        <strong className="mau-pairing-code-value">{issued.code}</strong>
        <span className="mau-muted">{zh ? "剩余" : "Expires in"} {remaining(issued.expiresAt, now)}</span>
        <p>{issued.instructions}</p>
      </div>}
      {issued && expired && <p className="mau-panel-note">{zh ? "关联码已过期，请重新生成。" : "The code expired. Generate a new one."}</p>}
      <div className="mau-connector-buttons">
        <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}><ProductIcon name="contacts" />{zh ? "生成关联码" : "Generate code"}</Button>
      </div>
    </Section>
    <Section title={zh ? "待使用的关联码" : "Pending codes"}>
      {codes.isPending ? <p className="mau-panel-note">{zh ? "正在读取…" : "Loading…"}</p>
        : codes.isError ? <p className="mau-error" role="alert">{errorMessage(t, codes.error instanceof ApiError ? codes.error.code : "request_failed")}</p>
        : codes.data.data.length === 0 ? <p className="mau-panel-note">{zh ? "没有待使用的关联码。" : "No pending codes."}</p>
        : codes.data.data.map((item) => <div className="mau-permission-row" key={item.id} data-pairing-code={item.id}>
          <span>{issued?.id === item.id ? issued.code : "••••-••••"} <span className="mau-muted">{zh ? "有效至" : "Valid until"} {new Date(item.expiresAt).toLocaleTimeString(language)}</span></span>
          <Button disabled={cancel.isPending} onClick={() => cancel.mutate(item.id)}>{zh ? "撤销" : "Revoke"}</Button>
        </div>)}
    </Section>
  </div>;
}
