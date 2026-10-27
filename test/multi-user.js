/**
 * 多用户身份隔离测试
 *
 * 验证三件事：
 *   1) 带 X-Environ-Client 的客户端，绑定后查询的是自己的账号身份
 *   2) 没绑定的客户端**不会**借用别人的身份（不串号）
 *   3) 绑定表会落盘，容器重启不必重新绑定
 *
 * 用法：node test/multi-user.js
 * 需要能访问 environ 后端（ENVIRON_API_BASE）。
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.TEST_PORT || 3112);
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const BIND_URL = `http://127.0.0.1:${PORT}/mcp/bind`;
const AUTH = "test-auth-token";
const API_BASE = process.env.ENVIRON_API_BASE || "http://localhost:8081";
const USER = process.env.ENVIRON_USER || "18785035798";
const PASSWORD = process.env.ENVIRON_PASSWORD || "";
if (!PASSWORD) {
  console.error("请先设置 ENVIRON_PASSWORD 环境变量（该账号密码属于敏感信息，不在仓库中提供默认值）");
  process.exit(1);
}

const KEY_A = "aaaa1111aaaa1111aaaa1111aaaa1111";
const KEY_B = "bbbb2222bbbb2222bbbb2222bbbb2222";
const BINDINGS_FILE = join(tmpdir(), `environ-mcp-bindings-${process.pid}.json`);

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "\n   " + String(detail).replace(/\n/g, "\n   ") : ""}`);
  if (!ok) failed++;
}

function makeClient(clientKey) {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${AUTH}`,
        "X-Environ-Client": clientKey,
      },
    },
  });
  const client = new Client({ name: `multi-user-${clientKey.slice(0, 4)}`, version: "1.0.0" });
  return { client, transport };
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return res.content?.[0]?.text || JSON.stringify(res);
}

async function bindViaHttp(clientKey) {
  const res = await fetch(BIND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH}`,
      "X-Environ-Client": clientKey,
    },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  return { status: res.status, body: await res.json() };
}

const server = spawn(process.execPath, ["src/http-server.js"], {
  env: {
    ...process.env,
    MCP_AUTH_TOKEN: AUTH,
    MCP_PORT: String(PORT),
    MCP_HOST: "127.0.0.1",
    ENVIRON_API_BASE: API_BASE,
    ENVIRON_BINDINGS_FILE: BINDINGS_FILE,
    ALLOW_DEFAULT_BINDING: "",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 等端口起来
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }

  const { client: a, transport: ta } = makeClient(KEY_A);
  const { client: b, transport: tb } = makeClient(KEY_B);
  await a.connect(ta);
  await b.connect(tb);

  // 1. 绑定前：都应该是「未绑定」
  const beforeA = await call(a, "check_bind");
  check("客户端 A 绑定前显示未绑定", /未绑定/.test(beforeA), beforeA);

  // 2. 客户端 A 绑定
  const bindA = await bindViaHttp(KEY_A);
  check("客户端 A 绑定接口返回 200", bindA.status === 200, JSON.stringify(bindA.body));

  const afterA = await call(a, "check_bind");
  check("客户端 A 绑定后显示自己的身份", /客户端绑定/.test(afterA) && new RegExp(USER).test(afterA), afterA);

  const stationsA = await call(a, "list_stations");
  check("客户端 A 能查到自己的站点", /共\s*\d+\s*个站点/.test(stationsA), stationsA.split("\n").slice(0, 3).join("\n"));

  // 3. 关键：客户端 B 未绑定时，绝不能借用 A 的身份
  const afterB = await call(b, "check_bind");
  check("客户端 B 未绑定，不借用 A 的身份", !/18785035798|可见站点 \d+/.test(afterB) && /未绑定|尚未绑定/.test(afterB), afterB);

  const stationsB = await call(b, "list_stations");
  check("客户端 B 查询被拦住并提示绑定", /查询失败/.test(stationsB) && /bind_user/.test(stationsB), stationsB);

  // 4. 客户端 B 绑定后独立工作
  const bindB = await bindViaHttp(KEY_B);
  check("客户端 B 绑定接口返回 200", bindB.status === 200, JSON.stringify(bindB.body));
  const afterB2 = await call(b, "check_bind");
  check("客户端 B 绑定后显示自己的身份", /客户端绑定/.test(afterB2), afterB2);

  // 5. 绑定表落盘
  const saved = existsSync(BINDINGS_FILE) ? JSON.parse(readFileSync(BINDINGS_FILE, "utf8")) : null;
  check(
    "绑定表已落盘且包含两个客户端",
    !!saved && !!saved.clients?.[KEY_A] && !!saved.clients?.[KEY_B],
    saved ? `clients=${Object.keys(saved.clients || {}).length}` : "文件不存在"
  );

  // 6. 绑定页可访问
  const page = await fetch(`http://127.0.0.1:${PORT}/mcp/bind`);
  const html = await page.text();
  check("绑定页 GET /mcp/bind 返回页面", page.ok && /绑定 environ 账号/.test(html), `HTTP ${page.status}`);

  // 7. 用已有业务 token 绑定（复用登录态的路径）
  const KEY_C = "cccc3333cccc3333cccc3333cccc3333";
  const tokenResp = await fetch(`http://127.0.0.1:${PORT}/openapi-not-used`, { method: "GET" }).catch(() => null);
  void tokenResp;
  const bindTokenRes = await fetch(BIND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Environ-Client": KEY_C },
    body: JSON.stringify({ token: saved.clients[KEY_A].token, userName: USER }),
  });
  const bindTokenBody = await bindTokenRes.json();
  check("用业务 token 也能绑定", bindTokenRes.ok && bindTokenBody.ok, JSON.stringify(bindTokenBody));

  // 8. 解绑
  const unbind = await fetch(BIND_URL, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${AUTH}`, "X-Environ-Client": KEY_B },
  });
  check("解绑接口返回 200", unbind.status === 200);
  const afterUnbind = await call(b, "check_bind");
  check("解绑后客户端 B 回到未绑定", /未绑定/.test(afterUnbind), afterUnbind);

  await a.close().catch(() => {});
  await b.close().catch(() => {});
} catch (ex) {
  console.error("❌ 测试异常：", ex?.stack || ex);
  failed++;
} finally {
  server.kill();
  try {
    rmSync(BINDINGS_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
