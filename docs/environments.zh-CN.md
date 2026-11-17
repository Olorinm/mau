# 环境开通与部署

[English](environments.md)

Mau 负责产品开通、环境绑定、Host 初始化、续期、暂停恢复和操作恢复。Router 负责账号、渠道凭据、消息归属与投递；Host 保留原生内核；Environment 操作云资源。

使用 Node.js 24+。运行 `node scripts/bootstrap.mjs` 下载 `components.json` 锁定的 Agent Kit 发布包并安装依赖，随后运行 `npm run build`。

运营者把服务放在 Cloudflare Access 之后，在 `mau.json` 中配置 `edgeIdentity`（唯一的所有者登录方式，未配置时 Mau 拒绝启动），并准备沙箱服务和模板。模板安装 Host 与原生内核，以 `serve --ready-file` 等待私有配置；Host 状态、原生会话和工作区需要持久化。

将 [mau.json](../examples/mau.json) 与 [Host 配置](../examples/cloud/host-profile.json) 复制到仓库外，准备私有 providers.json 和密钥文件，调整相对路径。环境方案指定允许的 Router 账号、云模板、内核和 Host 配置。个人登录状态通过私有文件注入，不进入共享镜像。

设置 Router 服务配置（`MATRIX_SERVER_NAME` 仅作为账号命名空间，`AGENT_SERVICE_URL`）、`MAU_CONFIG_FILE` 和 `MAU_STATE` 后运行 `mau-server`；可选 `MAU_WEB_ROOT` 同域提供 [Web 控制台](web.zh-CN.md)。完整变量与代理要求见[英文说明](environments.md)。Mau 进程内组合 Router，且不使用 Matrix；同一状态目录和渠道只能有一个进程。

```sh
cloudflared access login https://mau.example
mau login --url https://mau.example
mau options
mau setup helper --environment cloud-codex
mau channel-connect feishu
mau check
mau status
mau pause
mau resume
```

`MAU_STATE/router/` 保存通信状态，`MAU_STATE/mau/` 保存环境日志和 Host token。需要同时备份，并单独持久保存原生会话与工作区。暂停、销毁会先停止投递 worker，存在活动或未知结果的任务时拒绝操作；恢复复用原环境和会话绑定。

中断或结果不确定的操作使用 `mau reconcile` 核对，不盲目重新购买环境。`--no-wait` 返回持久化进度；退出 CLI 不取消开通。续期连续三次失败后进入待处理状态；明确检测到环境已停止时立即处理。手动生命周期操作会等待已开始的续期完成，云端到期行为取决于方案。

方案可显式设置 `idlePauseSeconds`：空闲后暂停环境，仅在存在可投递且已授权的工作时唤醒。默认不自动暂停；手动暂停不会被消息自动唤醒。

已有绑定的云服务、模板、内核、runtime ID、Host 目录和端口不能修改；显示名、账号、指令、时长、空闲和初始化文件设置可以修改。

公开仓库只有通用模板。真实地址、资源 ID、部署拓扑、凭据和用户数据留在私有配置中。旧 Router 产品入口已删除，没有兼容别名或自动生产数据迁移。

## 伙伴共用环境

伙伴默认拥有独占环境，也可以在同一账号下另一个伙伴的环境里运行：同一个沙箱、Host、runtime 和工作目录，创建时不申请云资源。它仍然是完整的 Agent，有自己的 Router 身份、会话、记忆、定时任务和模型设置。

`POST /_mau/v1/agents` 接收 `name`，以及 `profileId`（独占环境）或 `shareWith`（被共用伙伴的 ID）二者之一；两种方式都可以带 `duty`（一行纯文本职责，最长 200 字符，创建后不可修改）。读取接口返回 `duty`，并在 `environment` 中用 `sharedFrom`（共用谁的环境）和 `sharedBy`（被哪些伙伴共用）说明关系。

- 被共用的伙伴必须属于同一账号、拥有未销毁的独占环境；不能共用另一个共用者的环境。
- 共用者的 Host 请求、自检和文件转发都落到被共用的环境及其 Host token；固定说明为环境方案的固定说明加一段包含名字和职责的身份说明。拥有环境的伙伴的固定说明不变。
- 空闲暂停按环境内所有伙伴的活动计算；任何一个伙伴有待投递的工作都会唤醒休眠的环境。
- 共用者只能读取环境状态，暂停、恢复、核对、销毁、替换、回滚和 SSH 请求返回 `environment_shared_from_partner`。
- 环境仍被共用时，销毁、替换、回滚环境和删除其伙伴返回 `environment_shared_by_partners` 及 `partners` 列表；需先删除共用者。删除共用者只清理它自己的记录，不影响环境。
- 共用者没有单独的连接器分配时，沿用被共用伙伴的分配；个人身份类连接的规则不变。

同一环境内的伙伴能看到相同的文件、原生内核目录和登录状态；需要隔离时应使用独占环境。完整说明见[英文文档](environments.md#partners-sharing-an-environment)。

## SSH

SSH 复用 Environment 的公开命令执行、文件写入和应用端口接口，Host 无需修改。
在方案中添加 `"ssh": { "port": 37421 }` 开启；该端口须与 Host 端口不同。
镜像需要 Node.js、OpenSSH server/client 和 `/run/sshd`，可参考
[Dockerfile.ssh](../examples/cloud/Dockerfile.ssh)。不要在共享镜像中保留 SSH Host 私钥。

`mau ssh NAME` 首次连接时生成独立 Host key，以环境原有执行用户启动 OpenSSH。
账号归属在开通和建立连接时分别检查；客户端使用临时 Ed25519 key，并校验服务返回的 Host 公钥。
SSH 原始字节流通过 HTTPS 的 `Upgrade: mau-ssh` 隧道传输，前置代理和环境应用端口网关必须支持 HTTP Upgrade。
容器只运行内部 HTTP 桥接入口，不需要对公网逐个开放 22 端口。
使用 `createMau` 自行启动 HTTP server 时，调用 `mau.attach(server)` 接入升级请求。

每个 Agent 最多同时有 8 个连接或开通请求。活动连接阻止空闲暂停和手动生命周期操作，续期仍继续；暂停后必须先恢复再连接。
SSH 使用者能够读写执行用户已有的文件和凭据；SSH 入口不改变环境原有的网络和凭据策略。
