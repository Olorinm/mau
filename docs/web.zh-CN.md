# Web 控制台

[English](web.md)

控制台（`web/src`）用 [`web/ui`](../web/ui/README.md) 里的 `@olorinm/agent-ui` 组装页面（页面布局在 `./pages`，底层组件在 `.` 与 `./app`）。
组件包只接收数据、React 内容和回调，不依赖 Mau、Router、Host 或 Environment。认证、导航、接口请求和环境/渠道流程都在 `web/src`。

控制台提供与自有员工的对话（单聊和群聊）、员工创建与管理、环境生命周期、渠道连接、连接器账号和设置。
它只访问同域的 Mau（`/_mau/v1`）和内嵌的 Router（`/_agent-router/v1`）；浏览器不持有 Host 凭据，也不直连执行环境。
“新建应用”和“App 商店”入口保留，明确显示“尚未接入”，没有对应后端。

`web/` 是 npm workspace，`web/package-lock.json` 同时锁定控制台与 `web/ui`；`npm run build:web` 先构建 `web/ui`。

## 开发

```sh
node scripts/bootstrap.mjs            # 同时安装 web/ 依赖
MAU_CONFIG_FILE=/private/mau.json npm start
npm run dev:web                        # 先构建 web/ui，Vite 运行在 5173，/_mau 和 /_agent-router 代理到 8790
```

用 `MAU_DEV_BACKEND_URL` 代理到其他服务。

## 部署

```sh
npm run build:web
MAU_WEB_ROOT=web/dist MAU_CONFIG_FILE=/private/mau.json npm start
```

设置 `MAU_WEB_ROOT` 后，`mau-server` 以和接口相同的域名提供控制台，不需要配置跨域。以 `/_` 开头的路径和 `/health` 路由不会返回页面。[Dockerfile](../Dockerfile) 会构建控制台并设置 `MAU_WEB_ROOT=/app/web`。

服务端发布包包含 `web/dist`；安装发布包后，将 `MAU_WEB_ROOT` 指向已安装 Mau 包中的该目录。`npm pack` 会先构建服务端和控制台。

页面的内容安全策略只允许连接同域。唯一允许嵌入的页面是员工交给所有者操作的浏览器实时画面。

## 登录（Cloudflare Access）

控制台没有登录页，也不保存令牌，唯一的登录方式是边缘身份：`mau.json` 配置 `edgeIdentity`（与 Router 的 `edgeIdentity` 同形）后，Router 对每个 `/_mau/v1`、`/_agent-router/v1` 所有者请求和 SSH 升级校验 `Cf-Access-Jwt-Assertion` JWT，并按配置把邮箱（或服务令牌）映射到所有者；从不信任明文邮箱头或 `CF_Authorization` cookie。`GET /_mau/v1/info` 返回 `{ "login": "edge", "logoutUrl": "/cdn-cgi/access/logout" }`。没有配置 `edgeIdentity`（`edge_identity_required`）或没有开启 Router 账本（`ledger_read_required`）时 Mau 拒绝启动；Mau 始终以关闭 Matrix 的方式运行 Router，不配置也不访问任何 Matrix 服务器。

- 启动时凭同域 Access cookie 读取 `GET /_mau/v1/account`，由 Cloudflare 附加 JWT。
- 未开通的账号显示整页“此账号未开通 Mau（邮箱）”和“切换账号”（Access 退出）。
- Access 会话过期（接口被重定向、`401` 或套接字重新取票失败）时显示“登录已过期”横幅；“重新登录”把未发送的输入按对话存入 `sessionStorage` 后刷新页面。
- “退出登录”跳转 Access 退出。
- 命令行和自动化的 bearer 调用继续可用，除非 Router 设置 `bearer: "deny"`。
- Cloudflare 对跨站请求同样附加 JWT，因此边缘身份的非 GET 请求必须带控制台的 `Origin`（`edgeIdentity.origins`，默认取公开地址的源，或与请求自身 Host 相同），且请求体类型不能是表单可发送的类型。Access 之后的非浏览器调用方需带 bearer 令牌或显式 `Origin`。

## 对话

对话来自 Router 的所有者账本（`/_agent-router/v1/web`），控制台按 `GET /web/me` 公布的功能开关工作：没有 `history` 时提示聊天记录不可用，没有 `send` 时对话只读。

- 每个自有员工有一个单聊。顶部一行保留少数几个对话；人员面板列出全部对话，并可打开员工资料：环境状态与自检、渠道、连接器、文档，以及配置（内核、环境方案、销毁环境、删除员工）。
- “新建群聊”创建 Router 群聊房间，填写标题并选择最多 20 个自有员工。群里只有被所有者 @ 的员工（或 `@所有人`/`@all`）开始处理；没有 @ 的消息只记录。成员面板可改名、添加和移除员工。
- 消息包含文字和附件（Router 公布该功能时）：图片内嵌显示，其他文件显示为下载卡片。来自其他渠道的消息带渠道标记。
- 发送失败保留草稿，重试复用同一个幂等键。
- Router 提供 `reset` 时，可以“新对话”开始新会话，也可以在设置中清空某个对话的聊天记录。
- 员工的指令（`AGENTS.md`，只读）和两个记忆文件（`MEMORY.md`、`USER.md`，逐条编辑）在对话旁打开。

Host 健康检查不代表消息链路已通过；线上验收必须从控制台发送消息并确认收到员工回复。

## 执行过程与交互

控制台通过 Router 的公开运行、事件和调用结果接口读取执行过程，在触发它的消息下方显示增量正文、推理、工具参数与结果、运行状态以及待处理的审批和提问。所有者可以回答审批和提问、停止正在进行的回复，或向它追加文字，全部经过 Router。原生选项和回答格式由 Host 的公开交互转换器决定，Mau 不自定义审批选项。

断线后按事件游标续读。刷新后从保留的历史重建，事件丢失时明确提示；已结束的运行从 Router 归档读取一次。已处理或过期的交互不可再次提交。员工把浏览器交给所有者时，实时画面在对话旁打开。

构建版本检查只在页面闲置时刷新旧页面：有待完成的修改、打开的弹窗或表单、输入框聚焦时不刷新。

## 设置

主导航只有一个「设置」入口，打开覆盖在应用上的弹窗，左侧导航：通用（语言、外观、头像）、连接器、消息渠道、身份与配对、扩展、
数据控制（通过 Router 账本清空某个对话的聊天记录）、帮助与法律、退出（边缘登录的登出）。员工自己的状态和配置在人员面板的员工资料里。
扩展页列出 Skills、MCP、内核插件、Hooks、Tools 和 CLI，均显示尚未接入：员工可以在自己的环境里安装和使用。

页面可直接链接：`#/settings/<分区>[/<项目>]`，例如 `#/settings/connectors/gmail`。跳转 OAuth 授权前控制台记住当前页面，
回调的 `/?view=connectors&oauth=…` 会重新打开它。宽度小于 640 px 时弹窗全屏，导航是第一页，各页面带返回按钮。

界面、字号、间距和组件来自 `@olorinm/agent-ui/app`（设置页用标准密度，执行过程和审批卡片用紧凑密度）。

## 渠道

渠道在「设置 → 消息渠道」中按员工连接，流程在弹窗内完成。每两秒查询一次 Router 的连接任务，遇到临时网络错误、服务端错误或限流后继续轮询，并提供重试按钮；任务不存在或已过期时停止轮询。Router 返回的 `qr` 是终端字符画，控制台根据任务里的 `https` 链接自己生成二维码，同时提供打开链接。任务在 Router 内存中保留十分钟，过期或找不到时提示重新开始。飞书个人权限（以主人身份）在「设置 → 连接器 → 飞书」通过 Agent Connectors 授权，见 [connector-accounts.md](connector-accounts.md)。

### 恢复已有飞书应用

飞书连接失败后，点击「恢复连接」，填写开发者后台的原 App ID。控制台会保留已知的
App ID 和区域，通过飞书官方页面重新授权；无需复制 App Secret。
如果凭据已经保存，仅绑定失败，则直接复用凭据。失败任务在 Router 重启后仍可查看。

## 验证

```sh
npm run test:web
```

会构建控制台、运行连接层测试，并用 Chromium 操作测试用 Mau：从 Access 会话打开、新建员工、暂停与恢复、连接渠道、自检、销毁、设置与连接器、对话、群聊、附件、执行过程与审批、切换语言、退出和登录失效。CI 设置 `MAU_WEB_E2E=1`，没有构建产物时直接失败而不是跳过。云端生命周期、Host、Access 和渠道都是测试替身；扫码、真实 Access 登录、渠道授权和模型回复需要在实际部署上验收。
