/**
 * MCP Server Card（SEP-1649 静态元数据）
 *
 * 放在 /.well-known/mcp/server-card.json，用于目录站（Smithery / Glama 等）
 * 在无法自动扫描（OAuth 鉴权墙挡住）时，直接读取这份静态卡片生成服务页面。
 *
 * 约定：
 *   - 里面只放公开元数据，**绝不包含任何令牌或凭据**
 *   - 工具清单要与实际注册的工具保持一致（test/server-card.test.js 会校验数量）
 */

/** 与 src/tools.js 中注册的工具一一对应 */
const TOOL_CARDS = [
  {
    name: "bind_user",
    description: "用 environ 系统的用户名和密码完成应用绑定，绑定后才能查询站点数据。",
    inputSchema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" } }, required: ["username", "password"] },
  },
  {
    name: "list_stations",
    description: "列出当前绑定用户有权限查看的环境监测站点；支持按名称/编码模糊搜索。",
    inputSchema: { type: "object", properties: { search: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "get_realtime",
    description: "查询站点当前最新的实时监测数据（各污染因子浓度值及单位）。",
    inputSchema: { type: "object", properties: { station: { type: "string" } }, required: ["station"] },
  },
  {
    name: "get_hour_data",
    description: "查询站点指定时间范围内的小时级监测数据序列，默认当天 0 点至今。",
    inputSchema: { type: "object", properties: { station: { type: "string" }, beginTime: { type: "number" }, endTime: { type: "number" } }, required: ["station"] },
  },
  {
    name: "get_overview",
    description: "一次返回站点基本信息 + 当前实时数据 + 当日小时数据，最省事。",
    inputSchema: { type: "object", properties: { station: { type: "string" } }, required: ["station"] },
  },
  {
    name: "check_bind",
    description: "检查当前会话使用的是哪个 environ 账号、绑定是否有效、能看到多少站点。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "unbind_user",
    description: "解除当前客户端与 environ 账号的绑定（破坏性操作，需 confirm=true）。",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
  },
  {
    name: "get_client_config",
    description: "返回可直接粘进 ~/.workbuddy/mcp.json 的 MCP 接入配置片段。",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * 生成 Server Card
 * @param {{version:string, publicUrl:string}} opts
 */
export function buildServerCard(opts) {
  return {
    serverInfo: {
      name: "environ-mcp",
      version: opts.version || "1.0.0",
      title: "environ 环境监测数据查询",
      description:
        "查询环境监测站点的实时数据、小时数据与站点总览。支持按站点名称或关键字模糊匹配。",
    },
    authentication: {
      required: true,
      schemes: ["oauth2"],
    },
    tools: TOOL_CARDS,
    resources: [],
    prompts: [],
    websiteUrl: opts.publicUrl || "https://app.environ.online",
  };
}

export { TOOL_CARDS };
