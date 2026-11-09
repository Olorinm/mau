import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ConsentDialog,
  DetailHero,
  EmployeeAvatar,
  FeaturedCard,
  FeaturedGrid,
  InitialAvatar,
  ListRow,
  Modal,
  ModalActions,
  ProductIcon,
  SearchField,
  SegmentedControl,
  SelectMenu,
  SettingsPage,
  SettingsSection,
  TextButton,
  useToast,
} from "@olorinm/agent-ui/app";
import { mauApi, type AgentSummary, type ConnectorAccount, type ConnectorPolicy, type PolicyOperation, type PolicySetting } from "../api/client";
import { ApiError, safeExternalUrl } from "../api/http";
import type { Session } from "../api/session";
import { errorMessage, useI18n } from "../i18n";
import { LinkCode } from "../screens/link-code";
import { AppMark, productFor, productIdFor, type Product, type ProductGroup } from "./app-marks";
import { defaultPolicy, settingLabels } from "./permissions";
import { openSettings, rememberSettingsReturn } from "./route";

export const privacyPolicyUrl = "https://www.openmau.com/privacy.html";
type Accounts = { configured: boolean; data: ConnectorAccount[] };
const featuredIds = ["gmail", "feishu", "browser"];

export function useConnectorAccounts(session: Session) {
  return useQuery({ queryKey: ["connector-accounts", session.owner], queryFn: mauApi(session.token).connectorAccounts,
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useAgents(session: Session) {
  return useQuery({ queryKey: ["agents", session.owner], queryFn: mauApi(session.token).agents });
}
function useAccountUpdate(session: Session) {
  const client = useQueryClient();
  return (next: ConnectorAccount) => client.setQueryData(["connector-accounts", session.owner], (old: Accounts | undefined) =>
    old && ({ ...old, data: old.data.map((item) => item.id === next.id ? next : item) }));
}

/** Coming-soon apps (`needs_setup` without a pending hand-over) are not listed at all. */
const offered = (account: ConnectorAccount) => account.state !== "needs_setup" || account.kind === "feishu";
const isConnected = (account: ConnectorAccount) => account.state === "connected";
/**
 * Feishu's device flow: the QR comes from the account itself (the list includes `authorizationUrl` while authorization
 * is pending), so it survives a reload and is kept until it expires; then the 授权 button returns.
 */
const pendingQr = (account: ConnectorAccount, now = Date.now()) =>
  account.kind === "feishu" && (account.state === "authorization_pending" || account.state === "authorization_required")
  && !!safeExternalUrl(account.authorizationUrl) && (!account.expiresAt || Date.parse(account.expiresAt) > now);

/** 连接器: search, 可用 / 已连接, featured cards and grouped rows; an app opens its detail page. */
export function ConnectorsPage({ session, item }: { session: Session; item?: string }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const accounts = useConnectorAccounts(session);
  const [query, setQuery] = useState(""), [tab, setTab] = useState<"available" | "connected">("available");
  const [consent, setConsent] = useState<{ account: ConnectorAccount; product: Product }>();
  const data = accounts.data?.data ?? [];
  const byProduct = useMemo(() => {
    const map = new Map<string, ConnectorAccount[]>();
    for (const account of data.filter(offered)) {
      const id = productIdFor(account);
      map.set(id, [...(map.get(id) ?? []), account]);
    }
    return map;
  }, [data]);
  const list = [...byProduct.keys()].map((id) => productFor(id, data)).filter((product): product is Product => !!product);
  const name = (product: Product) => zh ? product.name : product.en ?? product.name;
  const description = (product: Product) => zh ? product.description : product.descriptionEn;
  const connected = (product: Product) => (byProduct.get(product.id) ?? []).some(isConnected);
  const expired = (product: Product) => (byProduct.get(product.id) ?? []).some((account) => account.state === "expired");
  const open = (product: Product) => openSettings({ section: "connectors", item: product.id });
  const chosen = item ? productFor(item, data) : undefined;

  if (item && chosen && byProduct.has(chosen.id))
    return <ConnectorDetail session={session} product={chosen} accounts={byProduct.get(chosen.id)!} />;
  if (item && accounts.isPending)
    return <SettingsPage onBack={() => openSettings({ section: "connectors" })} backLabel={zh ? "所有连接器" : "All connectors"}>
      <p className="mau-settings-note" role="status">{zh ? "正在读取连接状态…" : "Loading connections…"}</p>
    </SettingsPage>;

  const matches = (product: Product) => `${product.name} ${product.en ?? ""} ${product.id}`.toLowerCase().includes(query.trim().toLowerCase());
  const visible = list.filter((product) => matches(product) && (tab === "available" || connected(product) || expired(product)));
  const featured = !query && tab === "available" ? featuredIds.map((id) => list.find((product) => product.id === id)).filter((product): product is Product => !!product) : [];
  const action = (product: Product) => {
    const accountsFor = byProduct.get(product.id) ?? [];
    if (connected(product)) return <TextButton onClick={() => open(product)}>{zh ? "查看" : "View"}</TextButton>;
    const target = accountsFor.find((account) => !isConnected(account));
    // Feishu needs its chat app and a QR authorization; its page walks through both.
    if (!target || target.kind === "feishu") return <TextButton tone={expired(product) ? "danger" : "primary"} onClick={() => open(product)}>
      {expired(product) ? zh ? "重新授权" : "Re-authorize" : zh ? "连接" : "Connect"}</TextButton>;
    return <TextButton tone={expired(product) ? "danger" : "primary"} onClick={() => setConsent({ account: target, product })}>
      {expired(product) ? zh ? "重新授权" : "Re-authorize" : zh ? "连接" : "Connect"}</TextButton>;
  };
  const row = (product: Product) => <ListRow key={product.id} icon={<AppMark id={product.id} />} title={name(product)}
    onClick={() => open(product)} ariaLabel={name(product)} trailing={action(product)} />;
  const groups: Array<[ProductGroup, string]> = [["work", zh ? "日常工作" : "Everyday work"], ["knowledge", zh ? "文件与知识" : "Files and knowledge"], ["tools", zh ? "工具" : "Tools"]];
  const expiredAccounts = data.filter((account) => account.state === "expired");
  return <SettingsPage title={zh ? "连接器" : "Connectors"}>
    <SearchField value={query} onChange={setQuery} placeholder={zh ? "搜索" : "Search"} label={zh ? "搜索连接器" : "Search connectors"} clearLabel={zh ? "清空搜索" : "Clear search"} />
    <SegmentedControl<"available" | "connected"> label={zh ? "连接器分类" : "Connector categories"} value={tab} onChange={setTab} options={[
      { value: "available", label: zh ? "可用" : "Available" },
      { value: "connected", label: zh ? "已连接" : "Connected", ...(accounts.isSuccess ? { badge: list.filter(connected).length } : {}) },
    ]} />
    {accounts.isError ? <SettingsSection>
      <ListRow title={errorMessage(t, accounts.error instanceof ApiError ? accounts.error.code : "request_failed")} muted
        trailing={<TextButton onClick={() => void accounts.refetch()}>{zh ? "重新加载" : "Reload"}</TextButton>} />
    </SettingsSection> : null}
    {expiredAccounts.length ? <SettingsSection>
      <ListRow tone="danger" title={zh ? `${expiredAccounts.map((account) => account.label).join("、")}的授权已过期` : `${expiredAccounts.map((account) => account.label).join(", ")}: authorization expired`}
        subtitle={zh ? "员工暂时无法使用，需要重新授权。" : "Agents cannot use it until you re-authorize."} />
    </SettingsSection> : null}
    {accounts.isPending ? <p className="mau-settings-note" role="status">{zh ? "正在读取连接状态…" : "Loading connections…"}</p> : null}
    {accounts.data && !accounts.data.configured ? <SettingsSection>
      <ListRow muted title={zh ? "连接器服务尚未配置" : "Connectors are not configured"} subtitle={zh ? "配置后，可以在这里连接 Gmail、飞书等应用。" : "Once configured, connect apps such as Gmail here."} />
    </SettingsSection> : null}
    {featured.length ? <SettingsSection title={zh ? "精选" : "Featured"} panel={false}>
      <FeaturedGrid>{featured.map((product) => <FeaturedCard key={product.id} icon={<AppMark id={product.id} size="card" />}
        title={name(product)} description={description(product)} onClick={() => open(product)} />)}</FeaturedGrid>
    </SettingsSection> : null}
    {tab === "connected" ? visible.length ? <SettingsSection title={zh ? "已连接" : "Connected"}>{visible.map(row)}</SettingsSection> : null
      : groups.map(([group, title]) => {
        const items = visible.filter((product) => product.group === group);
        return items.length ? <SettingsSection key={group} title={title}>{items.map(row)}</SettingsSection> : null;
      })}
    {accounts.isSuccess && accounts.data.configured && !visible.length ? <div className="mau-settings-empty">
      <ProductIcon name={query ? "search" : "apps"} size={24} />
      <strong>{zh ? query ? "没有找到连接器" : "还没有已连接的应用" : query ? "No connectors found" : "No connected apps yet"}</strong>
      <span>{zh ? query ? "试试应用名称，例如 Gmail 或飞书。" : "到「可用」中选择你常用的应用。" : query ? "Try an app name, such as Gmail." : "Choose an app in Available to get started."}</span>
    </div> : null}
    {consent ? <ConnectConsent session={session} account={consent.account} product={consent.product} onClose={() => setConsent(undefined)} /> : null}
  </SettingsPage>;
}

/** Start the connector's own flow: OAuth redirects to the provider; Feishu hands over the chat app, then shows a QR. */
function useConnect(session: Session, product: Product) {
  const changed = useAccountUpdate(session);
  return useMutation({
    mutationFn: async ({ account, agentId }: { account: ConnectorAccount; agentId?: string }) => {
      const api = mauApi(session.token);
      if (account.kind === "feishu" && agentId) await api.feishuApplication(account.id, agentId);
      return api.connectorAccountAction(account.id, "connect");
    },
    onSuccess: (data, { account }) => {
      changed({ ...account, ...data });
      const consent = safeExternalUrl(data.authorizationUrl);
      if (account.kind !== "feishu" && consent && data.state !== "connected") {
        rememberSettingsReturn({ section: "connectors", item: product.id });
        window.location.assign(consent);
      }
    },
  });
}

/** Muse's three-part consent before an app is connected; 继续 starts the existing connect flow. */
function ConnectConsent({ session, account, product, agentId, onClose, onStarted }: {
  session: Session; account: ConnectorAccount; product: Product; agentId?: string; onClose(): void; onStarted?(): void;
}) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const connect = useConnect(session, product);
  const name = zh ? product.name : product.en ?? product.name;
  const ownerPrivate = account.usage === "owner_private" || account.kind === "feishu";
  return <ConsentDialog open onOpenChange={(open) => { if (!open) onClose(); }}
    icon={<AppMark id={product.id} size="card" />} title={name}
    description={zh ? `员工可以通过 Mau 使用你的${/^[A-Za-z]/.test(name) ? " " : ""}${name}` : `Your Agents can use ${name} through Mau`}
    closeLabel={zh ? "关闭" : "Close"} confirmLabel={connect.isPending ? zh ? "正在准备…" : "Preparing…" : zh ? "继续" : "Continue"} cancelLabel={zh ? "取消" : "Cancel"}
    pending={connect.isPending}
    error={connect.error ? errorMessage(t, connect.error instanceof ApiError ? connect.error.code : "request_failed") : undefined}
    onConfirm={() => connect.mutate({ account, ...(agentId ? { agentId } : {}) }, { onSuccess: () => { onStarted?.(); if (account.kind === "feishu" || account.verification === "none") onClose(); } })}
    items={[
      { icon: <ProductIcon name="eye" size={18} />, title: zh ? "它可以读取什么" : "What it can read", body: zh ? product.reads : product.readsEn },
      { icon: <ProductIcon name="locked" size={18} />, title: zh ? "凭据保存在 Mau" : "Credentials stay in Mau",
        body: zh ? "授权凭据保存在 Mau，不会进入员工的沙箱。" : "Authorization credentials stay in Mau and never enter the Agent's sandbox." },
      { icon: <ProductIcon name="shield" size={18} />, title: zh ? "由你决定能做什么" : "You decide what it can do",
        body: ownerPrivate
          ? zh ? "写入操作按你的设置请求批准；只在你和员工的私聊中可用，群聊中不可用。你可以随时断开连接。" : "Writes ask for your approval as you set them. It works only in your private chats with the Agent, never in groups. You can disconnect at any time."
          : zh ? "写入操作按你的设置请求批准。你可以随时断开连接。" : "Writes ask for your approval as you set them. You can disconnect at any time." },
    ]}
    footnote={<>{zh ? "请参阅我们的" : "See our "}<a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer">{zh ? "隐私政策" : "privacy policy"}</a>{zh ? "，了解我们如何使用这些信息。" : " to learn how this information is used."}</>}
  />;
}

function ConnectorDetail({ session, product, accounts }: { session: Session; product: Product; accounts: ConnectorAccount[] }) {
  const { language } = useI18n(), zh = language === "zh-CN";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [product.id]);
  const name = zh ? product.name : product.en ?? product.name;
  return <SettingsPage onBack={() => openSettings({ section: "connectors" })} backLabel={zh ? "所有连接器" : "All connectors"}
    hero={<DetailHero icon={<AppMark id={product.id} size="card" />} title={name} titleRef={heading}
      subtitle={product.id === "gmail" ? zh ? "你可以授予只读或读写访问权限" : "You can grant read-only or read and write access" : zh ? product.description : product.descriptionEn} />}>
    {accounts.map((account) => <AccountDetail key={account.id} session={session} account={account} product={product} />)}
  </SettingsPage>;
}

const reasonText = (zh: boolean, reason: string | undefined) => reason === "refresh_token_expired" ? zh ? "授权已到期。" : "The authorization ran out."
  : reason === "token_revoked" ? zh ? "授权已被撤销。" : "The authorization was revoked." : zh ? "授权已失效。" : "The authorization is no longer valid.";

function AccountDetail({ session, account, product }: { session: Session; account: ConnectorAccount; product: Product }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const changed = useAccountUpdate(session);
  const agents = useAgents(session);
  const api = mauApi(session.token);
  // An unconfirmed mutation must be checked before anything else is tried; nothing is retried automatically.
  const [uncertain, setUncertain] = useState(false), [checkFailed, setCheckFailed] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false), [consent, setConsent] = useState(false);
  const check = useMutation({ mutationFn: () => api.connectorAccountAction(account.id, "check"),
    onSuccess: (data) => { changed({ ...account, ...data }); setUncertain(false); setCheckFailed(false); }, onError: () => setCheckFailed(true) });
  const disconnect = useMutation({ mutationFn: () => api.connectorAccountAction(account.id, "disconnect"),
    onSuccess: (data) => { changed({ ...account, ...data }); setConfirmDisconnect(false); toast({ kind: "success", title: zh ? `已断开${product.name}` : `${product.en ?? product.name} disconnected` }); },
    onError: () => { setUncertain(true); setConfirmDisconnect(false); } });
  const complete = useMutation({ mutationFn: () => api.connectorAccountAction(account.id, "complete"), onSuccess: (data) => changed({ ...account, ...data }) });
  // Check on open: the page shows the current authorization without a "check connection" button.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !["connected", "expired", "needs_attention"].includes(account.state)) return;
    checked.current = true;
    check.mutate();
  }, [account.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Feishu: while the owner confirms in Feishu, finish the device flow in the background.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!account.expiresAt || !pendingQr(account)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(account.expiresAt) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [account.expiresAt, account.authorizationUrl, account.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const qr = pendingQr(account, now);
  const polling = useQuery({ queryKey: ["feishu-complete", account.id, account.authorizationUrl], enabled: qr,
    queryFn: () => api.connectorAccountAction(account.id, "complete"), refetchInterval: 4000, retry: false });
  useEffect(() => { if (polling.data && polling.data.state !== account.state) changed({ ...account, ...polling.data }); }, [polling.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = isConnected(account), feishu = account.kind === "feishu";
  const assigned = (account.assignedAgents ?? []).map((id) => agents.data?.find((agent) => agent.agent.id === id)).filter((agent): agent is AgentSummary => !!agent);
  const feishuAgent = feishu ? assigned[0] : undefined;
  const chatReady = !feishu || !!feishuAgent?.connections.some((connection) => connection.kind === "feishu");
  const identity = account.account?.email ?? account.account?.name ?? account.name;
  const busy = disconnect.isPending || check.isPending;
  const name = zh ? product.name : product.en ?? product.name;
  const connectLabel = account.state === "expired" || account.state === "authorization_pending" ? zh ? "重新授权" : "Re-authorize"
    : feishu ? zh ? "授权个人权限" : "Authorize personal access" : zh ? `连接${name}` : `Connect ${name}`;

  return <>
    {uncertain || checkFailed ? <SettingsSection>
      <ListRow title={zh ? "无法确认连接状态" : "Connection status unknown"} subtitle={uncertain
        ? zh ? "操作结果尚未确认。请先重新检查，再决定是否重试；不会自动重试。" : "The outcome is uncertain. Check again before retrying; nothing is retried automatically."
        : zh ? "暂时无法检查连接，请稍后重新检查。" : "The connection could not be checked. Try again later."}
        trailing={<TextButton disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? zh ? "检查中…" : "Checking…" : zh ? "重新检查" : "Check again"}</TextButton>} />
    </SettingsSection> : null}
    {connected ? <SettingsSection>
      <ListRow tone="danger" title={zh ? "断开" : "Disconnect"} onClick={uncertain || busy ? undefined : () => setConfirmDisconnect(true)} />
    </SettingsSection> : feishu && !chatReady ? <SettingsSection>
      <ListRow muted title={zh ? "先在消息渠道连接飞书聊天" : "Connect Feishu chat in Messaging first"}
        subtitle={zh ? "个人权限使用同一个飞书应用，聊天连接后才能授权。" : "Personal access uses the same Feishu app; authorize it once chat is connected."}
        trailing={<TextButton onClick={() => openSettings({ section: "channels" })}>{zh ? "前往" : "Open"}</TextButton>} />
    </SettingsSection> : qr ? <SettingsSection>
      <div className="mau-settings-qr" aria-live="polite">
        <p>{zh ? "用飞书扫码或打开链接，以你的身份授权。确认后这里会自动更新。" : "Scan with Feishu or open the link to authorize as yourself. This updates automatically."}</p>
        <LinkCode url={account.authorizationUrl} />
        <TextButton disabled={complete.isPending} onClick={() => complete.mutate()}>{t("feishu.complete")}</TextButton>
        {complete.error ? <p className="mau-error" role="alert">{errorMessage(t, complete.error instanceof ApiError ? complete.error.code : "request_failed")}</p> : null}
      </div>
    </SettingsSection> : <SettingsSection>
      <ListRow tone={account.state === "expired" ? "danger" : "action"} title={connectLabel} ariaLabel={connectLabel}
        subtitle={account.state === "expired" ? reasonText(zh, account.reason) + (zh ? "员工暂时无法使用，请重新授权。" : " Agents cannot use it until you re-authorize.") : undefined}
        onClick={uncertain ? undefined : () => setConsent(true)} />
    </SettingsSection>}
    {connected && identity ? <SettingsSection>
      <ListRow icon={<InitialAvatar name={identity} />} title={identity} />
    </SettingsSection> : null}
    <SettingsSection title={zh ? "使用此连接的员工" : "Agents using this connection"}>
      {assigned.length ? assigned.map((agent) => <ListRow key={agent.agent.id}
        icon={<EmployeeAvatar seed={agent.agent.id} fallbackName={agent.agent.name} size={32} />} title={agent.agent.name}
        trailing={account.usage === "owner_private" || feishu ? <span>{zh ? "仅私聊" : "Private chat only"}</span> : null} />)
        : <ListRow muted title={agents.isPending ? zh ? "正在读取…" : "Loading…" : zh ? "暂未分配员工" : "No Agent assigned"} />}
    </SettingsSection>
    <PolicySections session={session} account={account} product={product} />
    <Modal open={confirmDisconnect} onOpenChange={setConfirmDisconnect} closeLabel={zh ? "关闭" : "Close"}
      title={zh ? `断开${name}？` : `Disconnect ${name}?`}
      description={zh ? "断开后，Mau 将清除此连接保存的授权，员工无法继续访问。服务方的授权可能还需要在其账号设置中撤销。" : "Disconnecting removes the saved authorization and stops Agent access. You may also need to revoke it in the provider's account settings."}
      actions={<ModalActions danger confirmLabel={zh ? "断开" : "Disconnect"} cancelLabel={zh ? "取消" : "Cancel"} pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()} onCancel={() => setConfirmDisconnect(false)} />} />
    {consent ? <ConnectConsent session={session} account={account} product={product} {...(feishuAgent ? { agentId: feishuAgent.agent.id } : {})}
      onClose={() => setConsent(false)} /> : null}
  </>;
}

const choices = (zh: boolean) => (["allow", "ask", "deny"] as const).map((value) => ({ value, label: settingLabels[value][zh ? 0 : 1] }));

/** 读取权限 / 写入和删除权限 / 后台操作 with a 允许 · 请求 · 不允许 menu per operation. */
function PolicySections({ session, account, product }: { session: Session; account: ConnectorAccount; product: Product }) {
  const { language, t } = useI18n(), zh = language === "zh-CN";
  const { toast } = useToast();
  const client = useQueryClient();
  const api = mauApi(session.token);
  const key = ["connector-policy", account.id];
  const policy = useQuery({ queryKey: key, queryFn: () => api.connectorPolicy(account.id), retry: false });
  // A server without the policy API: show what it enforces, read-only.
  const legacy = policy.error instanceof ApiError && (policy.error.status === 404 || policy.error.status === 405);
  const data = policy.data ?? (legacy ? defaultPolicy(product.id) : null);
  const editable = !!policy.data;
  const [allowing, setAllowing] = useState<PolicyOperation>(), [resetting, setResetting] = useState(false);
  const failed = (error: unknown) => toast({ kind: "error", title: errorMessage(t, error instanceof ApiError ? error.code : "request_failed") });
  const update = useMutation({
    mutationFn: (change: { id: string; setting: PolicySetting }) => api.updateConnectorPolicy(account.id, { [change.id]: change.setting }),
    onMutate: (change) => {
      const before = client.getQueryData<ConnectorPolicy>(key);
      if (before) client.setQueryData<ConnectorPolicy>(key, mapOperations(before, (operation) => operation.id === change.id ? { ...operation, setting: change.setting } : operation));
      return before;
    },
    onSuccess: (next) => client.setQueryData(key, next),
    onError: (error, _change, before) => { if (before) client.setQueryData(key, before); failed(error); },
  });
  const reset = useMutation({ mutationFn: () => api.resetConnectorPolicy(account.id),
    onSuccess: (next) => { client.setQueryData(key, next); setResetting(false); }, onError: (error) => { setResetting(false); failed(error); } });
  const grant = useMutation({ mutationFn: (operation: PolicyOperation) => api.connectWithScopes(account.id, [operation.id]),
    onSuccess: (data) => {
      const consent = safeExternalUrl(data.authorizationUrl);
      if (consent) { rememberSettingsReturn({ section: "connectors", item: product.id }); window.location.assign(consent); }
      else void policy.refetch();
    },
    onError: (error) => toast({ kind: "error", title: error instanceof ApiError && error.status >= 400 && error.status < 500
      ? zh ? "暂时无法添加这项权限。" : "This permission cannot be added yet." : errorMessage(t, error instanceof ApiError ? error.code : "request_failed") }) });

  if (policy.isPending) return <p className="mau-settings-note" role="status">{zh ? "正在读取权限…" : "Loading permissions…"}</p>;
  if (!data) return policy.isError && !legacy ? <SettingsSection>
    <ListRow muted title={zh ? "无法读取权限设置" : "Permissions could not be loaded"} trailing={<TextButton onClick={() => void policy.refetch()}>{zh ? "重新加载" : "Reload"}</TextButton>} />
  </SettingsSection> : null;
  const label = (operation: PolicyOperation) => zh ? operation.labelZh : operation.label;
  const change = (operation: PolicyOperation, setting: PolicySetting) => {
    if (operation.risk !== "read" && setting === "allow") setAllowing(operation);
    else update.mutate({ id: operation.id, setting });
  };
  const row = (operation: PolicyOperation) => <ListRow key={operation.id} title={label(operation)} muted={!operation.available}
    subtitle={operation.available ? undefined : operation.unavailableReason === "scope_required" ? zh ? "需要获得更多访问权限" : "Needs more access" : zh ? "暂不支持" : "Not supported yet"}
    trailing={operation.available
      ? <SelectMenu label={label(operation)} value={operation.setting} options={choices(zh)} readOnly={!editable} onChange={(setting) => change(operation, setting)} />
      : operation.grantable && editable ? <TextButton disabled={grant.isPending} onClick={() => grant.mutate(operation)}>{zh ? "添加" : "Add"}</TextButton> : null} />;
  return <>
    {data.groups.map((group) => <SettingsSection key={group.id} title={zh ? group.labelZh : group.label}
      note={group.operations.some((operation) => operation.risk !== "read" && operation.available)
        ? zh ? "在定时任务和委派工作中，设为「请求」的操作会被拒绝。" : "In scheduled and delegated work, operations set to Ask are refused." : undefined}>
      {group.operations.map(row)}
    </SettingsSection>)}
    {data.background?.length ? <SettingsSection title={zh ? "后台操作" : "Background"}>{data.background.map(row)}</SettingsSection> : null}
    {editable ? <div className="mau-settings-end">
      <TextButton tone="danger" onClick={() => setResetting(true)}>{zh ? "重置为默认" : "Reset to defaults"}</TextButton>
    </div> : null}
    <Modal open={!!allowing} onOpenChange={(open) => { if (!open) setAllowing(undefined); }} closeLabel={zh ? "关闭" : "Close"}
      title={allowing ? zh ? `允许「${label(allowing)}」？` : `Allow “${label(allowing)}”?` : ""}
      description={zh ? "以后员工执行此操作不会再询问你。" : "Your Agents will no longer ask before doing this."}
      actions={<ModalActions confirmLabel={zh ? "允许" : "Allow"} cancelLabel={zh ? "取消" : "Cancel"}
        onConfirm={() => { if (allowing) update.mutate({ id: allowing.id, setting: "allow" }); setAllowing(undefined); }}
        onCancel={() => setAllowing(undefined)} />} />
    <Modal open={resetting} onOpenChange={setResetting} closeLabel={zh ? "关闭" : "Close"} title={zh ? "重置为默认权限？" : "Reset to default permissions?"}
      description={zh ? "所有操作会恢复为默认的允许、请求或不允许。" : "Every operation returns to its default setting."}
      actions={<ModalActions danger confirmLabel={zh ? "重置" : "Reset"} cancelLabel={zh ? "取消" : "Cancel"} pending={reset.isPending}
        onConfirm={() => reset.mutate()} onCancel={() => setResetting(false)} />} />
  </>;
}

function mapOperations(policy: ConnectorPolicy, map: (operation: PolicyOperation) => PolicyOperation): ConnectorPolicy {
  return { ...policy, groups: policy.groups.map((group) => ({ ...group, operations: group.operations.map(map) })),
    ...(policy.background ? { background: policy.background.map(map) } : {}) };
}

/** Feishu personal access for one Agent, shown next to its chat connection in 消息渠道. */
export function feishuPersonalState(account: ConnectorAccount | undefined, zh: boolean): string {
  if (!account) return zh ? "个人权限未开放" : "Personal access unavailable";
  switch (account.state) {
    case "connected": return zh ? "个人权限已授权" : "Personal access authorized";
    case "expired": return zh ? "个人权限已过期" : "Personal access expired";
    case "authorization_pending": return zh ? "个人权限等待确认" : "Personal access waiting for confirmation";
    default: return zh ? "个人权限未授权" : "Personal access not authorized";
  }
}
