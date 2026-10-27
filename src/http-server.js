#!/usr/bin/env node
/**
 * environ 环境监测数据 MCP Server —— HTTP 入口（公网模式）
 *
 * 标准 MCP Streamable HTTP 传输，挂在 /mcp。
 * 由 nginx 反代到本服务，例如 https://app.environ.online/mcp -> 127.0.0.1:3000/mcp
 *
 * 三种传输/接入方式并存：
 *   1) Streamable HTTP  /mcp            —— 标准（WorkBuddy、Coze 扣子、火山引擎、豆包）
 *   2) SSE（老协议）     /mcp/sse        —— 兼容 n8n 等只支持 SSE 的平台
 *   3) OAuth 2.1 + PKCE                 —— 标准授权，access_token 即用户身份
 *
 * 身份来源（优先级从高到低）：
 *   1) OAuth access_token（Authorization 头）
 *   2) 请求头 X-Environ-Token（直传业务 token）
 *   3) 请求头/查询参数 X-Environ-Client 对应的客户端绑定
 *   4) 共享默认绑定（ALLOW_DEFAULT_BINDING=1 才允许，默认关）
 *
 * 令牌可来自：Authorization 头 / ?token= / ?key= / ?access_token=
 * （火山引擎的 injection_type=query 注入方式就是这样）
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerTools, extractToken } from "./tools.js";
import { bindPageHtml } from "./bind-page.js";
import { buildServerCard } from "./server-card.js";
import { aboutPageHtml } from "./about-page.js";
import { loadOAuthStore, registerOAuthRoutes, resolveAccessToken } from "./oauth.js";
import {
  apiGet,
  apiPost,
  bindToClient,
  bindings,
  config,
  VERSION,
  loadBindings,
  log,
  requestContext,
  resolveBindToken,
  unbindClient,
} from "./core.js";

const app = express();
app.use(express.json({ limit: "4mb" }));
// OAuth 规范要求令牌端点用表单编码提交
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ---------------- 令牌与标识提取 ----------------

/**
 * SSE / Streamable HTTP 的会话表。
 * sessionId 由服务端生成，只在已鉴权的请求里发放，等价于一次会话的凭据。
 */
const transports = new Map();
/** sessionId -> { transport, server, identity }（SSE 老协议用） */
const sseSessions = new Map();

/** 从 Authorization 头或查询参数里取 MCP 访问令牌 */
function bearerOf(req) {
  const auth = req.headers.authorization || "";
  if (auth) {
    const t = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth.trim();
    if (t) return t;
  }
  // 火山引擎 injection_type=query：令牌放在 URL 查询参数里
  const q = req.query || {};
  for (const k of ["token", "key", "access_token", "mcp_token"]) {
    if (q[k]) return String(q[k]).trim();
  }
  return null;
}

/** 客户端标识：请求头优先，其次查询参数（平台接入只能给 URL 时用） */
function clientKeyOf(req) {
  const raw = req.headers[config.clientHeader];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key && String(key).trim()) return String(key).trim();
  const q = req.query || {};
  for (const k of ["client", "client_key", "clientKey"]) {
    if (q[k]) return String(q[k]).trim();
  }
  return null;
}

// ---------------- 鉴权 ----------------

/** 无需鉴权的路径：健康检查、绑定页、OAuth 端点、元数据 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/mcp/health",
  "/bind",
  "/mcp/bind",
  "/oauth/register",
  "/mcp/oauth/register",
  "/oauth/authorize",
  "/mcp/oauth/authorize",
  "/oauth/token",
  "/mcp/oauth/token",
  "/oauth/device",
  "/mcp/oauth/device",
  "/oauth/device_authorization",
  "/mcp/oauth/device_authorization",
  "/oauth/revoke",
  "/mcp/oauth/revoke",
  "/.well-known/oauth-authorization-server",
  "/mcp/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/mcp/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-protected-resource",
  "/mcp/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/mcp/.well-known/oauth-protected-resource/mcp",
  "/.well-known/mcp/server-card.json",
  "/mcp/.well-known/mcp/server-card.json",
  "/mcp/about",
  "/about",
  "/.well-known/mcp-registry-auth",
  "/mcp/.well-known/mcp-registry-auth",
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();

  // SSE 消息端点：客户端拿到 endpoint 事件后会 POST 过来，那个地址不带令牌
  // （令牌在 SSE 建连的 URL 上）。这里以 sessionId 作为会话凭据 ——
  // 该会话在 GET /mcp/sse 时已经校验过令牌。
  if (req.method === "POST" && (req.path === "/mcp/message" || req.path === "/message")) {
    const sid = String((req.query || {}).sessionId || "");
    if (sid && sseSessions.has(sid)) return next();
  }

  const token = bearerOf(req);

  // OAuth access_token：直接携带用户身份
  const oauthRec = resolveAccessToken(token);
  if (oauthRec) {
    req.oauthIdentity = {
      userId: oauthRec.userId,
      userName: oauthRec.userName,
      environToken: oauthRec.environToken,
      scope: oauthRec.scope,
      expiresAt: oauthRec.expiresAt,
    };
    return next();
  }

  // 静态接入令牌：管理 / 平台接入用，身份靠 X-Environ-Client 绑定
  if (!config.authToken) return next();
  if (token && token === config.authToken) return next();

  // 未授权：按 MCP 规范给出 Protected Resource Metadata 地址
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="environ:read"`
  );
  res.status(401).json({
    error: "unauthorized",
    hint: "需要 OAuth 访问令牌或静态接入令牌；OAuth 元数据见 /.well-known/oauth-protected-resource",
  });
});

// ---------------- 请求上下文（身份注入） ----------------

app.use((req, res, next) => {
  requestContext.run(
    {
      environToken: extractToken(req.headers),
      clientKey: clientKeyOf(req),
      oauth: req.oauthIdentity || null,
    },
    next
  );
});

// ---------------- OAuth 端点 ----------------

registerOAuthRoutes(app);

// ---------------- 绑定 / 解绑（密码不经过聊天窗口） ----------------

/**
 * 绑定端点同时挂在 /mcp/bind 与 /bind 上：
 *   - /mcp/bind 走公网 nginx（app.environ.online 只反代了 /mcp 前缀）
 *   - /bind     供直连容器的场景使用
 *
 * 支持三种入参：
 *   1) { username, password }  —— 用户凭据（浏览器绑定页 / 命令行脚本）
 *   2) { token }                —— 已有的 environ 业务 token（复用现有登录态）
 *   3) { username, password } + 管理令牌 —— 运维强制改绑
 */
async function bindHandler(req, res) {
  const clientKey = clientKeyOf(req);
  if (!clientKey) {
    res.status(400).json({
      error: "缺少客户端标识",
      hint: `需要在 ${config.clientHeader} 头带上你自己的客户端标识`,
    });
    return;
  }
  if (rateLimited(req.ip || "unknown")) {
    res.status(429).json({ error: "尝试过于频繁，请 5 分钟后再试" });
    return;
  }

  const body = req.body || {};
  const admin = isAdmin(req);

  let payload = null;
  try {
    if (body.token) {
      // 复用现有登录态：拿业务 token 去后端验一下有效性
      const token = String(body.token).trim();

      // 反查用户信息（/openapi/me）。老后端若没有该端点则降级，不影响绑定。
      let info = null;
      try {
        info = await apiGet("/openapi/me", {}, token);
      } catch (ex) {
        log(`反查用户信息失败（降级继续）：${ex.message}`);
      }

      const probe = await apiGet("/openapi/stations", { limit: 1, offset: 0 }, token);
      payload = {
        token,
        userId: info && info.userId != null ? info.userId : null,
        userName: body.userName || (info && info.userName) || null,
        apiBase: config.apiBase,
        expireDays: info && info.expireDays ? info.expireDays : 30,
      };
      log(
        `用业务 token 绑定 client=${clientKey.slice(0, 8)}… user=${payload.userName || "?"}` +
          `(${payload.userId ?? "?"}) 可见站点 ${probe.total}`
      );
    } else if (body.username && (body.passwordMd5 || body.password)) {
      // 统一走凭据解析器：按 environ 的两套密码契约依次尝试
      //   ① /user/login(MD5) → JWT → /openapi/session
      //   ② /openapi/bind(passwordMd5)
      //   ③ /openapi/bind(明文)
      const { data, via } = await resolveBindToken({
        username: String(body.username).trim(),
        password: body.password,
        passwordMd5: body.passwordMd5,
      });
      payload = {
        token: data.token,
        userId: data.userId,
        userName: data.userName,
        apiBase: config.apiBase,
        expireDays: data.expireDays || 30,
      };
      log(`凭据绑定 client=${clientKey.slice(0, 8)}… user=${data.userName}(${data.userId}) via=${via}`);
    } else {
      res.status(400).json({ error: "需要 username + (passwordMd5 或 password)，或 token" });
      return;
    }
  } catch (ex) {
    res.status(400).json({ error: ex.message });
    return;
  }

  // 换绑保护：同一客户端标识已绑到别人时，只有管理令牌能改
  const existing = bindings.clients.get(clientKey);
  if (existing && !admin && existing.userId && payload.userId && existing.userId !== payload.userId) {
    res.status(403).json({
      error: "该客户端标识已绑定其他账号，如需换绑请联系管理员",
      boundUser: existing.userName,
    });
    return;
  }

  bindToClient(clientKey, payload);
  log(`绑定成功 user=${payload.userName || "?"} id=${payload.userId || "?"} client=${clientKey.slice(0, 8)}…`);
  res.json({
    ok: true,
    userId: payload.userId,
    userName: payload.userName,
    expireDays: payload.expireDays,
  });
}

function unbindHandler(req, res) {
  const clientKey = clientKeyOf(req);
  if (!clientKey) {
    res.status(400).json({ error: "缺少客户端标识" });
    return;
  }
  if (!isAdmin(req) && !existingOwnerMatches(req, clientKey)) {
    res.status(403).json({ error: "解绑需要提供该客户端对应的业务 token 或管理令牌" });
    return;
  }
  const ok = unbindClient(clientKey);
  res.json({ ok, clientKey: clientKey.slice(0, 8) + "…" });
}

/** 解绑时校验：请求带的是不是该客户端当前绑定的那个业务 token */
function existingOwnerMatches(req, clientKey) {
  const token = extractToken(req.headers);
  if (!token) return false;
  const bound = bindings.clients.get(clientKey);
  return !!(bound && bound.token === token);
}

/** 绑定尝试限流：同一 IP 5 分钟内最多 10 次，防止被当口令爆破入口 */
const bindAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 5 * 60 * 1000;
  const max = 10;
  const list = (bindAttempts.get(ip) || []).filter((t) => now - t < win);
  if (list.length >= max) {
    bindAttempts.set(ip, list);
    return true;
  }
  list.push(now);
  bindAttempts.set(ip, list);
  return false;
}

function isAdmin(req) {
  if (!config.authToken) return true;
  const t = bearerOf(req);
  return !!t && t === config.authToken;
}

// 绑定页：GET /mcp/bind -> 浏览器页面
app.get("/mcp/bind", (req, res) => {
  res.type("html").send(bindPageHtml);
});
app.get("/bind", (req, res) => {
  res.type("html").send(bindPageHtml);
});

app.post("/mcp/bind", bindHandler);
app.post("/bind", bindHandler);
app.delete("/mcp/bind", unbindHandler);
app.delete("/bind", unbindHandler);

// ---------------- MCP 端点 ----------------

function isInitializeRequest(body) {
  return body && body.method === "initialize";
}

function createMcpServer() {
  const server = new McpServer({ name: "environ-mcp", version: VERSION });
  registerTools(server, { mode: "http" });
  return server;
}

/** 取出或新建 transport（stateful：每个会话一个 server 实例） */
async function resolveTransport(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    return transports.get(sessionId);
  }
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: 无有效会话 ID，请先发送 initialize 请求" },
      id: null,
    });
    return null;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      log(`会话建立：${sid}`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      log(`会话关闭：${transport.sessionId}`);
    }
  };
  const server = createMcpServer();
  await server.connect(transport);
  return transport;
}

app.post("/mcp", async (req, res) => {
  const transport = await resolveTransport(req, res);
  if (!transport) return;
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: 无有效会话 ID" },
      id: null,
    });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await transport.handleRequest(req, res);
});

// ---------------- SSE 老协议（兼容只支持 SSE 的平台，如 n8n） ----------------

app.get("/mcp/sse", async (req, res) => {
  const transport = new SSEServerTransport("/mcp/message", res);
  const server = createMcpServer();
  // 注意：server.connect(transport) 内部已经调用过 transport.start()，
  // 这里再调一次会抛 "SSEServerTransport already started!"
  await server.connect(transport);

  const store = requestContext.getStore() || {};
  sseSessions.set(transport.sessionId, {
    transport,
    server,
    identity: { oauth: store.oauth || null, clientKey: store.clientKey || null },
  });

  // server.close() 内部会调 transport.close()，transport 的 onclose 又会回调 server.close()，
  // 不加锁就是无限递归（RangeError: Maximum call stack size exceeded）
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    sseSessions.delete(transport.sessionId);
    server.close().catch(() => {});
  };
  transport.onclose = closeOnce;
  res.on("close", closeOnce);

  log(`SSE 会话建立：${transport.sessionId}`);
});

app.post("/mcp/message", async (req, res) => {
  const sessionId = String((req.query || {}).sessionId || "");
  const entry = sseSessions.get(sessionId);
  if (!entry) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  // SSE 客户端回传消息时不带身份，沿用建连时的身份
  await requestContext.run(
    { environToken: null, clientKey: entry.identity.clientKey, oauth: entry.identity.oauth },
    () => entry.transport.handlePostMessage(req, res, req.body)
  );
});

// ---------------- 健康检查 ----------------

function healthPayload() {
  return {
    ok: true,
    name: "environ-mcp",
    version: VERSION,
    apiBase: config.apiBase,
    authRequired: !!config.authToken,
    clientHeader: config.clientHeader,
    allowDefaultBinding: config.allowDefaultBinding,
    boundClients: bindings.clients.size,
    defaultBound: config.allowDefaultBinding && bindings.default ? bindings.default.userName : null,
    sessions: transports.size,
    sseSessions: sseSessions.size,
    oauth: {
      issuer: config.publicUrl,
      metadata: `${config.publicUrl}/.well-known/oauth-authorization-server`,
      resourceMetadata: `${config.publicUrl}/.well-known/oauth-protected-resource`,
    },
  };
}

app.get("/health", (req, res) => {
  res.json(healthPayload());
});

// 公网也用得到：nginx 只反代 /mcp 前缀，/mcp/health 会落到这里
app.get("/mcp/health", (req, res) => {
  res.json(healthPayload());
});

// ---------------- 服务介绍页 ----------------
// 作为 Registry 元数据里 websiteUrl 指向的页面，也是同事的接入说明。
app.get("/mcp/about", (req, res) => {
  res.type("html").send(aboutPageHtml);
});
app.get("/about", (req, res) => {
  res.type("html").send(aboutPageHtml);
});

// ---------------- MCP Server Card（SEP-1649） ----------------
// 目录站（Smithery / Glama 等）在 OAuth 鉴权墙挡住自动扫描时，
// 会退而读取这份静态元数据来生成服务页面。
app.get("/.well-known/mcp/server-card.json", (req, res) => {
  res.json(buildServerCard({ version: VERSION, publicUrl: config.publicUrl }));
});
app.get("/mcp/.well-known/mcp/server-card.json", (req, res) => {
  res.json(buildServerCard({ version: VERSION, publicUrl: config.publicUrl }));
});

// ---------------- MCP Registry 域名所有权验证 ----------------
// 官方 Registry 的 HTTP 验证方式会请求：
//     https://<你的域名>/.well-known/mcp-registry-auth
// 内容是一行公钥文本 v=MCPv1; k=ed25519; p=<base64>（公开信息，不是凭据）。
// 用 DNS TXT 验证则不需要这个端点。
app.get("/.well-known/mcp-registry-auth", (req, res) => {
  if (!config.registryAuthText) {
    res
      .status(404)
      .type("text/plain")
      .send("MCP_REGISTRY_AUTH not configured; use DNS TXT verification instead.");
    return;
  }
  res
    .type("text/plain")
    .set("Cache-Control", "no-store")
    .send(config.registryAuthText + "\n");
});
app.get("/mcp/.well-known/mcp-registry-auth", (req, res) => {
  if (!config.registryAuthText) {
    res.status(404).type("text/plain").send("MCP_REGISTRY_AUTH not configured.");
    return;
  }
  res.type("text/plain").set("Cache-Control", "no-store").send(config.registryAuthText + "\n");
});

// ---------------- 启动 ----------------

loadBindings();
loadOAuthStore();

const httpServer = app.listen(config.port, config.host, () => {
  log(`已启动(HTTP)。监听 ${config.host}:${config.port}/mcp`);
  log(`后端地址=${config.apiBase}  访问令牌校验=${config.authToken ? "开启" : "关闭"}`);
  log(`客户端标识头=${config.clientHeader}  已绑定客户端=${bindings.clients.size}  共享默认绑定=${config.allowDefaultBinding ? "开" : "关"}`);
  log(`OAuth 授权端点=${config.publicUrl}/oauth/authorize  SSE 端点=${config.publicUrl}/sse`);
});

// ---------------- 优雅退出 ----------------
// 容器 stop 时会发 SIGTERM：先关 MCP 会话，再让 in-flight 请求跑完，最后兜底强退。
// SSE 长连接会挂住 close()，所以必须调 closeAllConnections 兜底。

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，开始优雅退出…`);

  for (const [, transport] of transports) {
    try {
      await transport.close();
    } catch (ex) {
      /* 单个会话关闭失败不阻断整体退出 */
    }
  }
  transports.clear();

  for (const [, entry] of sseSessions) {
    try {
      await entry.transport.close();
    } catch (ex) {
      /* 同上 */
    }
  }
  sseSessions.clear();

  httpServer.close(() => {
    log("已退出");
    process.exit(0);
  });

  setTimeout(() => {
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
