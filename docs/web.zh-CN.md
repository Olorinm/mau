# Web 控制台

[English](web.md)

Mau Web 控制台提供登录、新建员工、查看与控制运行环境、连接渠道和自检。它只调用现有的 Mau（`/_mau/v1`）与 Router（`/_agent-router/v1`）接口，密码登录和退出时直接访问公开的 Matrix 服务器。本版本不含聊天、模型配置、凭证和文件。

界面组件来自 `@olorinm/agent-ui/app`（[Agent UI](https://github.com/Olorinm/agent-ui)，从 OpenGrove 抽出）。连接层（`web/src/api`）、文案和布局属于 Mau。`components.json` 固定 Agent UI 的发布版本，bootstrap 下载后按 `web/package-lock.json` 校验字节。

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

设置 `MAU_WEB_ROOT` 后，`mau-server` 以和接口相同的域名提供控制台，不需要配置跨域。以 `/_` 开头的路径不会返回页面。[Dockerfile](../Dockerfile) 会构建控制台并设置 `MAU_WEB_ROOT=/app/web`。

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
