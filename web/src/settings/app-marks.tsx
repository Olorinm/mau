import { AppIcon, ProductIcon } from "@olorinm/agent-ui/app";
import type { ChannelKind, ConnectorAccount } from "../api/client";

/** Apps that connectors can offer. Only apps with a configured, available account are shown. */
export type ProductGroup = "work" | "knowledge" | "tools";
export interface Product {
  id: string; name: string; en?: string; description: string; descriptionEn: string; group: ProductGroup;
  /** What the consent dialog says it can read. */
  reads: string; readsEn: string;
}
export const products: Product[] = [
  { id: "gmail", name: "Gmail", description: "查找邮件、阅读往来，把重要信息带进对话。", descriptionEn: "Find emails and bring important conversations into your work.", group: "work",
    reads: "员工可以搜索和阅读你的邮件、草稿和标签。", readsEn: "Agents can search and read your email, drafts and labels." },
  { id: "calendar", name: "Google 日历", en: "Google Calendar", description: "把日程、会议与待办安排在一起。", descriptionEn: "Bring your events and meetings together.", group: "work",
    reads: "员工可以查看你的日程和会议。", readsEn: "Agents can view your events and meetings." },
  { id: "feishu", name: "飞书", en: "Feishu", description: "以你的身份读取文档、日历和邮件。", descriptionEn: "Read your docs, calendar and mail as you.", group: "work",
    reads: "员工可以以你的身份读取飞书文档、日历、云空间和邮件。", readsEn: "Agents can read your Feishu docs, calendar, drive and mail as you." },
  { id: "drive", name: "Google 云端硬盘", en: "Google Drive", description: "查找文件，获取工作所需的资料。", descriptionEn: "Find files and the information you need.", group: "knowledge",
    reads: "员工可以查找和读取你的文件。", readsEn: "Agents can find and read your files." },
  { id: "docs", name: "Google 文档", en: "Google Docs", description: "读取文档，了解项目上下文。", descriptionEn: "Bring document context into your conversations.", group: "knowledge",
    reads: "员工可以读取你的文档。", readsEn: "Agents can read your documents." },
  { id: "sheets", name: "Google 表格", en: "Google Sheets", description: "读取表格，理解和分析数据。", descriptionEn: "Read spreadsheets and understand your data.", group: "knowledge",
    reads: "员工可以读取你的表格。", readsEn: "Agents can read your spreadsheets." },
  { id: "slides", name: "Google 幻灯片", en: "Google Slides", description: "阅读演示文稿，提取关键信息。", descriptionEn: "Read presentations and find the key points.", group: "knowledge",
    reads: "员工可以阅读你的演示文稿。", readsEn: "Agents can read your presentations." },
  { id: "notion", name: "Notion", description: "连接笔记、文档与团队知识。", descriptionEn: "Connect notes, documents and team knowledge.", group: "knowledge",
    reads: "员工可以读取你的 Notion 页面。", readsEn: "Agents can read your Notion pages." },
  { id: "github", name: "GitHub", description: "了解代码仓库与项目进展。", descriptionEn: "Keep up with repositories and project progress.", group: "knowledge",
    reads: "员工可以读取你的仓库、议题和拉取请求。", readsEn: "Agents can read your repositories, issues and pull requests." },
  { id: "browser", name: "浏览器", en: "Browser", description: "在云端浏览器中打开网页，必要时由你接管登录。", descriptionEn: "Open pages in a cloud browser; you take over for sign-in.", group: "tools",
    reads: "员工可以打开网页并读取页面内容。", readsEn: "Agents can open web pages and read their content." },
];

const has = (account: ConnectorAccount, word: string) => `${account.id} ${account.label}`.toLowerCase().includes(word);
/** Which product an account belongs to; unknown kinds get their own entry. */
export function productIdFor(account: ConnectorAccount): string {
  if (account.kind === "feishu") return "feishu";
  if (account.kind === "browser" || has(account, "browser")) return "browser";
  if (account.kind === "github" || has(account, "github")) return "github";
  if (account.kind === "notion" || has(account, "notion")) return "notion";
  for (const id of ["gmail", "calendar", "drive", "docs", "sheets", "slides"])
    if (has(account, id) || (id === "calendar" && has(account, "日历"))) return id;
  return "account:" + account.id;
}
export function productFor(id: string, accounts: ConnectorAccount[]): Product | undefined {
  const known = products.find((product) => product.id === id);
  if (known) return known;
  const account = id.startsWith("account:") ? accounts.find((item) => "account:" + item.id === id) : undefined;
  return account ? { id, name: account.label, description: "", descriptionEn: "", group: "tools", reads: "员工可以读取你授权的内容。", readsEn: "Agents can read what you authorize." } : undefined;
}

/** Local vector marks keep the catalog independent of third-party image requests. */
export function AppMark({ id, size = "row" }: { id: string; size?: "row" | "card" }) {
  return <AppIcon size={size} className={`mau-app-mark mau-app-mark-${id.replace(/[^a-z-]/g, "")}`}>{markFor(id)}</AppIcon>;
}

function markFor(id: string) {
  switch (id) {
    case "gmail": return <svg viewBox="0 0 32 28" fill="none"><path d="M3 24V8l13 10L29 8v16" stroke="#4285f4" strokeWidth="5" strokeLinejoin="round"/><path d="M3 8V4l13 11L29 4v4" stroke="#ea4335" strokeWidth="5" strokeLinejoin="round"/><path d="M29 9v15" stroke="#34a853" strokeWidth="5"/><path d="M3 9v15" stroke="#c5221f" strokeWidth="5"/><path d="M29 4v6" stroke="#fbbc04" strokeWidth="5"/></svg>;
    case "drive": return <svg viewBox="0 0 32 30"><path d="M11 2h10l-10 18H1z" fill="#0f9d58"/><path d="m21 2 10 18H21L11 2z" fill="#f4b400"/><path d="M1 20h30l-5 9H6z" fill="#4285f4"/></svg>;
    case "calendar": return <span className="mau-calendar-mark">31</span>;
    case "docs": case "sheets": case "slides": return <svg viewBox="0 0 28 32" fill="none"><path d="M5 1h12l6 6v23H5z" fill="currentColor"/><path d="M17 1v7h6" fill="white" opacity=".4"/>{id === "sheets" ? <path d="M9 14h10v10H9zm0 5h10m-5-5v10" stroke="white"/> : id === "slides" ? <path d="M8 14h12v9H8z" stroke="white" strokeWidth="2"/> : <path d="M9 15h10M9 19h10M9 23h7" stroke="white" strokeWidth="2"/>}</svg>;
    case "notion": return <span className="mau-letter-mark">N</span>;
    case "github": return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.39.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.58 4.94.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>;
    case "feishu": return <svg viewBox="0 0 32 32"><path d="m3 10 11 3 14-9-5 13-9 6z" fill="#3370ff"/><path d="m3 10 10 18 10-11-9 4z" fill="#00d6b9"/></svg>;
    case "browser": return <ProductIcon name="globe" />;
    case "weixin": return <ProductIcon name="chat" />;
    case "telegram": return <ProductIcon name="send" />;
    case "grove-mail": return <ProductIcon name="mention" />;
    default: return <ProductIcon name="provider" />;
  }
}

export const channelKinds: ChannelKind[] = ["feishu", "weixin", "telegram", "grove-mail"];
