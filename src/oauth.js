/**
 * OAuth 2.1 授权服务器（面向 MCP 的标准授权流程）
 *
 * 实现的规范面：
 *   - RFC 8414  授权服务器元数据  /.well-known/oauth-authorization-server
 *   - RFC 9728  受保护资源元数据  /.well-known/oauth-protected-resource
 *   - RFC 7591  动态客户端注册    /oauth/register
 *   - RFC 7636  PKCE（S256）      授权码流程强制要求
 *   - RFC 6749  授权码 + 刷新令牌  /oauth/token
 *   - RFC 8628  设备授权流程       /oauth/device_authorization（客户端不支持跳转时用）
 *   - RFC 7009  令牌撤销          /oauth/revoke
 *
 * 身份落点：OAuth access_token 里带着该用户的 environ token，
 * MCP 工具调用时直接用这个 token 调后端，权限与本人一致。
 *
 * 路径说明：公网 nginx 只反代 /mcp 前缀（根路径被 SPA 占着），
 * 所以所有端点都同时挂在 `/mcp/...` 下，metadata 里给出的 URL 也都带 /mcp 前缀。
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { apiPost, config, log, resolveBindToken } from "./core.js";
import { md5Hex } from "./md5.js";

// ---------------- 基础工具 ----------------

const rand = (n = 32) => crypto.randomBytes(n).toString("base64url");
const sha256b64 = (s) => crypto.createHash("sha256").update(s).digest("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

const ACCESS_TOKEN_TTL = Number(process.env.OAUTH_ACCESS_TTL || 86400); // 24 小时
const REFRESH_TOKEN_TTL = Number(process.env.OAUTH_REFRESH_TTL || 2592000); // 30 天
const CODE_TTL = 120; // 授权码 2 分钟
const DEVICE_TTL = 900; // 设备码 15 分钟
const SESSION_COOKIE = "wb_oauth_sid";

// ---------------- 存储 ----------------

/** clients / codes / tokens / refresh / devices 全部落盘，容器重启不丢 */
const store = {
  clients: {},
  codes: {},
  tokens: {},
  refresh: {},
  devices: {},
};

export function loadOAuthStore() {
  try {
    if (!existsSync(config.oauthFile)) return;
    const raw = JSON.parse(readFileSync(config.oauthFile, "utf8"));
    for (const k of ["clients", "codes", "tokens", "refresh", "devices"]) {
      if (raw[k] && typeof raw[k] === "object") store[k] = raw[k];
    }
    log(
      `已载入 OAuth 存储：客户端 ${Object.keys(store.clients).length} 个，令牌 ${Object.keys(store.tokens).length} 个`
    );
  } catch (ex) {
    log("载入 OAuth 存储失败:", ex.message);
  }
}

export function persistOAuthStore() {
  try {
    mkdirSync(dirname(config.oauthFile), { recursive: true });
    writeFileSync(config.oauthFile, JSON.stringify(store, null, 2), "utf8");
  } catch (ex) {
    log("保存 OAuth 存储失败:", ex.message);
  }
}

function sweep() {
  const t = nowSec();
  for (const [k, v] of Object.entries(store.codes)) if (v.expiresAt < t) delete store.codes[k];
  for (const [k, v] of Object.entries(store.tokens)) if (v.expiresAt < t) delete store.tokens[k];
  for (const [k, v] of Object.entries(store.refresh)) if (v.expiresAt < t) delete store.refresh[k];
  for (const [k, v] of Object.entries(store.devices)) if (v.expiresAt < t) delete store.devices[k];
}

// ---------------- 会话（登录态 Cookie） ----------------

function sessionSecret() {
  return crypto.createHash("sha256").update(`wb-oauth:${config.authToken || "no-auth-token"}`).digest();
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function makeSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}
function readSession(req) {
  const raw = req.headers.cookie || "";
  const hit = raw
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (!hit) return null;
  const val = hit.slice(SESSION_COOKIE.length + 1);
  const dot = val.lastIndexOf(".");
  if (dot < 0) return null;
  const body = val.slice(0, dot);
  const sig = val.slice(dot + 1);
  const expect = sign(body);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.expiresAt || payload.expiresAt < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res, identity) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${makeSession({
      environToken: identity.environToken,
      userId: identity.userId,
      userName: identity.userName,
      expiresAt: nowSec() + REFRESH_TOKEN_TTL,
    })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REFRESH_TOKEN_TTL}`
  );
}

// ---------------- 令牌校验 ----------------

/** 用 access_token 换取身份信息（用户 + environ token） */
export function resolveAccessToken(token) {
  if (!token) return null;
  sweep();
  const rec = store.tokens[token];
  if (!rec) return null;
  if (rec.expiresAt < nowSec()) {
    delete store.tokens[token];
    persistOAuthStore();
    return null;
  }
  return rec;
}

/** 撤销某个 access_token（连带其刷新令牌） */
export function revokeToken(token) {
  if (!token) return false;
  const existed = !!store.tokens[token];
  delete store.tokens[token];
  for (const [k, v] of Object.entries(store.refresh)) {
    if (v.accessToken === token) delete store.refresh[k];
  }
  if (existed) persistOAuthStore();
  return existed;
}

function isStaticAdmin(req) {
  if (!config.authToken) return true;
  const auth = req.headers.authorization || "";
  const t = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : auth.trim();
  return t === config.authToken;
}

// ---------------- 客户端注册（RFC 7591） ----------------

function validRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    // 原生 App 常见的私有 scheme
    if (!["http:", "https:", "file:"].includes(u.protocol)) return true;
    return false;
  } catch {
    return false;
  }
}

function registerClient(body) {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length) {
    return { error: "invalid_redirect_uri", error_description: "redirect_uris 不能为空" };
  }
  for (const u of redirectUris) {
    if (!validRedirectUri(u)) {
      return {
        error: "invalid_redirect_uri",
        error_description: `不允许的回调地址：${u}（只允许 https 或 localhost）`,
      };
    }
  }
  const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
    ? body.grant_types.filter((g) =>
        [
          "authorization_code",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:device_code",
        ].includes(g)
      )
    : ["authorization_code", "refresh_token"];

  const clientId = `mcp_${rand(12)}`;
  const rec = {
    client_id: clientId,
    client_name: body.client_name || "MCP Client",
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: body.scope || "environ:read",
    createdAt: nowSec(),
  };
  // 可选字段只在有值时返回：客户端会用 schema 校验响应，null 会被判为非法
  if (body.client_uri) rec.client_uri = String(body.client_uri);
  if (body.logo_uri) rec.logo_uri = String(body.logo_uri);

  store.clients[clientId] = rec;
  persistOAuthStore();
  log(`OAuth 客户端注册：${rec.client_name} (${clientId})`);
  return { ...rec };
}

// ---------------- 令牌签发 ----------------

function issueTokens({ userId, userName, environToken, scope, clientId, resource }) {
  const accessToken = rand(32);
  const refreshToken = rand(32);
  const t = nowSec();
  store.tokens[accessToken] = {
    accessToken,
    userId,
    userName,
    environToken,
    scope,
    clientId,
    resource,
    expiresAt: t + ACCESS_TOKEN_TTL,
  };
  store.refresh[refreshToken] = {
    refreshToken,
    accessToken,
    userId,
    userName,
    environToken,
    scope,
    clientId,
    resource,
    expiresAt: t + REFRESH_TOKEN_TTL,
  };
  persistOAuthStore();
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: scope || "environ:read",
  };
}

function issueCode({ client, q, session }) {
  const code = rand(32);
  store.codes[code] = {
    code,
    clientId: client.client_id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    userId: session.userId,
    userName: session.userName,
    environToken: session.environToken,
    scope: q.scope || client.scope,
    resource: q.resource || config.publicUrl,
    expiresAt: nowSec() + CODE_TTL,
  };
  persistOAuthStore();
  return code;
}

/**
 * 用 environ 账号密码换身份。
 *
 * 密码有两种来源：
 *   - passwordMd5：浏览器端已做 MD5（与 environ 前端登录页一致），优先使用
 *   - password：明文（兼容旧后端）
 *
 * 内部按 environ 的两套密码契约依次尝试（见 core.js 的 resolveBindToken）。
 */
async function loginToEnviron(username, password, passwordMd5) {
  const { data } = await resolveBindToken({ username, password, passwordMd5 });
  if (!data || !data.token) throw new Error("用户名或密码错误");
  return { environToken: data.token, userId: data.userId, userName: data.userName };
}

// ---------------- 页面 ----------------

function loginPage({ title, hint, userCode }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root{--bg:#f6f6f4;--card:#fff;--text:#1f1f1e;--muted:#6b6a65;--line:rgba(0,0,0,.12);
        --accent:#185fa5;--ok:#3b6d11;--ok-soft:#eaf3de;--danger:#a32d2d;--danger-soft:#fcebeb}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 16px;background:var(--bg);color:var(--text);
       font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       display:flex;justify-content:center}
  .card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);
        border-radius:12px;padding:28px}
  h1{font-size:18px;font-weight:500;margin:0 0 6px}
  p.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
  label{display:block;font-size:13px;margin:14px 0 6px}
  input{width:100%;padding:9px 11px;font-size:14px;border:1px solid var(--line);border-radius:8px;outline:none}
  input:focus{border-color:var(--accent)}
  .code{font:600 24px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:4px;
        background:var(--ok-soft);color:var(--ok);padding:10px 14px;border-radius:8px;
        display:inline-block;margin:6px 0 4px}
  button{width:100%;margin-top:20px;padding:10px 14px;font-size:14px;font-weight:500;color:#fff;
         background:var(--accent);border:0;border-radius:8px;cursor:pointer}
  .msg{margin-top:16px;padding:10px 12px;border-radius:8px;font-size:13px;display:none}
  .msg.ok{display:block;background:var(--ok-soft);color:var(--ok)}
  .msg.err{display:block;background:var(--danger-soft);color:var(--danger)}
  .hint{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
</style></head>
<body><div class="card">
  <h1>${title}</h1>
  <p class="sub">${hint}</p>
  ${userCode ? `<div class="code">${userCode}</div><p class="sub">请在客户端上确认这个验证码</p>` : ""}
  <form method="post" id="f">
    <label for="user">environ 用户名</label>
    <input id="user" name="username" autocomplete="username" placeholder="手机号 / 邮箱 / 用户名" required />
    <label for="pass">密码</label>
    <input id="pass" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">登录并授权</button>
  </form>
  <div class="msg" id="msg"></div>
  <div class="hint">密码只在你的浏览器与服务器之间传输，不会出现在对话记录里。</div>
</div>
<script>
${md5Hex.toString()}

(function(){
  var f=document.getElementById('f'),msg=document.getElementById('msg');
  // auto   —— 先提交 MD5，失败后回退明文一次（兼容后端尚未支持 passwordMd5）
  // strict —— 只提交 MD5，绝不发送明文
  var MD5_MODE='${config.passwordMode}';

  function post(payload){
    return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)})
      .then(function(r){return r.json().then(function(j){return {status:r.status,body:j};});});
  }

  f.addEventListener('submit',function(e){
    e.preventDefault();
    var fd=new FormData(f);
    var user=fd.get('username'), pass=fd.get('password');
    msg.className='msg';msg.textContent='正在登录…';
    // 与 environ 前端登录页一致：密码在浏览器里先做 MD5
    post({username:user,password:md5Hex(pass)})
      .then(function(res){
        if(res.body&&res.body.ok) return res;
        if(MD5_MODE==='strict') return res;
        return post({username:user,password:pass}).then(function(res2){
          return (res2.body&&res2.body.ok)?res2:res;
        });
      })
      .then(function(res){
        if(res.body&&res.body.ok){
          msg.className='msg ok';msg.textContent=res.body.message||'已授权，正在返回客户端…';
          if(res.body.redirect){setTimeout(function(){location.href=res.body.redirect;},600);}
        }else{
          msg.className='msg err';
          msg.textContent='失败：'+((res.body&&(res.body.error_description||res.body.error))||('HTTP '+res.status));
        }
      })
      .catch(function(e){msg.className='msg err';msg.textContent='请求失败：'+e.message;});
  });
})();
</script>
</body></html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><title>授权失败</title>
<style>body{font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;background:#f6f6f4;color:#1f1f1e;padding:48px}
.box{max-width:520px;margin:0 auto;background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:28px}
h1{font-size:17px;font-weight:500;margin:0 0 10px}code{background:#e6f1fb;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h1>授权失败</h1><p>${message}</p>
<p>如果反复失败，请把这段信息发给 MCP 服务管理员。</p></div></body></html>`;
}

// ---------------- 路由注册 ----------------

/**
 * 把 OAuth 端点挂到 express 上。
 * @param {import("express").Express} app
 */
export function registerOAuthRoutes(app) {
  const base = config.publicUrl; // 例：https://app.environ.online/mcp
  const issuer = base; // 授权服务器标识符 = 资源地址

  // 所有端点同时挂在 /mcp 前缀下（公网 nginx 只反代这一段）
  const mount = (method, path, handler) => {
    app[method](`/mcp${path}`, handler);
    app[method](path, handler);
  };

  // ---------- 元数据 ----------

  const asMetadata = {
    issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    device_authorization_endpoint: `${base}/oauth/device_authorization`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: ["environ:read"],
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${base}/`,
    resource_indicators_supported: true,
  };

  const prMetadata = {
    resource: base,
    authorization_servers: [issuer],
    scopes_supported: ["environ:read"],
    bearer_methods_supported: ["header"],
    resource_name: "environ 环境监测数据 MCP",
  };

  for (const p of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const handler = (req, res) => {
      res.json(p.includes("protected-resource") ? prMetadata : asMetadata);
    };
    mount("get", p, handler);
  }

  // ---------- 动态客户端注册 ----------

  mount("post", "/oauth/register", (req, res) => {
    const out = registerClient(req.body || {});
    if (out.error) {
      res.status(400).json(out);
      return;
    }
    res.status(201).json(out);
  });

  // ---------- 授权端点 ----------

  mount("get", "/oauth/authorize", (req, res) => {
    const q = req.query || {};
    const client = store.clients[q.client_id];
    if (!client) {
      res.status(400).type("html").send(errorPage(`未注册的客户端：<code>${q.client_id || "空"}</code>`));
      return;
    }
    if (!client.redirect_uris.includes(q.redirect_uri)) {
      res.status(400).type("html").send(errorPage("回调地址与注册时不一致，已拒绝。"));
      return;
    }
    if (q.response_type !== "code") {
      res.status(400).type("html").send(errorPage("只支持 <code>response_type=code</code>。"));
      return;
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      res.status(400).type("html").send(
        errorPage(
          "必须使用 PKCE：缺少 <code>code_challenge</code> 或 <code>code_challenge_method</code> 不是 S256。"
        )
      );
      return;
    }
    if (q.resource && q.resource !== base) {
      res.status(400).type("html").send(errorPage(`资源标识不匹配，应为 <code>${base}</code>。`));
      return;
    }

    // 已有登录态：直接发授权码
    const session = readSession(req);
    if (session && session.environToken) {
      const code = issueCode({ client, q, session });
      res.redirect(`${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state || "")}`);
      return;
    }

    res.type("html").send(
      loginPage({
        title: "授权 environ-mcp",
        hint: "登录后即授予「读取站点监测数据」的权限，随时可以在客户端里撤销。",
      })
    );
  });

  mount("post", "/oauth/authorize", async (req, res) => {
    const body = req.body || {};
    const client = store.clients[body.client_id];
    if (!client) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    if (!client.redirect_uris.includes(body.redirect_uri)) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    let identity;
    try {
      identity = await loginToEnviron(body.username, body.password, body.passwordMd5);
    } catch (ex) {
      res.status(401).json({ error: "invalid_grant", error_description: ex.message });
      return;
    }
    setSessionCookie(res, identity);
    const code = issueCode({ client, q: body, session: identity });
    res.json({
      ok: true,
      message: "授权成功，正在返回客户端…",
      redirect: `${body.redirect_uri}?code=${code}&state=${encodeURIComponent(body.state || "")}`,
    });
  });

  // ---------- 设备授权流程（RFC 8628） ----------

  mount("post", "/oauth/device_authorization", (req, res) => {
    const body = req.body || {};
    const client = store.clients[body.client_id];
    if (!client) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    const deviceCode = rand(32);
    const userCode = rand(6).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "ABCD1234";
    store.devices[deviceCode] = {
      deviceCode,
      userCode,
      clientId: client.client_id,
      scope: body.scope || client.scope,
      resource: body.resource || base,
      status: "pending",
      expiresAt: nowSec() + DEVICE_TTL,
    };
    persistOAuthStore();
    res.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/oauth/device`,
      verification_uri_complete: `${base}/oauth/device?user_code=${userCode}`,
      expires_in: DEVICE_TTL,
      interval: 5,
    });
  });

  mount("get", "/oauth/device", (req, res) => {
    const userCode = String((req.query || {}).user_code || "").toUpperCase();
    res.type("html").send(
      loginPage({
        title: "设备授权",
        hint: "在客户端上确认下面的验证码；确认后客户端会自动获取访问令牌。",
        userCode,
      })
    );
  });

  mount("post", "/oauth/device", async (req, res) => {
    const body = req.body || {};
    const code = String(body.user_code || "").toUpperCase();
    const hit = Object.values(store.devices).find((d) => d.userCode === code);
    if (!hit) {
      res.status(404).json({ error: "invalid_user_code", error_description: "验证码不存在或已过期" });
      return;
    }
    if (hit.status !== "pending") {
      res.status(400).json({ error: "invalid_user_code", error_description: "该验证码已使用" });
      return;
    }
    let identity;
    try {
      identity = await loginToEnviron(body.username, body.password, body.passwordMd5);
    } catch (ex) {
      res.status(401).json({ error: "invalid_grant", error_description: ex.message });
      return;
    }
    hit.status = "approved";
    hit.userId = identity.userId;
    hit.userName = identity.userName;
    hit.environToken = identity.environToken;
    hit.approvedAt = nowSec();
    persistOAuthStore();
    setSessionCookie(res, identity);
    res.json({ ok: true, message: "已确认，客户端现在可以获取访问令牌。" });
  });

  // ---------- 令牌端点 ----------

  mount("post", "/oauth/token", (req, res) => {
    const body = req.body || {};
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const rec = store.codes[body.code];
      if (!rec) {
        res.status(400).json({ error: "invalid_grant", error_description: "授权码无效或已过期" });
        return;
      }
      delete store.codes[body.code];
      persistOAuthStore();
      if (rec.expiresAt < nowSec()) {
        res.status(400).json({ error: "invalid_grant", error_description: "授权码已过期" });
        return;
      }
      if (rec.clientId !== body.client_id) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      if (rec.redirectUri !== body.redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri 不匹配" });
        return;
      }
      // PKCE 校验：S256(verifier) == challenge
      if (sha256b64(String(body.code_verifier || "")) !== rec.codeChallenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE 校验失败" });
        return;
      }
      res.json(
        issueTokens({
          userId: rec.userId,
          userName: rec.userName,
          environToken: rec.environToken,
          scope: rec.scope,
          clientId: rec.clientId,
          resource: rec.resource,
        })
      );
      return;
    }

    if (grantType === "refresh_token") {
      const rec = store.refresh[body.refresh_token];
      if (!rec || rec.expiresAt < nowSec()) {
        res.status(400).json({ error: "invalid_grant", error_description: "刷新令牌无效或已过期" });
        return;
      }
      if (rec.clientId !== body.client_id) {
        res.status(400).json({ error: "invalid_client" });
        return;
      }
      delete store.tokens[rec.accessToken];
      delete store.refresh[body.refresh_token];
      res.json(
        issueTokens({
          userId: rec.userId,
          userName: rec.userName,
          environToken: rec.environToken,
          scope: rec.scope,
          clientId: rec.clientId,
          resource: rec.resource,
        })
      );
      return;
    }

    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const rec = store.devices[body.device_code];
      if (!rec) {
        res.status(400).json({ error: "invalid_grant", error_description: "设备码无效" });
        return;
      }
      if (rec.status === "pending") {
        res.status(400).json({ error: "authorization_pending" });
        return;
      }
      if (rec.status === "denied") {
        res.status(400).json({ error: "access_denied" });
        return;
      }
      delete store.devices[body.device_code];
      persistOAuthStore();
      res.json(
        issueTokens({
          userId: rec.userId,
          userName: rec.userName,
          environToken: rec.environToken,
          scope: rec.scope,
          clientId: rec.clientId,
          resource: rec.resource,
        })
      );
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---------- 令牌撤销（RFC 7009） ----------

  mount("post", "/oauth/revoke", (req, res) => {
    const body = req.body || {};
    revokeToken(body.token);
    res.status(200).json({ ok: true });
  });

  // ---------- 管理视图（需管理令牌） ----------

  mount("get", "/oauth/clients", (req, res) => {
    if (!isStaticAdmin(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({
      clients: Object.values(store.clients).map((c) => ({
        client_id: c.client_id,
        client_name: c.client_name,
        redirect_uris: c.redirect_uris,
        createdAt: c.createdAt,
      })),
      tokens: Object.values(store.tokens).map((t) => ({
        user: t.userName,
        userId: t.userId,
        clientId: t.clientId,
        expiresAt: t.expiresAt,
      })),
      devices: Object.values(store.devices).length,
    });
  });
}
