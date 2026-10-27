/**
 * HTTP 传输冒烟测试：验证 MCP 协议在 Streamable HTTP 下可握手、可列工具、可调用。
 * 用法：node test/http-smoke.js [baseUrl]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://127.0.0.1:3111/mcp";
const authToken = process.env.MCP_AUTH_TOKEN || "";

const transport = new StreamableHTTPClientTransport(new URL(base), {
  requestInit: authToken
    ? { headers: { Authorization: `Bearer ${authToken}` } }
    : undefined,
});

const client = new Client({ name: "environ-mcp-http-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("✅ HTTP 传输握手成功\n");

  const { tools } = await client.listTools();
  console.log(`✅ 工具列表（${tools.length} 个）：${tools.map((t) => t.name).join(", ")}\n`);

  const res = await client.callTool({ name: "check_bind", arguments: {} });
  console.log("✅ check_bind 调用结果：");
  console.log("   " + (res.content?.[0]?.text || JSON.stringify(res)).replace(/\n/g, "\n   "));
} catch (ex) {
  console.error("❌ 测试失败：", ex?.message || ex);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
