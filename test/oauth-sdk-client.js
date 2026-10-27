/**
 * 用官方 SDK 客户端的 OAuth 实现（WorkBuddy 内置的就是同一套）验证服务端兼容性。
 *
 * 流程完全按 MCP 规范的客户端预期走：
 *   1. 发起请求 → 收到 401 + WWW-Authenticate
 *   2. 从 WWW-Authenticate 取 resource_metadata → 发现受保护资源元数据
 *   3. 发现授权服务器元数据 → 动态注册客户端
 *   4. 生成授权 URL（PKCE S256）
 *   5. 用户在浏览器里登录并同意 → 拿到授权码
 *   6. 用授权码 + code_verifier 换 access_token
 *   7. 带 access_token 再请求 → 成功
 *
 * 用法：node test/oauth-sdk-client.js [serverUrl]
 */
import crypto from "node:crypto";
import {
  auth,
  extractResourceMetadataUrl,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER = process.argv[2] || "https://app.environ.online/mcp";
const USER = process.env.ENVIRON_USER || "18785035798";
const PASSWORD = process.env.ENVIRON_PASSWORD || "";
if (!PASSWORD) {
  console.error("请先设置 ENVIRON_PASSWORD 环境变量（该账号密码属于敏感信息，不在仓库中提供默认值）");
  process.exit(1);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "\n   " + String(detail).replace(/\n/g, "\n   ") : ""}`);
  if (!ok) failed++;
};

const b64url = (b) => Buffer.from(b).toString("base64url");

/** 模拟 OAuthClientProvider：保存令牌与 PKCE 校验器 */
function makeProvider() {
  let tokens = null;
  let codeVerifier = null;
  let clientInfo = null;
  return {
    // 关键：没有 redirectUrl 的 provider 会被 SDK 当成「非交互流程」（直接换 token）
    redirectUrl: "http://127.0.0.1:9977/callback",
    clientMetadata: {
      client_name: "sdk-client-probe",
      redirect_uris: ["http://127.0.0.1:9977/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    clientInformation() {
      return clientInfo;
    },
    async saveClientInformation(info) {
      clientInfo = info;
    },
    tokens() {
      return tokens;
    },
    async saveTokens(t) {
      tokens = t;
    },
    codeVerifier() {
      return codeVerifier;
    },
    async saveCodeVerifier(v) {
      codeVerifier = v;
    },
    async redirectToAuthorization(url) {
      this._authUrl = url;
    },
    get authorizationUrl() {
      return this._authUrl;
    },
  };
}

const provider = makeProvider();

// 1) 触发 401
const probe = await fetch(SERVER, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const www = probe.headers.get("www-authenticate") || "";
check("服务端返回 401", probe.status === 401, `HTTP ${probe.status}`);
check("WWW-Authenticate 带 resource_metadata", /resource_metadata=/.test(www), www);

const resourceMetadataUrl = extractResourceMetadataUrl(probe);
check("能解析出 resource_metadata 地址", !!resourceMetadataUrl, String(resourceMetadataUrl));

// 2~4) 走 SDK 的 auth()：发现元数据 → 动态注册 → 生成授权 URL
const result = await auth(provider, {
  serverUrl: SERVER,
  resourceMetadataUrl,
  scope: "environ:read",
});
check("SDK auth() 返回 REDIRECT", result === "REDIRECT", String(result));
const authUrl = new URL(String(provider.authorizationUrl));
check(
  "授权 URL 指向我们的授权端点",
  authUrl.pathname.endsWith("/oauth/authorize") && authUrl.hostname === new URL(SERVER).hostname,
  String(provider.authorizationUrl).slice(0, 130)
);
check("授权 URL 带 PKCE S256 与 state", authUrl.searchParams.get("code_challenge_method") === "S256" && !!authUrl.searchParams.get("code_challenge"));
const ci = await provider.clientInformation();
check("动态注册拿到 client_id", !!ci?.client_id, ci?.client_id);
check("client_id 是动态注册格式", /^mcp_/.test(ci?.client_id || ""), ci?.client_id);

// 5) 模拟用户在浏览器登录并同意（真实情况是人在页面上填账号密码）
const loginRes = await fetch(authUrl.origin + authUrl.pathname, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_id: authUrl.searchParams.get("client_id"),
    redirect_uri: authUrl.searchParams.get("redirect_uri"),
    code_challenge: authUrl.searchParams.get("code_challenge"),
    code_challenge_method: authUrl.searchParams.get("code_challenge_method"),
    state: authUrl.searchParams.get("state"),
    username: USER,
    password: PASSWORD,
  }),
});
const loginJson = await loginRes.json();
const code = loginJson.redirect ? new URL(loginJson.redirect).searchParams.get("code") : null;
check("登录页返回授权码", !!code, JSON.stringify(loginJson).slice(0, 160));

// 6) 用授权码换令牌
const result2 = await auth(provider, {
  serverUrl: SERVER,
  authorizationCode: code,
  scope: "environ:read",
});
check("SDK auth() 返回 AUTHORIZED", result2 === "AUTHORIZED", String(result2));
const tk = await provider.tokens();
check("拿到 access_token", !!tk?.access_token, tk?.access_token?.slice(0, 12) + "…");

// 7) 带 access_token 调 MCP
const transport = new StreamableHTTPClientTransport(new URL(SERVER), {
  requestInit: { headers: { Authorization: `Bearer ${(await provider.tokens()).access_token}` } },
});
const client = new Client({ name: "sdk-probe", version: "1.0.0" });
await client.connect(transport);
const bind = await client.callTool({ name: "check_bind", arguments: {} });
const text = bind.content?.[0]?.text || "";
check("SDK 客户端带令牌可调用工具", /OAuth 授权/.test(text) && new RegExp(USER).test(text), text);
const st = await client.callTool({ name: "list_stations", arguments: {} });
check("能查到站点", /共\s*\d+\s*个站点/.test(st.content?.[0]?.text || ""), (st.content?.[0]?.text || "").split("\n")[0]);
await client.close();

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过（服务端与官方 SDK 客户端 OAuth 流程完全兼容）");
process.exit(failed ? 1 : 0);
