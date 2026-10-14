# 共享工作区

Mau 保存工作区身份、账号归属和 Agent 绑定；Environment 通过官方 TOS SDK 和
VKE/VCI 静态 CSI 卷读写持久文件。Host 与内核继续使用普通的
`/home/user/workspace` 目录。

运营者先按 Agent Environment 的 `docs/workspaces.md` 配置私有 bucket、CSI、
受限 Kubernetes 身份、TOS 身份和带 Python 3 的 Host 镜像。随后在 Mau 配置中增加：

```json
{
  "environments": {
    "configFile": "providers.json",
    "workspaceConfigFile": "workspace/workspace.json",
    "profiles": [{
      "id": "shared-codex",
      "label": "Codex with persistent workspace",
      "owners": ["@alice:agents.example"],
      "provider": "volc",
      "template": "default--your-host-template",
      "kernel": "codex",
      "runtimeId": "personal",
      "hostConfigFile": "cloud/host-profile.json",
      "workspace": true,
      "directory": "/home/user/.agent-host-service",
      "port": 37420,
      "lifetimeSeconds": 3600,
      "onTimeout": "kill",
      "files": []
    }]
  }
}
```

这是一段配置示例；保留现有 Router 和其他方案设置。Host runtime 的 `cwd` 必须为
`/home/user/workspace`。Host 状态目录和注入的私有配置必须位于工作区之外。
不要直接更改已有绑定方案的模板或 `workspace` 标志；增加新方案后创建新 Agent。

```sh
mau workspace-create project
# 取返回的 id
mau setup designer --environment shared-codex --workspace WORKSPACE_ID
mau setup developer --environment shared-codex --workspace WORKSPACE_ID
mau workspaces
```

支持工作区的方案省略 `--workspace` 时会自动创建独立工作区。只有同一账号拥有的
工作区可被绑定；跨账号请求返回不存在。Agent 绑定后不能切换工作区。
创建结果会返回 `workspaceId`，恢复和操作恢复沿用原绑定。

## 文件 API

以下接口均使用现有 Router 账号 Bearer token，根路径为 `/_mau/v1`：

| 方法与路径 | 行为 |
| --- | --- |
| `GET /workspaces` | 列出当前账号工作区 |
| `POST /workspaces`，JSON `{ "name": "project" }` | 创建工作区身份 |
| `GET /workspaces/:id` | 查看名称、ID、创建时间 |
| `GET /workspaces/:id/files?prefix=docs` | 递归列出文件元数据 |
| `PUT /workspaces/:id/file?path=docs/brief.md` | 原始字节上传，`application/octet-stream`，最大 16 MiB |
| `DELETE /workspaces/:id/file?path=docs/brief.md` | 删除指定文件 |
| `GET /workspaces/:id/download?path=docs/brief.md` | 返回文件元数据和有效 60 秒的签名下载 URL |

通过标准 URL 查询参数编码文件名；`%2f` 等字符被当成字面文件名。拒绝目录穿越、
控制字符和 `.oma-workspace-checks` 保留目录。服务不向客户端返回云凭据、bucket
或 Kubernetes 资源。签名 URL 在有效期内可由持有者下载。

## 持久化与失败处理

创建容器前保存可信工作区绑定，取得环境 ID 后先持久记录，再检查实际挂载与独立
TOS 读回。验证通过后才注入凭证、启动 Host。恢复环境以及 Mau 重启后的首次使用
必须重新验证；验证失败进入待处理状态，不回退到本地空目录。

共享文件在关闭文件、写入成功后持久保存；并发写同一路径会互相覆盖，不能把对象
存储挂载视为事务文件系统。原生登录态、会话和 Host 状态仍由容器自己的快照保存，
不会随工作区共享。销毁 Agent 环境保留工作区文件；工作区整体删除、版本历史和
保留期管理尚未提供产品入口。PV/PVC/模板及快照的清理由运营者单独处理。

备份 `MAU_STATE/mau/environments.sqlite`（工作区身份和绑定）和私有云配置，并
按现有方式备份 Router 与 Host 状态。只备份 TOS 文件无法恢复账号和绑定关系。
