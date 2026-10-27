# environ-mcp

环境监测数据 **MCP Server** —— 让 AI 助手在对话里直接回答「XX 站点现在数据多少」这类问题。

[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-online.environ%2Fenviron--mcp-185fa5)](https://registry.modelcontextprotocol.io/v0.1/servers?search=online.environ%2Fenviron-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

服务入口：`https://app.environ.online/mcp`（Streamable HTTP + OAuth 2.1 / PKCE）
服务介绍页：`https://app.environ.online/mcp/about`

> **每位使用者需要自己的账号**：在浏览器打开绑定页完成绑定后，只能看到自己权限范围内的站点，
> 多人之间互不影响。

## 两种运行模式

| 模式 | 入口 | 用途 |
|------|------|------|
| **stdio**（本地） | `src/server.js` | WorkBuddy 本机拉起，零配置即用 |
| **HTTP**（容器/公网） | `src/http-server.js` | 标准 MCP Streamable HTTP，容器化部署，任何 MCP 客户端都能连 |

两个入口共用 `src/core.js` + `src/tools.js`，工具定义完全一致。

## 多用户身份（v1.1 起）

HTTP 模式按 **客户端标识** 区分用户：每个同事在自己的 `mcp.json` 里放一个随机串
（请求头 `X-Environ-Client`），服务器记住这个串对应的是哪个 environ 账号。
于是 A 的小布查 A 的站点，B 的小布查 B 的站点，互不串号。

身份解析优先级：

| 顺序 | 来源 | 用途 |
|------|------|------|
| 1 | **OAuth access_token** | 标准授权流程，access_token 直接携带用户身份 |
| 2 | 请求头 `X-Environ-Token` | 直传业务 token，临时排查用 |
| 3 | 请求头 `X-Environ-Client` 对应的**客户端绑定** | 多用户主路径 |
| 4 | 共享默认绑定 | 仅当 `ALLOW_DEFAULT_BINDING=1`，多人共用时**应保持关闭** |
| 5 | 本地 token 文件 | stdio 模式 |

绑定表落在 `ENVIRON_BINDINGS_FILE`（容器内 `/data/bindings.json`），容器重启不丢绑定。

三种绑定方式：

| 方式 | 入口 | 适用 |
|------|------|------|
| 浏览器绑定页 | `https://app.environ.online/mcp/bind` | 密码只在浏览器输入，不进聊天窗口 |
| 命令行脚本 | `node scripts/bind.js --url ... --key ... --user ...` | 脚本化 / 批量开通 |
| 对话内绑定 | 让小布调 `bind_user` | 应急，密码会留在对话记录里 |

详见 **[docs/多用户接入指南.md](docs/多用户接入指南.md)**。

## OAuth 2.1 + PKCE（v1.2 起）

服务端实现了 MCP 规范要求的授权面，标准客户端可以直接走「点一下授权」：

| 端点 | 地址 |
|------|------|
| 受保护资源元数据 | `/mcp/.well-known/oauth-protected-resource` |
| 授权服务器元数据 | `/mcp/.well-known/oauth-authorization-server` |
| 动态客户端注册 (RFC 7591) | `POST /mcp/oauth/register` |
| 授权端点 | `GET /mcp/oauth/authorize`（PKCE 强制 S256） |
| 令牌端点 | `POST /mcp/oauth/token`（授权码 / 刷新 / 设备码） |
| 设备授权 (RFC 8628) | `POST /mcp/oauth/device_authorization` |
| 令牌撤销 (RFC 7009) | `POST /mcp/oauth/revoke` |

未授权访问返回 `401` + `WWW-Authenticate: Bearer resource_metadata="..."`，
客户端据此自动发现授权端点。**access_token 就是用户身份**——服务端把该用户的
environ token 装在令牌里，工具调用按本人权限查数据。

## 平台接入（豆包 / 扣子 / 火山引擎 / n8n / Dify）

对外同时提供三套入口：

| 入口 | 地址 |
|------|------|
| Streamable HTTP（标准） | `https://app.environ.online/mcp` |
| SSE（老协议，兼容 n8n 等） | `https://app.environ.online/mcp/sse` |
| OAuth 2.1 | `https://app.environ.online/mcp/oauth/authorize` |

令牌可来自 `Authorization` 头，也可来自 `?token=` / `?key=` / `?access_token=`
（火山引擎的 `injection_type=query` 注入方式）；客户端标识同样支持
`?client=` 查询参数。

平台没有「个人身份」维度，需要先建一个 environ 服务账号并绑定到平台专属
clientKey。逐平台配置见 **[docs/平台接入指南.md](docs/平台接入指南.md)**。

## 容器化

```bash
# 构建（Docker Hub 不通时走国内源）
docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine \
             --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
             -t environ-mcp:1.1.0 .

# 启动
docker run -d --name environ-mcp --restart unless-stopped -p 3000:3000 \
  -v $(pwd)/data:/data \
  -e MCP_AUTH_TOKEN=<访问令牌> \
  -e ENVIRON_API_BASE=http://localhost:8081 \
  -e ENVIRON_BINDINGS_FILE=/data/bindings.json \
  -e ALLOW_DEFAULT_BINDING=false \
  environ-mcp:1.1.0
```

或用 compose：

```bash
cp .env.example .env   # 填入 MCP_AUTH_TOKEN
docker compose up -d
```

镜像特性：多阶段构建、alpine 基础、`tini` 转发信号、**非 root 运行**（node 用户）、
`HEALTHCHECK` 探活、SIGTERM 优雅退出。

完整部署指南见 **[deploy/DEPLOY.md](deploy/DEPLOY.md)**。

## 架构

```
WorkBuddy (MCP Client)
   │  stdio (JSON-RPC)  或  Streamable HTTP → https://app.environ.online/mcp
   │  headers: Authorization + X-Environ-Client
   ▼
environ-mcp  (Node ESM, 本项目)             ← 暴露 8 个 tool
   │  HTTP + Bearer token（X-Environ-Token）
   ▼
environ-svr-v2  /openapi/**                 ← 开放接口
   │
   ▼
InfluxDB (实时/小时时序) + MySQL + Redis
```

绑定关系存在后端 Redis（`wb:bind:{token}`，30 天），MCP 侧把 token 缓存在绑定表里，
所以**一次绑定，长期可用**，不用每次对话都登录。

## 工具一览

| tool | 作用 | 关键参数 |
|------|------|----------|
| `bind_user` | 用户名密码绑定，签发 token | `username`, `password` |
| `list_stations` | 列出可查看的站点 | `search?`, `limit?` |
| `get_realtime` | 站点当前实时数据 | `station`（ID 或名称） |
| `get_hour_data` | 站点小时数据序列 | `station`, `beginTime?`, `endTime?` |
| `get_overview` | 站点信息 + 实时 + 当日小时，一次返回 | `station` |
| `check_bind` | 查看当前身份来源、绑定用户、可见站点数 | — |
| `unbind_user` | 解绑当前客户端 | `confirm`（boolean，缺省只查状态不执行） |
| `get_client_config` | 生成可直接粘贴的 mcp.json 接入片段 | — |

**站点参数同时接受 ID 和名称**：`station` 传 `"814"` 按 ID 查；传 `"南明区监测站"`
则先调 `/openapi/stations?search=...` 模糊匹配（完全相等优先，其次包含）。这是让
「查 XX 站点」这种自然语言能跑通的关键。

## 启用步骤（管理员）

1. MCP 配置已写入 `C:\Users\Hailin\.workbuddy\mcp.json`（**无点前缀**的那个文件）
2. 打开 WorkBuddy → 左侧「专家·技能·连接器」→ 右上角「自定义连接器」
3. 找到 `environ-mcp` → 点**信任**
4. **重启会话**（或开新会话），工具才会注入到对话里

## 首次使用

打开 `https://app.environ.online/mcp/bind`，填自己的客户端标识和 environ 账号密码完成绑定；
之后直接问：

- 「XX 站点现在数据多少」
- 「南明区监测站昨天各小时的数据」
- 「给我看下 814 站点的完整情况」

## 配置项

服务端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_AUTH_TOKEN` | 空 | MCP 接入令牌（客户端 `Authorization` 头）。为空则不校验 |
| `MCP_PUBLIC_URL` | `https://app.environ.online/mcp` | 对外地址，生成接入片段用 |
| `MCP_CLIENT_HEADER` | `X-Environ-Client` | 客户端标识请求头名 |
| `ENVIRON_API_BASE` | `http://localhost:8080` | environ 后端地址 |
| `ENVIRON_BINDINGS_FILE` | `~/.workbuddy/environ-mcp/bindings.json` | 绑定表落盘位置 |
| `ENVIRON_OAUTH_FILE` | `~/.workbuddy/environ-mcp/oauth.json` | OAuth 客户端/令牌落盘位置 |
| `OAUTH_ACCESS_TTL` | `86400` | OAuth access_token 有效期（秒） |
| `OAUTH_REFRESH_TTL` | `2592000` | OAuth 刷新令牌有效期（秒） |
| `ALLOW_DEFAULT_BINDING` | `false` | 是否允许共享默认绑定。多人共用时保持 false |
| `ENVIRON_TOKEN` | 空 | 直接指定 token（不设则读写绑定表 / token 文件） |
| `ENVIRON_TIMEOUT_MS` | `20000` | 后端请求超时 |

## 开发

```bash
npm install
npm test                    # 冒烟测试：MCP 握手 + tools/list + check_bind
node test/multi-user.js     # 多用户隔离测试：两个 clientKey 互不串号
node test/oauth-e2e.js      # OAuth 端到端：注册/授权码+PKCE/设备码/刷新/401 头
npm start                   # 手动启动（stdio 模式，需由 MCP Client 拉起）
```

改完 `src/server.js` 后，**重启 WorkBuddy 会话**即可生效（MCP 子进程是常驻的，
不重启拿到的是旧代码）。

## 注意

- **stdout 属于 MCP 协议**，所有日志必须走 stderr（代码里用 `console.error`）
- 后端 `/openapi/**` 在 `WebSecurityConfig` 里是用 `web.ignoring()` 放行的，
  不能改成 `permitAll()` —— 否则 `JwtAuthenticationFilter` 会把 UUID token
  当无效 JWT 拦截返回 401
- 密码校验走后端 `up_user_login` 存储过程（**MD5**，不是 BCrypt）
- nginx 只反代了 `/mcp` 前缀，所以绑定端点挂在 `/mcp/bind`（而不是 `/bind`），
  OAuth 端点与 `.well-known` 元数据同理都挂在 `/mcp` 之下
- 公网根路径 `/.well-known/*` 被 SPA 的 nginx 占着（返回 index.html），
  所以 OAuth 元数据必须从 `/mcp/.well-known/...` 取

## 已上架

| 渠道 | 名称 | 状态 |
|---|---|---|
| 官方 MCP Registry | `online.environ/environ-mcp` | ✅ active（v1.3.2） |
| Glama / PulseMCP / VS Code | — | 自动摄取官方 Registry，无需单独提交 |

发布方式与踩坑记录见 [`docs/上架指南.md`](docs/上架指南.md)。

## License

MIT —— 见 [LICENSE](LICENSE)。

数据来自企业内部环境监测业务系统，不随本仓库授权分发。
