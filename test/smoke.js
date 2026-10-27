/**
 * 冒烟测试：用 MCP Client 通过 stdio 连接本地 server，验证工具注册与调用链路。
 * 用法：node test/smoke.js
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env },
  stderr: "inherit",
});

const client = new Client({ name: "environ-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  console.log("✅ MCP 握手成功\n");

  const { tools } = await client.listTools();
  console.log(`✅ 工具列表（${tools.length} 个）：`);
  for (const t of tools) {
    console.log(`   - ${t.name}  ${t.title || ""}`);
    const props = Object.keys(t.inputSchema?.properties || {});
    console.log(`     参数：${props.length ? props.join(", ") : "（无）"}`);
  }
  console.log("");

  // 调一个无副作用的工具验证调用链路
  const res = await client.callTool({ name: "check_bind", arguments: {} });
  console.log("✅ check_bind 调用结果：");
  console.log("   " + (res.content?.[0]?.text || JSON.stringify(res)).replace(/\n/g, "\n   "));
} catch (ex) {
  console.error("❌ 测试失败：", ex);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
