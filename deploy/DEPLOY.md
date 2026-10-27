# environ-mcp 部署指南（自助版）

面向：把 environ-mcp 部署到 app.environ.online 对应的服务器，通过 nginx 暴露成
`https://app.environ.online/mcp`，供 WorkBuddy 以 HTTP 模式连接。

---

## 0. 前置条件

| 项 | 要求 | 检查命令 |
|----|------|----------|
| Node.js | 18+（推荐 22） | `node -v` |
| npm | 随 Node 附带 | `npm -v` |
| 端口 | 3000 空闲 | `ss -lntp \| grep 3000` |
| nginx | 已有 app.environ.online 的 server 块 | `nginx -t` |
| 后端 | environ-svr-v2 已在跑，`/openapi/**` 可访问 | `curl -i https://app.environ.online/api/openapi/stations` |

> `/openapi/stations` 无 token 会返回业务错误 JSON，**只要不是 404/502 就说明路由通了**。
> 如果 404，说明 nginx 的 `/api` 规则没覆盖到，或后端没部署新版本。

---

## 1. 上传并解压

在本机打包好的 `environ-mcp-deploy.tar.gz` 上传到服务器，例如：

```bash
scp environ-mcp-deploy.tar.gz user@SERVER_IP:/tmp/
ssh user@SERVER_IP
cd /tmp && tar -xzf environ-mcp-deploy.tar.gz && cd environ-mcp
```

解压后目录结构：

```
environ-mcp/
├── src/                  # 服务代码
├── deploy/
│   ├── deploy.sh         # 一键部署脚本
│   ├── environ-mcp.service   # systemd 单元
│   └── nginx.conf.snippet     # nginx 反代片段
├── test/                 # 自测脚本
├── package.json
└── package-lock.json
```

---

## 2. 一键部署

```bash
sudo bash deploy/deploy.sh
```

脚本会做这些事（幂等，可重复执行）：

1. 检查 node 环境
2. 同步代码到 `/opt/environ-mcp`
3. `npm ci --omit=dev` 装依赖
4. 生成 `/opt/environ-mcp/.env`（**含随机 `MCP_AUTH_TOKEN`**，已存在则保留）
5. 安装并启动 systemd 服务 `environ-mcp`
6. 打印健康检查结果 + 访问令牌

**记下打印出来的 `MCP_AUTH_TOKEN`**，第 4 步要用。

不想用 `/opt` 就改路径：

```bash
sudo APP_DIR=/data/apps/environ-mcp bash deploy/deploy.sh
```

---

## 3. nginx 反代

先找到 app.environ.online 的配置文件：

```bash
sudo grep -rl "app.environ.online" /etc/nginx/ 2>/dev/null
```

把 `deploy/nginx.conf.snippet` 的内容并入那个 server 块：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3000/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # MCP Streamable HTTP 走 SSE 长连接，这三项必须开
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> `proxy_buffering off` 和长超时是**必须的**。少了缓冲，SSE 流会被 nginx 攒着不发，
> MCP 客户端表现为握手超时。

### 用子路径而不是子域名？

如果 `https://app.environ.online/` 已经是 SPA 的 nginx 规则，加 `/mcp` location 不冲突
（location 前缀匹配优先于 `location /`）。若前端用的是 history 路由 fallback，
**务必确认 `location /mcp` 写在 `location /` 之前或与之同级**，否则 `/mcp` 会被
SPA 的 `try_files $uri /index.html` 吃掉，返回 HTML 而不是 MCP 协议。

---

## 4. 验证

服务器上：

```bash
curl -s http://127.0.0.1:3000/health
# {"ok":true,"name":"environ-mcp",...,"authRequired":true,...}

curl -s -o /dev/null -w "%{http_code}\n" https://app.environ.online/mcp-health
# 200
```

公网走一遍完整协议（需要带令牌）：

```bash
cd /tmp/environ-mcp
MCP_AUTH_TOKEN=<你的令牌> node test/http-smoke.js https://app.environ.online/mcp
```

预期输出：

```
✅ HTTP 传输握手成功
✅ 工具列表（6 个）：bind_user, list_stations, get_realtime, get_hour_data, get_overview, check_bind
✅ check_bind 调用结果：...
```

---

## 5. 切换 WorkBuddy 客户端

编辑 `C:\Users\Hailin\.workbuddy\mcp.json`（**无点前缀**），把 `environ-mcp` 改成 HTTP 模式：

```json
{
  "mcpServers": {
    "environ-mcp": {
      "type": "http",
      "url": "https://app.environ.online/mcp",
      "headers": {
        "Authorization": "Bearer <你的 MCP_AUTH_TOKEN>"
      },
      "description": "environ 环境监测数据查询：站点列表 / 实时数据 / 小时数据 / 总览"
    }
  }
}
```

然后在 WorkBuddy 里：**连接器管理 → 自定义连接器 → 找到 environ-mcp → 点信任**，
再**重启会话**。

> 想保留本地 stdio 版本对照测试，就把两个条目都写上，用不同名字区分
> （如 `environ-mcp` 公网版 + `environ-mcp-local` 本地版）。

---

## 常见问题

**握手超时 / 一直 pending**
nginx 缓冲没关。加 `proxy_buffering off;` 并 `nginx -t && systemctl reload nginx`。

**401 unauthorized**
请求头令牌不对。检查 `systemctl cat environ-mcp` 里的 `EnvironmentFile` 路径，
以及 `/opt/environ-mcp/.env` 里的 `MCP_AUTH_TOKEN` 是否与客户端一致。

**404 not found**
请求没打到 Node 服务。确认 `proxy_pass` 路径、端口、以及 systemd 服务是否 active
（`systemctl status environ-mcp`）。

**工具调用报「无法连接 environ 后端」**
MCP Server 连不上 Spring Boot。检查 `.env` 里的 `ENVIRON_API_BASE`：
本机直连后端用 `http://127.0.0.1:8080`；走 nginx 用 `https://app.environ.online/api`。
在服务器上 `curl $ENVIRON_API_BASE/openapi/stations` 验证。

**服务起不来**
```bash
journalctl -u environ-mcp -n 50 --no-pager
```

**没有 systemd（用 PM2）**

```bash
cd /opt/environ-mcp
pm2 start src/http-server.js --name environ-mcp --env production
pm2 save && pm2 startup
```

`.env` 里的环境变量 pm2 不会自动读，需要用 `--env` 传或在 `ecosystem.config.js` 里配。

---

## 运维

```bash
systemctl status environ-mcp        # 状态
systemctl restart environ-mcp       # 重启（改代码后）
journalctl -u environ-mcp -f        # 实时日志
curl -s localhost:3000/health       # 健康检查（含会话数、是否已绑定）
```
