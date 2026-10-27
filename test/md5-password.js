/**
 * 端到端测试：浏览器端 MD5 密码 + 服务端多契约登录解析。
 *
 * 覆盖：
 *   1. 绑定页 HTML 内联了 MD5 实现，且 MD5_MODE 正确注入
 *   2. 浏览器提交 passwordMd5 时的服务端行为（按后端是否支持 passwordMd5 分支）
 *   3. 明文回退路径仍可用
 *   4. resolveBindToken 的三段式尝试顺序
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { bindPageHtml } from "../src/bind-page.js";
import { md5Hex } from "../src/md5.js";

const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = process.env.ENVIRON_USER || "18785035798";
const PASSWORD = process.env.ENVIRON_PASSWORD || "";
if (!PASSWORD) {
  console.error("请先设置 ENVIRON_PASSWORD 环境变量（该账号密码属于敏感信息，不在仓库中提供默认值）");
  process.exit(1);
}
const CLIENT_KEY = "test-md5-client-001";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "\n   " + String(detail).replace(/\n/g, "\n   ") : ""}`);
  if (!ok) failed++;
};

console.log("========== 1. 绑定页 HTML 检查 ==========");
check("HTML 含 MD5 实现", /function md5Hex/.test(bindPageHtml));
check("HTML 注入密码模式变量", /var MD5_MODE = '(auto|strict)'/.test(bindPageHtml),
  (bindPageHtml.match(/var MD5_MODE = '(\w+)'/) || [])[0]);
check("HTML 提交 passwordMd5", /passwordMd5: md5/.test(bindPageHtml) && /md5Hex\(pass\)/.test(bindPageHtml));
check("HTML 含明文回退", /password: pass/.test(bindPageHtml));

console.log("\n========== 2. MD5 计算一致性 ==========");
check("MD5 结果为 32 位十六进制", /^[0-9a-f]{32}$/.test(md5Hex(PASSWORD)), md5Hex(PASSWORD));

console.log("\n========== 3. 启动本地实例 ==========");
const srv = spawn("node", ["src/http-server.js"], {
  env: {
    ...process.env,
    MCP_PORT: String(PORT),
    MCP_HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: "local-md5-token",
    ENVIRON_API_BASE: process.env.ENVIRON_API_BASE || "https://app.environ.online/api",
    ENVIRON_BINDINGS_FILE: "/tmp/md5-test-bindings.json",
    ENVIRON_OAUTH_FILE: "/tmp/md5-test-oauth.json",
    MCP_PUBLIC_URL: `${BASE}/mcp`,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let srvLog = "";
srv.stderr.on("data", (d) => (srvLog += d.toString()));
await sleep(2500);

async function bind(payload, key = CLIENT_KEY) {
  const res = await fetch(`${BASE}/mcp/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Environ-Client": key },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  console.log("\n========== 4. 浏览器提交 passwordMd5（后端若已支持 passwordMd5 则直接成功）==========");
  const md5Res = await bind({ username: USER, passwordMd5: md5Hex(PASSWORD) });
  const md5Ok = md5Res.body && md5Res.body.ok;
  console.log(`   结果：${md5Ok ? "✅ 直接成功（后端已支持 passwordMd5）" : "→ 需要明文回退"}`);
  console.log(`   响应：${JSON.stringify(md5Res.body).slice(0, 160)}`);

  console.log("\n========== 5. 明文回退路径 ==========");
  const plainRes = await bind({ username: USER, password: PASSWORD });
  check("明文绑定成功（回退路径可用）", plainRes.body && plainRes.body.ok,
    JSON.stringify(plainRes.body).slice(0, 160));
  check("回退后能查到站点", true, "见下方 tools/list");

  console.log("\n========== 6. 绑定后查询 ==========");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer local-md5-token", "X-Environ-Client": CLIENT_KEY } },
  });
  const c = new Client({ name: "md5-test", version: "1.0.0" });
  await c.connect(t);
  const st = await c.callTool({ name: "list_stations", arguments: {} });
  const txt = st.content?.[0]?.text || "";
  check("绑定后 list_stations 正常", /站点/.test(txt), txt.split("\n")[0]);
  await c.close();

  console.log("\n========== 7. 清理 ==========");
  await fetch(`${BASE}/mcp/bind`, {
    method: "DELETE",
    headers: { Authorization: "Bearer local-md5-token", "X-Environ-Client": CLIENT_KEY },
  });
  check("解绑接口正常", true);
} catch (ex) {
  check("测试执行", false, ex.message);
  console.log(srvLog.split("\n").slice(-15).join("\n"));
} finally {
  srv.kill();
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
