# Web 控制台

[English](web.md)

Mau 复用从 OpenGrove 原源码提取的页面结构、样式和交互，提供账号登录、员工管理、环境生命周期、渠道连接、账号消息及共享工作区文件列表和下载。
账号消息经过 Matrix 与 Router；不包含直接内核聊天、钱包和提现。

公共组件来自 `@olorinm/agent-frontend` 与 `@olorinm/agent-ui`，仅接收数据和回调。
认证、接口请求、导航和业务流程由 Mau 的 `web/src` 负责；公共包不依赖这些服务。
`components.json` 固定两个 UI 发布包，bootstrap 下载后按锁文件校验字节。
应用创建、商店、扩展和设置入口保留；Mau 没有接入的服务明确显示“尚未接入”，操作不可提交。
外观设置、消息输入与搜索、资料页、移动端导航使用提取包中的原组件。
图形化扩展保留 Skills、MCP、内核插件、Hooks、Tools 和 CLI 六类入口。

## 开发

```sh
node scripts/bootstrap.mjs            # 同时安装 web/ 依赖
MAU_CONFIG_FILE=/private/mau.json npm start
npm run dev:web                        # Vite 运行在 5173，/_mau 和 /_agent-router 代理到 8790
```

用 `MAU_DEV_BACKEND_URL` 代理到其他服务。

## 部署

```sh
npm run build:web
MAU_WEB_ROOT=web/dist MAU_CONFIG_FILE=/private/mau.json npm start
```

设置 `MAU_WEB_ROOT` 后，`mau-server` 以和接口相同的域名提供控制台，不需要配置跨域。以 `/_` 开头的路径和 `/health` 路由不会返回页面。[Dockerfile](../Dockerfile) 会构建控制台并设置 `MAU_WEB_ROOT=/app/web`。

服务端发布包包含 `web/dist`；安装发布包后，将 `MAU_WEB_ROOT` 指向已安装 Mau 包中的该目录。`npm pack` 会先构建服务端和控制台。渠道任务遇到临时网络错误、服务端错误或限流后会继续轮询，并提供重试按钮；任务不存在或已过期时停止轮询。

页面的内容安全策略只允许连接同域和公开 Matrix 服务器（`mau.json` 中的 `publicHomeserver`）。该服务器需要允许浏览器跨域访问客户端接口，Synapse 默认允许。

## 登录状态

- 密码登录与 `mau login` 相同：`GET /_mau/v1/info`、Matrix `m.login.password`、`GET /_mau/v1/account`。退出时吊销该设备。
- 令牌登录只校验已有访问令牌。退出时只在浏览器里忘记它，不吊销。
- 令牌保存在浏览器 `localStorage`（`mau.session`）。任何 `401` 都会回到登录页。

## 渠道

每两秒查询一次 Router 的连接任务。Router 返回的 `qr` 是终端字符画，控制台根据任务里的 `https` 链接自己生成二维码，同时提供打开链接。任务在 Router 内存中保留十分钟，过期或找不到时提示重新开始。飞书个人工具授权使用 Router 的状态、开始和完成接口。

## 验证

```sh
npm run test:web
```

会构建控制台、运行连接层测试，并用 Chromium 操作测试用 Mau：密码登录（含密码错误）、新建员工、暂停与恢复、连接 Matrix、自检、销毁、切换语言、退出和登录失效。CI 设置 `MAU_WEB_E2E=1`，没有构建产物时直接失败而不是跳过。云端生命周期、Matrix 和渠道都是测试替身；扫码、真实 Matrix 登录和渠道授权需要在实际部署上验收。

## 恢复已有飞书应用

飞书连接失败后，点击「恢复连接」，填写开发者后台的原 App ID。控制台会保留已知的
App ID、区域和个人工具选项，通过飞书官方页面重新授权；无需复制 App Secret。
如果凭据已经保存，仅绑定失败，则直接复用凭据。失败任务在 Router 重启后仍可查看。
自检分别显示机器人消息通道与个人工具授权状态。


## 公共前端与产品边界

Mau 使用 `@olorinm/agent-frontend` 的布局、列表详情、登录表单外观和聊天组件。
公共包只接收数据与回调，不依赖 Mau、Router、Host、Environment、Matrix 或 OpenGrove 接口。
账号认证、导航、消息请求和环境/渠道流程都在 Mau 的 `web/src` 中组装。

本轮不包含直接内核聊天、钱包和提现。应用、扩展及设置入口由 Mau 提供，缺少服务的入口明确显示“尚未接入”。
账号消息通过 Matrix 与 Router 现有链路通信；发送失败保留草稿，重试复用事务 ID，避免重复投递。
只展示含当前账号自有 Agent 的已加入房间，不把含其他参与者的群组自动当作私聊。
当前支持最近的文字/通知消息，历史分页和其他消息类型尚未接入。
共享工作区支持实际文件列表与短时下载链接，尚未接入在线文件编辑。
浏览器验收使用明确的 Matrix 和云环境测试替身，不代表真实内核或线上服务验收。
