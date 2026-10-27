/**
 * OAuth 2.1 + PKCE 端到端测试
 *
 * 覆盖：元数据、动态客户端注册、授权码+PKCE 换令牌、令牌调 MCP、
 *       401 + WWW-Authenticate、设备码流程、刷新令牌、URL query 注入令牌。
 *
 * 用法：node test/oauth-e2e.js
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.TEST_PORT || 3113);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const AUTH = "oauth-test-token";
const API_BASE = process.env.ENVIRON_API_BASE || "http://localhost:8081";
const USER = process.env.ENVIRON_USER || "18785035798";
const PASSWORD = process.env.ENVIRON_PASSWORD || "";
if (!PASSWORD) {
  console.error("请先设置 ENVIRON_PASSWORD 环境变量（该账号密码属于敏感信息，不在仓库中提供默认值）");
  process.exit(1);
}

const BINDINGS_FILE = join(tmpdir(), `environ-mcp-bindings-oauth-${process.pid}.json`);
const OAUTH_FILE = join(tmpdir(), `environ-mcp-oauth-${process.pid}.json`);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "\n   " + String(detail).replace(/\n/g, "\n   ") : ""}`);
  if (!ok) failed++;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

const server = spawn(process.execPath, ["src/http-server.js"], {
  env: {
    ...process.env,
    MCP_AUTH_TOKEN: AUTH,
    MCP_PORT: String(PORT),
    MCP_HOST: "127.0.0.1",
    ENVIRON_API_BASE: API_BASE,
    ENVIRON_BINDINGS_FILE: BINDINGS_FILE,
    ENVIRON_OAUTH_FILE: OAUTH_FILE,
    MCP_PUBLIC_URL: `http://127.0.0.1:${PORT}/mcp`,
    ALLOW_DEFAULT_BINDING: "",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }

  // 1. 元数据
  const prRes = await fetch(`${BASE}/mcp/.well-known/oauth-protected-resource`);
  const pr = await prRes.json();
  check("Protected Resource 元数据可取", prRes.ok && !!pr.resource && Array.isArray(pr.authorization_servers), JSON.stringify(pr));

  const asRes = await fetch(`${BASE}/mcp/.well-known/oauth-authorization-server`);
  const as = await asRes.json();
  check(
    "Authorization Server 元数据可取",
    asRes.ok && as.code_challenge_methods_supported?.includes("S256") && !!as.token_endpoint,
    JSON.stringify(as)
  );

  // 2. 动态客户端注册
  const redirectUri = "http://127.0.0.1:9999/callback";
  const reg = await post("/mcp/oauth/register", {
    client_name: "测试客户端",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  });
  check("动态客户端注册成功", reg.status === 201 && !!reg.json?.client_id, JSON.stringify(reg.json));
  const clientId = reg.json?.client_id;

  // 3. 授权页（应渲染登录表单）
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = `/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(`http://127.0.0.1:${PORT}/mcp`)}`;
  const pageRes = await fetch(`${BASE}${authorizeUrl}`);
  const pageHtml = await pageRes.text();
  check("授权页渲染登录表单", pageRes.ok && /登录并授权/.test(pageHtml), `HTTP ${pageRes.status}`);

  // 4. 登录拿授权码
  const authRes = await post(
    "/mcp/oauth/authorize",
    {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      username: USER,
      password: PASSWORD,
    },
    { Cookie: "" }
  );
  const redirect = authRes.json?.redirect || "";
  const code = new URL(redirect).searchParams.get("code") || "";
  check("登录后返回授权码", authRes.status === 200 && !!code, redirect || JSON.stringify(authRes.json));

  // 5. 换令牌
  const tokenRes = await post("/mcp/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const accessToken = tokenRes.json?.access_token;
  check(
    "授权码换到 access_token",
    tokenRes.status === 200 && !!accessToken && tokenRes.json.token_type === "Bearer",
    JSON.stringify({ ...tokenRes.json, access_token: accessToken ? "***" : null })
  );

  // 6. 错误的 PKCE 校验器必须失败
  const badVer = await post("/mcp/oauth/token", {
    grant_type: "authorization_code",
    code: code || "x",
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: "wrong-verifier",
  });
  check("PKCE 校验失败时拒绝发令牌", badVer.status === 400, JSON.stringify(badVer.json));

  // 7. 用 access_token 调 MCP
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(transport);
  const bind = await client.callTool({ name: "check_bind", arguments: {} });
  const bindText = bind.content?.[0]?.text || "";
  check(
    "access_token 携带用户身份",
    /OAuth 授权/.test(bindText) && new RegExp(USER).test(bindText),
    bindText
  );
  const stations = await client.callTool({ name: "list_stations", arguments: {} });
  check("access_token 能查站点", /共\s*\d+\s*个站点/.test(stations.content?.[0]?.text || ""), (stations.content?.[0]?.text || "").split("\n")[0]);
  await client.close();

  // 8. 无令牌必须 401 并带 WWW-Authenticate
  const unauth = await fetch(`${MCP_URL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const www = unauth.headers.get("www-authenticate") || "";
  check(
    "未授权返回 401 + WWW-Authenticate(resource_metadata)",
    unauth.status === 401 && /resource_metadata=/.test(www),
    `HTTP ${unauth.status} | ${www}`
  );

  // 9. 刷新令牌
  const refreshRes = await post("/mcp/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: tokenRes.json?.refresh_token,
    client_id: clientId,
  });
  check("刷新令牌可换新 access_token", refreshRes.status === 200 && !!refreshRes.json?.access_token, JSON.stringify({ ...refreshRes.json, access_token: refreshRes.json?.access_token ? "***" : null }));

  // 10. 设备码流程
  const devRes = await post("/mcp/oauth/device_authorization", { client_id: clientId });
  const userCode = devRes.json?.user_code;
  check("设备码申请成功", devRes.status === 200 && !!userCode && !!devRes.json?.device_code, JSON.stringify({ ...devRes.json, device_code: "***" }));

  const pending = await post("/mcp/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: devRes.json?.device_code,
    client_id: clientId,
  });
  check("未确认时轮询返回 authorization_pending", pending.status === 400 && pending.json?.error === "authorization_pending", JSON.stringify(pending.json));

  const devApprove = await post("/mcp/oauth/device", { user_code: userCode, username: USER, password: PASSWORD });
  check("设备码确认成功", devApprove.status === 200 && devApprove.json?.ok === true, JSON.stringify(devApprove.json));

  const devToken = await post("/mcp/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: devRes.json?.device_code,
    client_id: clientId,
  });
  check("设备码换到 access_token", devToken.status === 200 && !!devToken.json?.access_token, JSON.stringify({ ...devToken.json, access_token: devToken.json?.access_token ? "***" : null }));

  // 11. URL query 注入令牌（火山引擎 injection_type=query）
  const qTransport = new StreamableHTTPClientTransport(
    new URL(`${MCP_URL}?token=${encodeURIComponent(AUTH)}&client=query-client-001`),
    { requestInit: { headers: {} } }
  );
  const qClient = new Client({ name: "query-token-test", version: "1.0.0" });
  await qClient.connect(qTransport);
  const qTools = await qClient.listTools();
  check("URL query 注入令牌可连接", qTools.tools.length > 0, `工具数 ${qTools.tools.length}`);
  await qClient.close();
} catch (ex) {
  console.error("❌ 测试异常：", ex?.stack || ex);
  failed++;
} finally {
  server.kill();
  for (const f of [BINDINGS_FILE, OAUTH_FILE]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
