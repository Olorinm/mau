# 环境开通与部署

[English](environments.md)

Mau 负责产品开通、环境绑定、Host 初始化、续期、暂停恢复和操作恢复。Router 负责账号、渠道凭据、消息归属与投递；Host 保留原生内核；Environment 操作云资源。

使用 Node.js 24+ 和已登录的 GitHub CLI。运行 `node scripts/bootstrap.mjs` 下载锁定的组件包；账号需要有私有 Environment 仓库的读取权限。也可以用 `--environment-archive /path/agent-environment.tar` 提供锁文件指定的本地包。随后运行 `npm run build`。Environment 0.2 基于 OMA 提取，尚未公开分发。

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

中断或结果不确定的操作使用 `mau reconcile` 核对，不盲目重新购买环境。`--no-wait` 返回持久化进度；退出 CLI 不取消开通。续期连续三次失败后进入待处理状态；明确检测到环境已停止时立即处理。手动生命周期操作会等待已开始的续期完成，云端到期行为取决于方案。

方案可显式设置 `idlePauseSeconds`：空闲后暂停环境，仅在存在可投递且已授权的工作时唤醒。默认不自动暂停；手动暂停不会被消息自动唤醒。

公开仓库只有通用模板。真实地址、资源 ID、部署拓扑、凭据和用户数据留在私有配置中。旧 Router 产品入口已删除，没有兼容别名或自动生产数据迁移。

## SSH

SSH 复用 Environment 的公开命令执行、文件写入和应用端口接口，OMA 与 Host 无需修改。
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
