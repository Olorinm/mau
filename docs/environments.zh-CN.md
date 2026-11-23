# 环境开通与部署

[English](environments.md)

Mau 负责产品开通、环境绑定、Host 初始化、续期、暂停恢复和操作恢复。Router 负责账号、渠道凭据、消息归属与投递；Host 保留原生内核；Environment 操作云资源。

使用 Node.js 24+。运行 `node scripts/bootstrap.mjs` 下载 `components.json` 锁定的 Agent Kit 发布包并安装依赖，随后运行 `npm run build`。

运营者把服务放在 Cloudflare Access 之后，在 `mau.json` 中配置 `edgeIdentity`（唯一的所有者登录方式，未配置时 Mau 拒绝启动），并准备沙箱服务和模板。模板安装 Host 与原生内核，以 `serve --ready-file` 等待私有配置；Host 状态、原生会话和工作区需要持久化。

将 [mau.json](../examples/mau.json) 与 [Host 配置](../examples/cloud/host-profile.json) 复制到仓库外，准备私有 providers.json 和密钥文件，调整相对路径。环境方案指定允许的 Router 账号、云模板、内核和 Host 配置。个人登录状态通过私有文件注入，不进入共享镜像。

Mau 部署在 Cloudflare 上：一个 Worker 加一个容器，配置和状态放在 R2，见[部署说明](deployment.md)（英文）。`mau-server` 读取 Router 服务配置（`MATRIX_SERVER_NAME` 仅作为账号命名空间，`AGENT_SERVICE_URL`）、`MAU_CONFIG_FILE` 和 `MAU_STATE`；可选 `MAU_WEB_ROOT` 同域提供 [Web 控制台](web.zh-CN.md)。Mau 进程内组合 Router，且不使用 Matrix；同一状态目录和渠道只能有一个进程。

```sh
cloudflared access login https://mau.example
mau login https://mau.example
mau profiles
mau partner create helper --profile codex
mau channel connect helper feishu
mau partner check helper
mau partner show helper
mau env pause helper
mau env resume helper
```

`MAU_STATE/router/` 保存通信状态，`MAU_STATE/mau/` 保存环境日志和 Host token，由部署负责复制和备份；原生会话与工作区在执行环境里，需单独持久保存。暂停、销毁会先停止投递 worker，存在活动或未知结果的任务时拒绝操作；恢复复用原环境和会话绑定。

中断或结果不确定的操作使用 `mau env reconcile NAME` 核对，不盲目重新购买环境。`--no-wait` 返回持久化进度；退出 CLI 不取消开通。续期连续三次失败后进入待处理状态；明确检测到环境已停止时立即处理。手动生命周期操作会等待已开始的续期完成，云端到期行为取决于方案。

方案可显式设置 `idlePauseSeconds`：空闲后暂停环境，仅在存在可投递且已授权的工作时唤醒。默认不自动暂停；手动暂停不会被消息自动唤醒。

已有绑定的云服务、模板、内核、runtime ID、Host 目录和端口不能修改；显示名、账号、指令、时长、空闲、初始化文件设置以及方案提供的[其他内核](#一个环境里的多个内核)可以修改。

公开仓库只有通用模板。真实地址、资源 ID、部署拓扑、凭据和用户数据留在私有配置中。旧 Router 产品入口已删除，没有兼容别名或自动生产数据迁移。

## 一个环境里的多个内核

环境有一个主内核（`kernel`、`runtimeId`）。方案可以用 `otherKernels` 再提供几个内核，给[共用该环境](#伙伴共用环境)的伙伴使用：每个内核是同一个 Host 进程里的另一个 runtime，同一个沙箱、同一个工作目录。这样换内核不需要新容器；需要隔离时仍应使用独占环境。

```json
{
  "kernel": "codex",
  "runtimeId": "personal",
  "otherKernels": [
    { "kernel": "claude", "runtimeId": "claude",
      "files": [{ "source": "/private/alice/claude-settings.json", "destination": "/home/user/.claude/settings.json" }] }
  ],
  "hostConfigFile": "cloud/host-two-kernels.json"
}
```

- `otherKernels` 最多四项，只写模板里已安装、有凭证、打算用的内核；目前接受 `codex`、`claude`、`agy`（Google Antigravity，见[下文](#antigravity-伙伴)）和 `dsh`（DeepSeek Harness），自带网关的内核不在此列。同一方案内内核和 runtime ID 都不能重复。
- Host 配置里必须有对应 `id` 和 `kernel` 的 runtime，且 `cwd` 与主 runtime 相同，否则创建环境返回 `environment_runtime_profile_mismatch`。示例见 [host-two-kernels.json](../examples/cloud/host-two-kernels.json)，Mau 原样上传该文件。
- 每项的 `files` 是该内核的私有文件（模型凭证），创建环境时和方案自己的 `files` 一起上传，权限 0600。凭证按内核注入，不按伙伴隔离：沙箱里所有伙伴以同一个用户运行，各内核、各伙伴都能读到其他内核的凭证文件；不能接受时请使用独占环境。凭证不进仓库，也不写进 Host 配置。
- 方案声明了 `otherKernels` 时，每次创建和恢复环境，Mau 把全部内核需要的模型服务告诉云服务：`codex` 对应 `openai`，`claude` 对应 `anthropic`，`agy` 对应 `google`，`dsh` 对应 `deepseek`。网关只放行这些服务里审核过的地址；私有模型网关或其他服务商需要改网关规则。没有 `otherKernels` 的方案不指定，发给云服务的请求与之前完全相同，由网关默认值决定。网关会保留最后一次收到的列表：从方案里去掉 `otherKernels` 后，已有环境仍沿用较宽的列表，需要运营者在网关侧重置。
- `modelAccounts` 把环境限定在自己的模型账号上。被诱导的 Agent 否则可以带着别人的登录凭证，把数据发到同一家模型服务的另一个账号里；设置后网关拒绝携带其他账号令牌的 ChatGPT 后端请求，也拒绝 `api.openai.com`。不写时，Mau 从方案的 Codex 登录文件（`files` 里目标路径以 `/.codex/auth.json` 结尾的那一项）读出 ChatGPT 账号（访问令牌里的账号，其次是 `tokens.account_id`），每次创建和恢复环境时一并发给云服务。写 `"modelAccounts": { "openai": ["<账号 ID>", …] }` 可自行指定（最多八个），写 `"modelAccounts": false` 则不发送。登录文件使用 API key 或读不出账号时不发送：这类环境需要 `api.openai.com`，限定账号后无法访问。网关在环境下次启动时生效，并保留最后一次收到的账号。已存在的环境在下次恢复时生效；想立即生效，暂停后再恢复。
- `otherKernels` 不属于环境的身份标识：之后再加内核不会让已有绑定和会话失效，已有伙伴的 runtime 不变。Mau 不改写已存在环境里的文件：需要自己把 runtime 加进沙箱的 `host.json`（同时更新 `ready.json` 的哈希）、放好凭证，让方案的 Host 配置与之逐字节一致，并等 Host 重启；出口放行在环境下一次恢复时生效。
- 伙伴的内核在创建时选定（`shareWith` 旁的 `kernel`，或[招募](native-work.md#partners)时的 `kernel`），之后不能改；不填就用主内核。方案没有提供的内核返回 `environment_kernel_not_available` 和 `kernels`；Host 里没有或不可用的返回 `environment_kernel_not_ready`。`GET /_mau/v1/options` 列出方案的 `kernels`，Agent 概要里的 `kernel` 是它自己运行的内核。

内核之间的差异留给内核自己：各自读自己的说明文件和技能目录（Codex 读 `AGENTS.md`，Claude 读 `CLAUDE.md`，可以在工作目录的 `CLAUDE.md` 里引用前者），各自的权限设置也在各自的 runtime 配置里。由伙伴消息发起的一轮无法询问所有者，所以默认每条命令都要确认的内核，需要在 runtime 配置里设成不需交互的权限模式才能在这种轮次里工作。不同内核的伙伴共享文件，不共享原生上下文，彼此只通过[消息](native-work.md#partners)交换信息。非 Codex 伙伴能用和不能用的能力见[英文说明](native-work.md#partners-on-another-kernel)。

### 四个伙伴共用一个工作区

使用[四伙伴 Mau 配置](../examples/mau-four-partners.json)和[Host 配置](../examples/cloud/host-four-partners.json)。lead 用 Claude，backend 和 reviewer 各自开一个 Codex 会话，advisor 用 Antigravity。四人都在 `/home/user/workspace` 工作。样例中的 `personal-gmail` 和 `team-browser` 要换成连接器实际使用的 ID。

1. 将样例复制到 Mau 私有配置目录，填好所有者、服务地址和 `private/` 下的凭据路径。按示例放好已验证的 Host 包、校验清单、同版本 Agent Kit 的 Cloudflare 启动脚本及 `official-skills.tgz`。`node24` 会安装 Codex 和带摘要校验的 Linux 版 Antigravity。Host 包自带 Claude Agent SDK。
2. 在运营端提供 Anthropic API key、Gemini API key、Codex 登录文件和限定作用域的 GitHub token。Gemini 使用[样例设置文件](../examples/cloud/agy-settings.json)。样例中的 `anthropicCredentialFile` 和 `githubCredentialFile` 按 Mau 配置目录解析。保留字段时，文件须在创建或恢复环境前存在且可读。无需 GitHub 访问时可移除 `githubCredentialFile`；更换 Claude 的认证方式时需同时配置可用的提供方。Mau 将模型和 GitHub 的凭据交给网关，连接器签名私钥保存在 Mau 端。
3. 创建名为 `lead` 的伙伴，选择 `shared-team` 环境。在和 lead 的私聊里让它先用 `partners` 的 `action=roster` 检查环境，再用 `action=recruit` 招募三人。backend（`codex`）负责实现和测试；reviewer（`codex`）独立审查代码；advisor（`agy`）评审方案。招募后再查一次 roster，核对四个人的名字和内核。
4. 打开 Mau 连接器设置，把个人飞书、个人邮箱只分给 lead，再分别给下属分配工作连接。每项操作的允许、询问或拒绝设置保存在连接上。样例启用 `employee` 权限模式，终端可转发的工具限定为 `connected_apps`。lead 派活时，下属的连接器审批卡回到 lead 的会话。

backend 和 reviewer 共用 `implementation` 运行时的沙箱和审批配置。两人的会话 ID 和 Mau 员工 ID 各自独立，撤掉其中一人的飞书连接不会改变另一人的分配。两人分到同一个连接时，适用该连接的同一套操作规则。沙箱内的进程共用系统账号，可以读取彼此的会话 ID；此模式适合互相信任的伙伴。

官方技能安装在 `/home/user/.agents/skills`。用同一套 Linux 目录实测，默认的 Codex 0.171.0 和可选的 DSH 0.2.2-rc.5 各自在模型请求中列出全部 38 个官方技能，另有一项 `mau-sandbox`。DSH 通过原生技能工具逐项加载时也从这个目录读取。无需把同一批文件再复制到 `.codex/skills`。

两名 Codex 伙伴都用原生 Auto，即允许在工作区写入，越界时按需申请。样例额外开启工作区网络，使它们能访问本机转发端口、验收网页及网关放行的外部服务。只有 advisor 的启动命令带 Antigravity 的跳过审批参数。连接器的允许、询问、拒绝仍由 Mau 和连接器服务执行。[Codex 官方审批说明](https://developers.openai.com/codex/agent-approvals-security/)

### Git、GitHub CLI 和 Claude 的凭据

Cloudflare 环境可以在方案中设置 `githubCredentialFile`，指向运营端保存 GitHub 访问令牌的文件。令牌能访问哪些仓库、能读还是能写，由 GitHub 上授予的权限决定。Mau 在创建和恢复环境时将它交给网关。伙伴可以直接使用 HTTPS Git 远程地址和 `gh` 命令拉取、推送和处理 PR。同一环境里的伙伴共用这项授权。Git 和 `gh` 通过网关访问 GitHub，没有 Mau 连接器审批卡。换令牌后暂停并恢复环境即可轮换，去掉这个字段后暂停并恢复即可撤销该环境的访问。

Claude 使用官方 Anthropic API 时，方案中同样可设置 `anthropicCredentialFile`。沙箱中的 `ANTHROPIC_API_KEY` 是占位值，网关在允许的推理与模型查询请求上注入真实密钥。运营端的凭据文件须与方案中上传到沙箱的 `files` 分开。启动脚本会离线安装固定版本的官方连接器技能和单独的 Mau 沙箱补充说明。

### DeepSeek Harness 伙伴

把 `{"kernel":"dsh","runtimeId":"dsh"}` 加到 `otherKernels`，并在 Host 配置里启用该 runtime。DSH 也可以用作主内核。方案顶层的 `deepseekCredentialFile` 指向运营端的 API 密钥文件。创建和恢复环境时，Mau 把密钥交给网关，沙箱内的 `DEEPSEEK_API_KEY` 是占位值。Cloudflare 启动脚本会为选择 DSH 的环境安装固定版本的官方 CLI。其他模板需要提前把 `dsh` 装进 Host 的 PATH。[Host 配置示例](../examples/cloud/host-dsh-partner.json)

### Antigravity 伙伴

`agy` 是 Google 的 Antigravity 命令行，Agent Host 通过它的 ACP 服务（`agy acp`）运行它，让环境里多一个跑 Gemini 的伙伴。需要带 `agy` 内核的 Agent Host 和带 `google` 模型服务的 Environment 网关；Agent Kit 版本没有它们时，网关会拒绝创建环境（`invalid_model_services`），Host 也无法用这份配置启动。

```json
"otherKernels": [{ "kernel": "agy", "runtimeId": "agy", "files": [
  { "source": "/private/alice/agy-settings.json", "destination": "/home/user/.gemini/antigravity-cli/settings.json" },
  { "source": "/private/alice/gemini-api-key", "destination": "/home/user/.gemini/api-key" }
] }],
"hostConfigFile": "cloud/host-agy-partner.json"
```

- **runtime 配置**见 [host-agy-partner.json](../examples/cloud/host-agy-partner.json)。`model` 和 `allowedSettings.model` 的值是 Antigravity 模型选择器里的 ID，即 `agy models` 列出的 ID 去掉思考强度；`effort` 是它的思考强度。`allowedSettings.effort` 只写所列模型都支持的强度：Antigravity 不提供 Mau 能读取的逐模型列表，模型不支持的强度会让这一轮失败。
- **权限。**Antigravity 执行命令前会询问，这些请求会成为所有者对话里的审批卡。由伙伴消息发起的一轮无法询问，所以伙伴用的 runtime 要写 `"args": ["acp", "--dangerously-skip-permissions"]`。只设 `auto` 模式（`"config": {"mode": "auto"}`）不够：它自动放行编辑和安全命令，但调用 Mau 的每个工具（`partners`、`memory`、`connected_apps`）前仍会询问，这一轮会一直等到 Host 的超时。加上该参数后，约束伙伴的是沙箱和出口网关；Mau 自己的审批（例如连接器写操作）不受影响。
- **命令。**模板里要有 `agy`，并在 Host 用户的 `PATH` 上（或用 `command` 指定路径）。Cloudflare 启动脚本按 Host 方案安装固定版本的 Linux CLI。
- **凭证。**使用 Gemini API key。Antigravity 需要两样东西，缺一不可：`/home/user/.gemini/antigravity-cli/settings.json` 里的 `{"modelProvider": "gemini"}`（通过该项的 `files` 放入），以及 `agy` 进程环境里的 `GEMINI_API_KEY`。key 是凭证，不写进 Host 配置：通过 `files` 以 0600 文件放入，目标路径以 `/.gemini/api-key` 结尾，由 runtime 的 `command` 读取，示例就是这样做的。这里不支持 Antigravity 的 Google 账号登录：登录状态存在桌面钥匙串里，沙箱没有，`google` 服务也不放行它用到的地址。
  - **网关能代持凭证时**（Cloudflare），Mau 把 key 交给网关，真 key 不进沙箱：沙箱里的文件内容是占位值 `gateway-managed`（Antigravity 只检查它非空），发往 `generativelanguage.googleapis.com` 的请求无论带着什么 key 或令牌，网关都会换成所有者的 key。每次创建和恢复环境，Mau 都把 key 重新存到网关，所以轮换 key 时改掉文件内容，再恢复该方案的任意一个环境即可：网关立即改用新 key，共用这个文件的所有环境都生效。网关代持之前创建的环境，下次恢复时沙箱里的真 key 会被换成占位值。文件内容是一行一个 key，一个方案只能有一个这样的文件。
  - **云服务不支持代持时**，文件原样放入沙箱，和其他内核的凭证一样，环境里所有伙伴都能读到它。同一份 Host 配置两种情况都能用。
- **网络。**`google` 服务在 `generativelanguage.googleapis.com` 上放行什么，取决于 key 在谁手里。网关代持时，放行那里的整个 Gemini API，任意路径和方法（模型列表、文件、缓存、其他生成接口）：伙伴只能用所有者的 key，发出去的数据到不了别人的账号。key 在沙箱里时，只放行一轮对话发出的那一种请求，`POST /v1beta/models/<模型>:streamGenerateContent`：网关分辨不出请求带的是谁的 key（`modelAccounts` 只支持 `openai`），放行更多的话，被诱导的伙伴可以带着别人的 key 把所有者的文件上传到别人的项目里。使用 API key 时 Antigravity 只提供 Gemini 模型，伙伴能选哪些由 runtime 的 `allowedSettings` 决定。
- **说明文件。**Antigravity 按自己的规则读它的规则文件（`AGENTS.md`、`GEMINI.md`），Mau 两者都不写。

## 伙伴共用环境

伙伴默认拥有独占环境，也可以在同一账号下另一个伙伴的环境里运行：同一个沙箱、Host、runtime 和工作目录，创建时不申请云资源。它仍然是完整的 Agent，有自己的 Router 身份、会话、记忆、定时任务和模型设置。

`POST /_mau/v1/agents` 接收 `name`，以及 `profileId`（独占环境）或 `shareWith`（被共用伙伴的 ID，可同时带 `kernel` 选择该环境方案提供的内核）二者之一；两种方式都可以带 `duty`（一行纯文本职责，最长 200 字符，创建后不可修改）。读取接口返回 `duty`，并在 `environment` 中用 `sharedFrom`（共用谁的环境）和 `sharedBy`（被哪些伙伴共用）说明关系。

- 被共用的伙伴必须属于同一账号、拥有未销毁的独占环境；不能共用另一个共用者的环境。
- 共用者的 Host 请求、自检和文件转发都落到被共用的环境及其 Host token；固定说明为环境方案的固定说明加一段包含名字和职责的身份说明。拥有环境的伙伴的固定说明不变。
- 空闲暂停按环境内所有伙伴的活动计算；任何一个伙伴有待投递的工作都会唤醒休眠的环境。
- 共用者只能读取环境状态，暂停、恢复、核对、销毁、替换、回滚和 SSH 请求返回 `environment_shared_from_partner`。
- 环境仍被共用时，销毁、替换、回滚环境和删除其伙伴返回 `environment_shared_by_partners` 及 `partners` 列表；需先删除共用者。删除共用者只清理它自己的记录，不影响环境。
- 共用者没有单独的连接器分配时，沿用被共用伙伴的分配；个人身份类连接的规则不变。

同一环境内的伙伴能看到相同的文件、原生内核目录和登录状态；需要隔离时应使用独占环境。完整说明见[英文文档](environments.md#partners-sharing-an-environment)。

## 环境内的浏览器

[云端浏览器](connector-accounts.md#connector-clis-and-guides-in-the-agents-environment)运行在环境之外，拒绝回环和内网地址，打不开伙伴在 `http://localhost:端口` 上跑起来的页面。为此环境自带一个浏览器，来自 Environment 的[启动脚本](https://github.com/Olorinm/agent-kit/blob/main/packages/environment/cloudflare/examples/start-host.sh)（部署里的 `cloud/start-host.sh`）：

- Debian 的 `chromium-headless-shell` 和西文、中日韩、表情字体，以及未经改动的官方 [agent-browser](https://github.com/vercel-labs/agent-browser) CLI：从 npm 安装到 `/opt/local-browser`，版本与 Agent Connectors 锁定的一致，只保留本机架构的可执行文件。下载约 285 MB，占磁盘约 670 MB。Chromium 的版本跟随 Debian 的发布和更新，不从浏览器厂商下载，与本仓库 CI 锁定的 Playwright 无关。
- 用 `/opt/local-browser/agent-browser` 运行这个 CLI。这个文件只有几行 shell：把 `AGENT_BROWSER_EXECUTABLE_PATH` 设为上述 Chromium，把 `AGENT_BROWSER_ARGS` 设为容器里以非 root 用户运行 Chromium 所需的参数（`--no-sandbox`：隔离边界是环境本身；`--disable-dev-shm-usage`：`/dev/shm` 很小），设 `AGENT_BROWSER_NO_VERSION_CHECK=1`（CLI 对 Chrome 新版本的检查要访问外网），然后把全部参数交给 CLI。它不在 `PATH` 上：`/usr/local/bin/agent-browser` 仍是 Mau 的云端浏览器客户端。
- 安装在环境首次启动后于后台进行，Host 就绪时间不变，结果保存在环境快照里。几分钟后装完时 `/opt/local-browser/agent-browser` 才出现；安装输出在 `/var/log/local-browser-install.log`。
- CLI 在两次命令之间保留一个带着浏览器的常驻进程，以运行它的用户身份运行，socket 和会话文件在 `/home/user/.agent-browser`。`close`、一小时没有命令或环境暂停时结束。
- 这个浏览器不能访问外网：环境的出口网络不放行任何网站。
- Mau 在创建环境时上传这个脚本，恢复的环境运行的是快照里的那一份。因此脚本更新前创建的环境没有这个浏览器，[替换环境](environment-replacement.md)后才有。
- 自备镜像且不运行这个脚本时，需要自行装上同样的软件包和文件。

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
