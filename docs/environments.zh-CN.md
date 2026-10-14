# 环境开通与部署

[English](environments.md)

Mau 负责产品开通、环境绑定、Host 初始化、续期、暂停恢复和操作恢复。Router 负责账号、渠道凭据、消息归属与投递；Host 保留原生内核；Environment 操作云资源。

使用 Node.js 24+ 和已登录的 GitHub CLI。固定版本的 Router、Environment 安装包通过 Mau 的公开 GitHub Releases 分发，Environment 源码仓库的可见性单独管理。运行 `node scripts/bootstrap.mjs` 下载并安装这些独立组件包，再运行 `npm run build`。无需相邻源码仓库或私有组件仓库的访问权限。

运营者准备已有 Matrix Application Service、沙箱服务和模板。模板安装 Host 与原生内核，以 `serve --ready-file` 等待私有配置；Host 状态、原生会话和工作区需要持久化。

将 [mau.json](../examples/mau.json) 与 [Host 配置](../examples/cloud/host-profile.json) 复制到仓库外，准备私有 providers.json 和密钥文件，调整相对路径。环境方案指定允许的 Router 账号、云模板、内核和 Host 配置。个人登录状态通过私有文件注入，不进入共享镜像。

设置 Matrix 服务配置、`MAU_CONFIG_FILE` 和 `MAU_STATE` 后运行 `mau-server`。完整变量与代理要求见[英文说明](environments.md)。Mau 进程内组合 Router；同一服务身份和渠道只能有一个消费者。

```sh
mau login --url https://mau.example --user '@alice:agents.example' --password-file /private/password
mau options
mau setup helper --environment cloud-codex
mau channel-connect feishu
mau check
mau status
mau pause
mau resume
```

`MAU_STATE/router/` 保存通信状态，`MAU_STATE/mau/` 保存环境日志和 Host token。需要同时备份，并单独持久保存原生会话与工作区。暂停、销毁会先停止投递 worker，存在活动或未知结果的任务时拒绝操作；恢复复用原环境和会话绑定。

中断或结果不确定的操作使用 `mau reconcile` 核对，不盲目重新购买环境。`--no-wait` 返回持久化进度；退出 CLI 不取消开通。续期失败进入待处理状态，云端到期行为取决于方案。

公开仓库只有通用模板。真实地址、资源 ID、部署拓扑、凭据和用户数据留在私有配置中。旧 Router 产品入口已删除，没有兼容别名或自动生产数据迁移。
