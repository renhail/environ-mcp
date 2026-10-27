/**
 * 端到端链路测试：MCP -> environ 后端 全流程。
 *
 * 用法：
 *   MCP_AUTH_TOKEN=<令牌> node test/e2e.js <mcpBaseUrl> [真实用户名 真实密码]
 *
 * 传了账号密码则跑完整流程（bind -> stations -> realtime -> hour -> overview）；
 * 不传则只验证错误路径（错误密码应返回"用户名或密码错误"而非 500）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://127.0.0.1:3000/mcp";
const username = process.argv[3];
const password = process.argv[4];
const authToken = process.env.MCP_AUTH_TOKEN || "";

const transport = new StreamableHTTPClientTransport(new URL(base), {
  requestInit: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined,
});
const client = new Client({ name: "environ-mcp-e2e", version: "1.0.0" });

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  return { isError: !!res.isError, text };
};

try {
  await client.connect(transport);
  console.log(`✅ 已连接 ${base}\n`);

  if (username && password) {
    // ---------- 完整流程 ----------
    console.log("① bind_user …");
    const bind = await call("bind_user", { username, password });
    console.log(bind.isError ? `   ❌ ${bind.text}` : `   ✅ ${bind.text.split("\n").join("\n   ")}`);
    if (bind.isError) throw new Error("绑定失败，后续步骤跳过");

    console.log("\n② list_stations …");
    const stations = await call("list_stations", { limit: 5 });
    console.log(stations.isError ? `   ❌ ${stations.text}` : `   ${stations.text.split("\n").slice(0, 7).join("\n   ")}`);

    // 从站点列表里取第一个 ID 和一个名称
    const firstLine = stations.text.split("\n")[1] || "";
    const idMatch = firstLine.match(/ID (\d+)/);
    const nameMatch = firstLine.match(/ID \d+｜(.+?)｜/);
    const stationId = idMatch ? idMatch[1] : "814";
    const stationName = nameMatch ? nameMatch[1] : "";

    console.log(`\n③ get_realtime（按 ID ${stationId}）…`);
    const rt = await call("get_realtime", { station: stationId });
    console.log(rt.isError ? `   ❌ ${rt.text}` : `   ${rt.text.split("\n").join("\n   ")}`);

    if (stationName) {
      console.log(`\n④ get_realtime（按名称「${stationName}」）…`);
      const rtByName = await call("get_realtime", { station: stationName });
      console.log(rtByName.isError ? `   ❌ ${rtByName.text}` : `   ${rtByName.text.split("\n").join("\n   ")}`);
    }

    console.log("\n⑤ get_hour_data …");
    const hour = await call("get_hour_data", { station: stationId });
    console.log(hour.isError ? `   ❌ ${hour.text}` : `   ${hour.text.split("\n").slice(0, 8).join("\n   ")}`);

    console.log("\n⑥ get_overview …");
    const ov = await call("get_overview", { station: stationId });
    console.log(ov.isError ? `   ❌ ${ov.text}` : `   ${ov.text.split("\n").join("\n   ")}`);
  } else {
    // ---------- 只验证错误路径 ----------
    console.log("未提供账号密码，只验证错误路径。\n");
    console.log("① bind_user（故意用错误密码）…");
    const bind = await call("bind_user", { username: "__nonexistent__", password: "wrong-password" });
    console.log(`   ${bind.isError ? "✅" : "❓"} ${bind.text}`);

    console.log("\n② list_stations（未绑定状态）…");
    const stations = await call("list_stations", {});
    console.log(`   ${stations.isError ? "✅" : "❓"} ${stations.text}`);

    console.log("\n③ get_realtime（不存在的站点）…");
    const rt = await call("get_realtime", { station: "不存在的站点XYZ" });
    console.log(`   ${rt.isError ? "✅" : "❓"} ${rt.text}`);
  }
} catch (ex) {
  console.error("❌ 测试异常：", ex?.message || ex);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
