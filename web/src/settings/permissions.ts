import type { ConnectorPolicy, PolicyOperation, PolicySetting } from "../api/client";

const op = (id: string, label: string, labelZh: string, risk: PolicyOperation["risk"], setting: PolicySetting, extra: Partial<PolicyOperation> = {}): PolicyOperation =>
  ({ id, label, labelZh, risk, setting, default: setting, available: true, ...extra });
const unavailable = { available: false, unavailableReason: "not_supported" as const, grantable: false };

/**
 * What a server without the policy API enforces today, shown read-only: reads are allowed, writes ask for approval
 * (or are not requested at all), background work is off.
 */
export function defaultPolicy(productId: string): ConnectorPolicy | null {
  switch (productId) {
    case "gmail": return { groups: [
      { id: "read", label: "Read access", labelZh: "读取权限", operations: [
        op("gmail.search", "Search email", "搜索邮件", "read", "allow"),
        op("gmail.read", "Read messages and threads", "阅读邮件与会话", "read", "allow"),
        op("gmail.drafts.read", "View drafts", "查看草稿", "read", "allow"),
        op("gmail.labels.read", "View labels", "查看标签", "read", "allow"),
      ] },
      { id: "write", label: "Write and delete access", labelZh: "写入和删除权限", operations: [
        op("gmail.write", "Send, modify or delete email", "发送、修改或删除邮件", "write", "deny", { available: false, unavailableReason: "scope_required", grantable: false }),
      ] },
    ], background: [op("gmail.sync", "Background sync", "后台同步", "read", "deny", unavailable)] };
    case "feishu": return { groups: [
      { id: "read", label: "Read access", labelZh: "读取权限", operations: [
        op("feishu.docs.read", "Read docs and drive", "读取文档和云空间", "read", "allow"),
        op("feishu.calendar.read", "Read calendar", "读取日历", "read", "allow"),
        op("feishu.mail.read", "Read mail", "读取邮件", "read", "allow"),
      ] },
      { id: "write", label: "Write and delete access", labelZh: "写入和删除权限", operations: [
        op("feishu.write", "Edit docs, events and mail", "修改文档、日程和邮件", "write", "ask"),
      ] },
    ] };
    case "browser": return { groups: [
      { id: "read", label: "Read access", labelZh: "读取权限", operations: [
        op("browser.open", "Open pages and read content", "打开网页并读取内容", "read", "allow"),
        op("browser.download", "Save screenshots and downloads", "保存截图和下载", "read", "allow"),
      ] },
      { id: "write", label: "Write and delete access", labelZh: "写入和删除权限", operations: [
        op("browser.upload", "Upload files", "上传文件", "write", "ask"),
      ] },
    ] };
    default: return null;
  }
}

export const settingLabels: Record<PolicySetting, [string, string]> = { allow: ["允许", "Allow"], ask: ["请求", "Ask"], deny: ["不允许", "Don't allow"] };
