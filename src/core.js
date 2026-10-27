/**
 * 共享核心：配置、请求上下文（ALS）、environ 后端客户端、token 存取、输出格式化。
 * stdio 入口（server.js）与 HTTP 入口（http-server.js）共用本模块。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ==================== 版本 ====================

/** 版本号统一从 package.json 读，避免与镜像 tag 不一致 */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

// ==================== 请求级上下文 ====================

/**
 * 存放当前请求的 environ token。
 * HTTP 模式下多用户各自带 token；stdio 模式下为空，回退到本地默认绑定。
 */
export const requestContext = new AsyncLocalStorage();

/**
 * 绑定表：clientKey -> 账号信息（含 environ token）
 *
 * clientKey 由客户端（每个同事的 WorkBuddy 配置）自带，视为「谁的电脑」的凭据。
 * 服务器按 clientKey 记住该用户绑定的 environ token，于是不同同事调用同一套工具
 * 时拿到的分别是自己的站点权限。
 */
export const bindings = {
  // 共享兜底绑定：仅在显式允许时使用（ALLOW_DEFAULT_BINDING=1），默认禁用
  default: null,
  clients: new Map(),
};

/**
 * 取当前生效的 environ token，优先级：
 *   1) OAuth access_token 携带的用户身份（标准流程，最优先）
 *   2) 请求头 X-Environ-Token（直传业务 token）
 *   3) 请求头 X-Environ-Client 对应的客户端绑定
 *   4) 共享默认绑定（ALLOW_DEFAULT_BINDING=1 时才允许）
 *   5) 本地 token 文件（stdio 模式）
 *
 * 注意：Authorization 头是 MCP 访问令牌（config.authToken / OAuth access_token），**不能**当 environ token 用。
 */
export function currentToken() {
  const store = requestContext.getStore();
  if (store && store.oauth && store.oauth.environToken) return store.oauth.environToken;
  if (store && store.environToken) return store.environToken;
  if (store && store.clientKey) {
    const bound = bindings.clients.get(store.clientKey);
    if (bound && bound.token) return bound.token;
  }
  if (config.allowDefaultBinding && bindings.default && bindings.default.token) {
    return bindings.default.token;
  }
  return getSavedToken();
}

/** 当前请求的客户端标识（没有则 null） */
export function currentClientKey() {
  const store = requestContext.getStore();
  return (store && store.clientKey) || null;
}

/**
 * 当前生效的身份说明，用于 check_bind / whoami 展示。
 * source: oauth | header-token | client | client-unbound | default | local-file | none
 */
export function currentIdentity() {
  const store = requestContext.getStore();
  if (store && store.oauth && store.oauth.environToken) {
    return {
      source: "oauth",
      clientKey: store.clientKey || null,
      userId: store.oauth.userId,
      userName: store.oauth.userName,
      scope: store.oauth.scope,
      expiresAt: store.oauth.expiresAt,
      token: store.oauth.environToken,
    };
  }
  if (store && store.environToken) {
    return { source: "header-token", clientKey: store.clientKey || null, token: store.environToken };
  }
  if (store && store.clientKey) {
    const bound = bindings.clients.get(store.clientKey);
    if (bound) {
      return {
        source: "client",
        clientKey: store.clientKey,
        userId: bound.userId,
        userName: bound.userName,
        boundAt: bound.boundAt,
        expireDays: bound.expireDays,
        token: bound.token,
      };
    }
    return { source: "client-unbound", clientKey: store.clientKey };
  }
  if (config.allowDefaultBinding && bindings.default) {
    return {
      source: "default",
      userId: bindings.default.userId,
      userName: bindings.default.userName,
      boundAt: bindings.default.boundAt,
      token: bindings.default.token,
    };
  }
  if (getSavedToken()) return { source: "local-file" };
  return { source: "none" };
}

/** 绑定到某个客户端标识（内存 + 落盘） */
export function bindToClient(clientKey, payload) {
  bindings.clients.set(clientKey, { ...payload, boundAt: new Date().toISOString() });
  persistBindings();
  return bindings.clients.get(clientKey);
}

/** 解除某个客户端的绑定 */
export function unbindClient(clientKey) {
  const existed = bindings.clients.delete(clientKey);
  if (existed) persistBindings();
  return existed;
}

/** 载入磁盘上的绑定表（容器重启后用户不用重新绑定） */
export function loadBindings() {
  try {
    if (!existsSync(config.bindingsFile)) return;
    const raw = JSON.parse(readFileSync(config.bindingsFile, "utf8"));
    if (raw && raw.default) bindings.default = raw.default;
    if (raw && raw.clients && typeof raw.clients === "object") {
      for (const [k, v] of Object.entries(raw.clients)) {
        if (v && v.token) bindings.clients.set(k, v);
      }
    }
    log(`已载入绑定表：${bindings.clients.size} 个客户端`);
  } catch (ex) {
    log("载入绑定表失败:", ex.message);
  }
}

/** 绑定表落盘 */
export function persistBindings() {
  try {
    mkdirSync(dirname(config.bindingsFile), { recursive: true });
    const out = {
      default: bindings.default,
      clients: Object.fromEntries(bindings.clients),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(config.bindingsFile, JSON.stringify(out, null, 2), "utf8");
  } catch (ex) {
    log("保存绑定表失败:", ex.message);
  }
}

// ==================== 配置 ====================

export const config = {
  apiBase: (process.env.ENVIRON_API_BASE || "http://localhost:8080").replace(/\/+$/, ""),
  tokenFile:
    process.env.ENVIRON_TOKEN_FILE || join(homedir(), ".workbuddy", "environ-mcp", "token.json"),
  requestTimeout: Number(process.env.ENVIRON_TIMEOUT_MS || 20000),
  // HTTP 入口：对外服务的静态访问令牌（未设置则不校验）
  authToken: (process.env.MCP_AUTH_TOKEN || "").trim(),
  port: Number(process.env.MCP_PORT || 3000),
  host: process.env.MCP_HOST || "127.0.0.1",
  // 客户端标识请求头：每个同事的 WorkBuddy 配置里放一个自己的随机串，用来区分用户
  clientHeader: (process.env.MCP_CLIENT_HEADER || "x-environ-client").trim().toLowerCase(),
  // 是否允许「共享默认绑定」兜底。多人共用一套服务时必须保持关闭（默认关闭），
  // 否则谁先绑定谁的身份会被所有人共用。
  allowDefaultBinding: /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_DEFAULT_BINDING || "").trim()),
  // 绑定表落盘位置（容器重启后不必重新绑定）
  bindingsFile:
    process.env.ENVIRON_BINDINGS_FILE || join(homedir(), ".workbuddy", "environ-mcp", "bindings.json"),
  // OAuth 存储（客户端注册 / 授权码 / 令牌）落盘位置
  oauthFile:
    process.env.ENVIRON_OAUTH_FILE ||
    join(homedir(), ".workbuddy", "environ-mcp", "oauth.json"),
  // 对外的 MCP 地址，用于生成接入配置片段
  publicUrl: (process.env.MCP_PUBLIC_URL || "https://app.environ.online/mcp").replace(/\/+$/, ""),
  /**
   * 浏览器端密码的提交方式：
   *   auto   —— 先提交 MD5（与 environ 前端登录页一致），失败后回退明文一次。
   *             用于后端尚未支持 passwordMd5 的过渡期。
   *   strict —— 只提交 MD5，绝不发送明文。要求后端 /openapi/bind 已支持 passwordMd5。
   */
  passwordMode: /^(strict|auto)$/i.test(String(process.env.ENVIRON_PASSWORD_MODE || "auto").trim())
    ? String(process.env.ENVIRON_PASSWORD_MODE || "auto").trim().toLowerCase()
    : "auto",
  /**
   * MCP Registry 域名所有权验证用的公钥文本。
   * 形如：v=MCPv1; k=ed25519; p=<base64公钥>
   * 由 mcp-publisher 的密钥对生成，填进环境变量 MCP_REGISTRY_AUTH 即可，
   * 服务端会在 /.well-known/mcp-registry-auth 暴露它（这是公开信息，不是凭据）。
   */
  registryAuthText: (process.env.MCP_REGISTRY_AUTH || "").trim(),
};

export function log(...args) {
  console.error("[environ-mcp]", ...args);
}

// ==================== token 存取 ====================

export function getSavedToken() {
  if (process.env.ENVIRON_TOKEN) return process.env.ENVIRON_TOKEN.trim();
  try {
    if (existsSync(config.tokenFile)) {
      const raw = JSON.parse(readFileSync(config.tokenFile, "utf8"));
      if (raw && raw.token) return String(raw.token).trim();
    }
  } catch (ex) {
    log("读取 token 文件失败:", ex.message);
  }
  return null;
}

export function saveToken(payload) {
  mkdirSync(dirname(config.tokenFile), { recursive: true });
  writeFileSync(
    config.tokenFile,
    JSON.stringify({ ...payload, savedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

// ==================== environ 后端客户端 ====================

async function httpRequest(method, path, { query, body, token, withResponse, noToken, noThrow } = {}) {
  // apiBase 可能带路径前缀（如 https://app.environ.online/api），
  // 所以用「相对路径 + 末尾补斜杠」的方式拼接：
  //   base=https://app.environ.online/api  -> https://app.environ.online/api/openapi/stations
  //   base=http://localhost:8081        -> http://localhost:8081/openapi/stations
  // 注意：若 path 以 "/" 开头，new URL 会丢掉 base 的路径前缀，所以这里要去掉前导斜杠。
  const base = config.apiBase.endsWith("/") ? config.apiBase : `${config.apiBase}/`;
  const url = new URL(path.replace(/^\/+/, ""), base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = {};
  const t = noToken ? null : token || getSavedToken();
  if (t) headers["Authorization"] = `Bearer ${t}`;
  if (body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeout);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (ex) {
    if (ex.name === "AbortError") {
      throw new Error(`请求 environ 后端超时（${config.apiBase}），请确认服务已启动`);
    }
    throw new Error(`无法连接 environ 后端 ${config.apiBase}：${ex.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (noThrow) {
      return { status: res.status, headers: res.headers, data: null, json: null, text };
    }
    throw new Error(`后端返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  // Result 约定：error=1 表示业务失败
  if (json && json.error === 1 && !noThrow) {
    throw new Error(json.message || "接口返回业务错误");
  }
  if (withResponse) {
    return { status: res.status, headers: res.headers, data: json && json.data, json, text };
  }
  return json.data;
}

export const apiGet = (path, query, token) => httpRequest("GET", path, { query, token });
export const apiPost = (path, body, token) => httpRequest("POST", path, { body, token });

// ==================== environ 登录（两套密码契约） ====================

/**
 * 走 environ 正统登录 POST /user/login（Spring Security）拿 JWT。
 *
 * 密码契约：客户端提交 **MD5(密码)**（与 environ 前端登录页一致），
 * 服务端的过滤器会再做一层 encrypt，然后与库里的 Upassword 比对。
 * 这条路覆盖「Upassword 存的是 encrypt(name, MD5(pwd))」的账号。
 *
 * 成功时 JWT 在响应头 Authorization 里（JsonLoginSuccessHandler 设置）。
 *
 * @param {string} username
 * @param {string} md5Password 32 位小写十六进制
 * @returns {Promise<{ok:boolean, jwt?:string, message?:string}>}
 */
export async function loginForJwt(username, md5Password) {
  const res = await httpRequest("POST", "/user/login", {
    body: { username, password: md5Password },
    noToken: true,
    withResponse: true,
    noThrow: true,
  });
  if (res.status >= 200 && res.status < 300) {
    const jwt = res.headers.get("authorization") || (res.json && res.json.token) || null;
    if (jwt) return { ok: true, jwt };
    return { ok: false, message: "登录成功但未返回令牌" };
  }
  const msg =
    (res.json && (res.json.message || res.json.error_description)) ||
    `登录失败（HTTP ${res.status}）`;
  return { ok: false, message: msg };
}

/**
 * 用登录 JWT 换取绑定令牌：GET /openapi/session
 * （该端点不在安全放行名单里，必须带登录后的 JWT）
 *
 * @param {string} jwt
 * @returns {Promise<{token:string,userId:number,userName:string,expireDays:number}>}
 */
export async function exchangeSessionToken(jwt) {
  const data = await httpRequest("GET", "/openapi/session", { token: jwt });
  if (!data || !data.token) throw new Error("会话兑换失败：后端未返回绑定令牌");
  return data;
}

/**
 * 用登录凭据换取绑定令牌。
 *
 * environ 的密码契约（与前端登录页一致）：
 *   浏览器先把密码做 MD5，把 **MD5 值**放进 password 字段提交，
 *   后端再 encrypt(username, 该值) 与库里的 Upassword 比对。
 *
 * 但库里 Upassword 有两种历史格式并存：
 *   ① encrypt(name, MD5(pwd))  —— 约 37 个账号，能走 PC 端登录
 *   ② MD5(pwd)                 —— 约 4950 个账号，只能走业务登录
 * 所以按顺序尝试，覆盖两类账号：
 *
 *   ① POST /user/login（提交 MD5）→ JWT → GET /openapi/session → 绑定令牌
 *      与 PC 端登录完全同一条契约，对 ① 类账号必然成功
 *      （Spring Security 登录失败不写库，不计入 Ulocktime）
 *   ② POST /openapi/bind { password: <MD5值> } → 绑定令牌
 *      后端新契约（encrypt 体系）
 *   ③ POST /openapi/bind { passwordMd5: <MD5值> } → 绑定令牌
 *      后端支持 passwordMd5 时，对 ② 类账号有效
 *   ④ POST /openapi/bind { password: <明文> } → 绑定令牌
 *      兜底：后端还是旧契约（明文）时
 *
 * @param {{username:string, password?:string, passwordMd5?:string, plain?:string}} creds
 * @returns {Promise<{data:object, via:string}>}
 */
export async function resolveBindToken(creds) {
  const { username, password, passwordMd5, plain } = creds || {};
  // 浏览器端已经把密码做成 MD5 放在 password 字段里的情况
  const md5Value = passwordMd5 || (looksLikeMd5(password) ? password : null);
  const attempts = [];

  if (md5Value) {
    attempts.push({
      via: "user/login + openapi/session",
      run: async () => {
        const r = await loginForJwt(username, md5Value);
        if (!r.ok) throw new Error(r.message);
        return exchangeSessionToken(r.jwt);
      },
    });
    attempts.push({
      via: "openapi/bind(password=MD5)",
      run: async () => apiPost("/openapi/bind", { username, password: md5Value }),
    });
    attempts.push({
      via: "openapi/bind(passwordMd5)",
      run: async () => apiPost("/openapi/bind", { username, passwordMd5: md5Value }),
    });
  }
  // 明文兜底（后端旧契约：明文 + 后端自己做 MD5）
  const plainValue = plain || (password && password !== md5Value ? password : null);
  if (plainValue) {
    attempts.push({
      via: "openapi/bind(明文)",
      run: async () => apiPost("/openapi/bind", { username, password: plainValue }),
    });
  }
  if (!attempts.length) throw new Error("需要密码或密码哈希");

  const errors = [];
  for (const a of attempts) {
    try {
      const data = await a.run();
      if (data && data.token) return { data, via: a.via };
      errors.push(`${a.via}: 后端未返回令牌`);
    } catch (ex) {
      errors.push(`${a.via}: ${ex.message}`);
    }
  }
  throw new Error(errors.join("；"));
}

/** 是否像一个 32 位小写十六进制 MD5 */
function looksLikeMd5(v) {
  return typeof v === "string" && /^[0-9a-f]{32}$/i.test(v.trim());
}

// ==================== 站点定位 ====================

/**
 * 站点参数同时接受 ID（纯数字）与名称（模糊匹配）。
 * 这是让「查 XX 站点」这种自然语言能跑通的关键。
 */
export async function resolveStation(station, token) {
  if (station === undefined || station === null || String(station).trim() === "") {
    throw new Error("请指定要查询的站点（站点 ID 或站点名称）");
  }
  const s = String(station).trim();
  if (/^\d+$/.test(s)) {
    return { stationId: Number(s), name: null };
  }
  const data = await apiGet("/openapi/stations", { search: s, limit: 20 }, token);
  const rows = (data && data.rows) || [];
  if (!rows.length) {
    throw new Error(`没有找到名称包含「${s}」的站点。可先调用 list_stations 查看全部站点`);
  }
  const exact =
    rows.find((r) => r.name === s) ||
    rows.find((r) => (r.name || "").includes(s)) ||
    rows.find((r) => (r.num || "") === s) ||
    rows[0];
  return { stationId: exact.stationId, name: exact.name };
}

// ==================== 输出格式化 ====================

export function fmtTime(seconds) {
  if (!seconds) return "";
  const d = new Date(Number(seconds) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatItems(items) {
  if (!items || !items.length) return "  （无数据项）";
  return items
    .map((it) => {
      const unit = it.unit ? ` ${it.unit}` : "";
      const val = it.value === null || it.value === undefined ? "—" : it.value;
      return `  - ${it.name || it.code}（${it.code}）：${val}${unit}`;
    })
    .join("\n");
}

export function formatRealtime(data) {
  return [
    `站点：${data.stationName}（ID ${data.stationId}${data.stationNum ? "，编码 " + data.stationNum : ""}）`,
    `数据时间：${data.dataTimeText || fmtTime(data.dataTime)}`,
    "监测值：",
    formatItems(data.items),
  ].join("\n");
}

export function formatHour(data) {
  const rows = data.rows || [];
  const head = [
    `站点：${data.stationName}（ID ${data.stationId}）`,
    `时间范围：${fmtTime(data.beginTime)} ~ ${fmtTime(data.endTime)}`,
    `共 ${data.total} 个小时数据点`,
  ];
  if (!rows.length) {
    head.push("（该时段无数据）");
    return head.join("\n");
  }
  const body = rows.map((r) => {
    const label = r.date ? `${r.date} ${r.hour || ""}`.trim() : fmtTime(r.dataTime);
    return `[${label}]\n${formatItems(r.items)}`;
  });
  return [...head, "", ...body].join("\n");
}

export function formatOverview(data) {
  const rt = data.realtime || {};
  const hour = data.hourData || {};
  return [
    `站点：${data.stationName}（ID ${data.stationId}${data.stationNum ? "，编码 " + data.stationNum : ""}）`,
    `地址：${data.address || "—"}　在线状态：${data.online ? "在线" : "离线"}`,
    "",
    "【实时数据】",
    rt.error
      ? `  查询失败：${rt.error}`
      : `${rt.dataTimeText ? "数据时间：" + rt.dataTimeText : "（暂无实时数据）"}\n${formatItems(rt.items)}`,
    "",
    "【当日小时数据】",
    hour.error
      ? `  查询失败：${hour.error}`
      : `共 ${hour.total} 个数据点（${fmtTime(hour.beginTime)} ~ ${fmtTime(hour.endTime)}）`,
  ].join("\n");
}
