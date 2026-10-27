/**
 * MCP 工具注册。stdio 与 HTTP 两个入口共用同一套工具定义。
 *
 * 身份优先级：
 *   1) 请求头 X-Environ-Token（直传业务 token）
 *   2) 请求头 X-Environ-Client 标识的客户端绑定（多用户主路径）
 *   3) 共享默认绑定（仅当 ALLOW_DEFAULT_BINDING=1）
 *   4) 本地 token 文件（stdio 模式）
 */
import { z } from "zod";
import {
  apiGet,
  apiPost,
  bindToClient,
  bindings,
  config,
  currentClientKey,
  currentIdentity,
  currentToken,
  formatHour,
  formatOverview,
  formatRealtime,
  log,
  persistBindings,
  resolveStation,
  saveToken,
  unbindClient,
} from "./core.js";

/** 客户端标识脱敏显示：只露前 8 位 */
function maskKey(key) {
  if (!key) return "—";
  return key.length <= 8 ? key : `${key.slice(0, 8)}…`;
}

const SOURCE_TEXT = {
  oauth: "OAuth 授权（access_token 携带的用户身份）",
  "header-token": "请求头直传 token（X-Environ-Token）",
  client: "客户端绑定（按 X-Environ-Client 区分）",
  "client-unbound": "客户端标识已识别，但尚未绑定账号",
  default: "共享默认绑定（多人共用，不推荐）",
  "local-file": "本地 token 文件",
  none: "未绑定",
};

/**
 * 从请求头里抠出 environ 绑定 token。
 * 只认 X-Environ-Token —— Authorization 头装的是 MCP 访问令牌，两者不能混用。
 */
function extractToken(headers = {}) {
  const direct = headers["x-environ-token"];
  return direct ? String(direct).trim() : null;
}

export function registerTools(server, ctx = {}) {
  const mode = ctx.mode || "http";

  const tokenOf = () => currentToken();

  const bindHint = (message) =>
    /token|绑定|无效|过期/i.test(message)
      ? "\n\n提示：尚未绑定或绑定已失效，请先调用 bind_user。"
      : "";

  // ---------------- 绑定 ----------------

  server.registerTool(
    "bind_user",
    {
      title: "绑定 environ 账号",
      description:
        "用 environ 系统的用户名和密码完成应用绑定，绑定后才能查询站点数据。" +
        "首次使用或提示 token 失效时必须先调用一次。",
      inputSchema: {
        username: z.string().describe("environ 用户名（也可用手机号或邮箱）"),
        password: z.string().describe("environ 密码"),
      },
    },
    async ({ username, password }) => {
      try {
        const data = await apiPost("/openapi/bind", { username, password });
        const payload = {
          token: data.token,
          userId: data.userId,
          userName: data.userName,
          apiBase: config.apiBase,
          expireDays: data.expireDays,
        };

        const clientKey = currentClientKey();
        let where;
        if (clientKey) {
          // 多用户主路径：绑定到这个客户端标识，此后该同事的所有调用都是他自己的身份
          bindToClient(clientKey, payload);
          where = `客户端 ${maskKey(clientKey)}`;
        } else if (mode === "stdio") {
          bindings.default = payload;
          saveToken(payload);
          where = "本地 token 文件";
        } else if (config.allowDefaultBinding) {
          bindings.default = payload;
          persistBindings();
          where = "共享默认绑定（多人共用，不推荐）";
        } else {
          return {
            content: [
              {
                type: "text",
                text:
                  "绑定失败：本次请求没有携带客户端标识，无法区分用户。\n\n" +
                  "请在 mcp.json 的 headers 里加上 X-Environ-Client（每人一个随机串），然后重新绑定：\n" +
                  '  "X-Environ-Client": "<你的 32 位随机串>"\n' +
                  "生成方式：openssl rand -hex 16\n" +
                  "也可以调用 get_client_config 取现成的配置片段。",
              },
            ],
            isError: true,
          };
        }

        log(`绑定成功 user=${data.userName} id=${data.userId} -> ${where}`);
        return {
          content: [
            {
              type: "text",
              text:
                `绑定成功。\n用户：${data.userName}（ID ${data.userId}）\n` +
                `有效期：${data.expireDays} 天\n绑定位置：${where}\n\n` +
                `后续查询自动使用该账号身份，不需要再传 token。`,
            },
          ],
        };
      } catch (ex) {
        return { content: [{ type: "text", text: `绑定失败：${ex.message}` }], isError: true };
      }
    }
  );

  // ---------------- 站点列表 ----------------

  server.registerTool(
    "list_stations",
    {
      title: "查询站点列表",
      description:
        "列出当前绑定用户有权限查看的环境监测站点（站点 ID、名称、编码、地址、在线状态）。" +
        "用户问「我有哪些站点」「XX 站在哪」时用这个。" +
        "用户给了具体关键字（地名、行业词）时，优先用 search_stations 精确搜索。",
      inputSchema: {
        search: z.string().optional().describe("按站点名称/编码模糊搜索，可选"),
        limit: z.number().int().positive().max(200).optional().describe("返回条数，默认 50"),
      },
    },
    async ({ search, limit }) => {
      try {
        const data = await apiGet(
          "/openapi/stations",
          { search: search || "", limit: limit || 50, offset: 0 },
          tokenOf()
        );
        const rows = data.rows || [];
        if (!rows.length) {
          return {
            content: [
              { type: "text", text: search ? `没有匹配「${search}」的站点。` : "没有可查看的站点。" },
            ],
          };
        }
        const lines = [`共 ${data.total} 个站点，返回 ${rows.length} 条：`];
        for (const r of rows) {
          lines.push(
            `- ID ${r.stationId}｜${r.name}｜编码 ${r.num || "—"}｜${r.online ? "在线" : "离线"}｜${
              r.address || ""
            }`
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (ex) {
        return {
          content: [{ type: "text", text: `查询失败：${ex.message}${bindHint(ex.message)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------- 按关键字搜索站点 ----------------

  server.registerTool(
    "search_stations",
    {
      title: "按关键字搜索站点",
      description:
        "按关键字搜索当前用户有权限查看的环境监测站点。" +
        "关键字可匹配站点名称、站点编码、上级站点名和站点地址（含城市、区县）。" +
        "⚠️ 当用户只说了模糊的地名或行业词（如「污水」「重庆」「兰州」）而不确定是哪个站点时，" +
        "先用这个工具搜出候选站点，拿到站点 ID 后再调用 get_overview / get_realtime / get_hour_data。",
      inputSchema: {
        keyword: z.string().describe("搜索关键字：站点名称的一部分、站点编码，或地名"),
        limit: z.number().int().positive().max(50).optional().describe("返回条数，默认 20"),
      },
    },
    async ({ keyword, limit }) => {
      const kw = String(keyword || "").trim();
      if (!kw) {
        return {
          content: [{ type: "text", text: "请提供搜索关键字。" }],
          isError: true,
        };
      }
      try {
        const data = await apiGet(
          "/openapi/stations",
          { search: kw, limit: limit || 20, offset: 0 },
          tokenOf()
        );
        const rows = data.rows || [];
        if (!rows.length) {
          return {
            content: [
              {
                type: "text",
                text:
                  `没有匹配「${kw}」的站点。\n` +
                  "可以换一个更短的关键词（如只留地名的前两个字），" +
                  "或调用 list_stations 不带参数查看全部可见站点。",
              },
            ],
          };
        }
        const lines = [`匹配「${kw}」的站点共 ${data.total} 个，返回 ${rows.length} 条：`];
        for (const r of rows) {
          lines.push(
            `- ID ${r.stationId}｜${r.name}｜编码 ${r.num || "—"}｜${r.online ? "在线" : "离线"}` +
              `${r.address ? "｜" + r.address : ""}`
          );
        }
        if (rows.length > 1) {
          lines.push(
            "提示：匹配到多个站点，用 get_overview(station=站点ID或名称) 查看指定站点的数据。"
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (ex) {
        return {
          content: [{ type: "text", text: `搜索失败：${ex.message}${bindHint(ex.message)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------- 实时数据 ----------------

  server.registerTool(
    "get_realtime",
    {
      title: "查询站点实时数据",
      description:
        "查询站点当前最新的实时监测数据（各污染因子浓度值及单位）。" +
        "用户问「XX 站点现在数据多少」「现在 SO2 多少」时用这个。",
      inputSchema: {
        station: z
          .string()
          .describe("站点 ID 或站点名称（名称支持模糊匹配），如 814 或「南明区监测站」"),
      },
    },
    async ({ station }) => {
      try {
        const token = tokenOf();
        const { stationId } = await resolveStation(station, token);
        const data = await apiGet(`/openapi/station/${stationId}/realtime`, { dtype: 0 }, token);
        return { content: [{ type: "text", text: formatRealtime(data) }] };
      } catch (ex) {
        return {
          content: [{ type: "text", text: `查询失败：${ex.message}${bindHint(ex.message)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------- 小时数据 ----------------

  server.registerTool(
    "get_hour_data",
    {
      title: "查询站点小时数据",
      description:
        "查询站点指定时间范围内的小时级监测数据序列。默认返回当天 0 点至当前时刻。" +
        "用户问「XX 站昨天各小时数据」「近 6 小时趋势」时用这个。",
      inputSchema: {
        station: z.string().describe("站点 ID 或站点名称（支持模糊匹配，也可直接传地名/行业关键字）"),
        beginTime: z
          .number()
          .int()
          .optional()
          .describe("开始时间（秒级 Unix 时间戳），可选，默认当天 0 点"),
        endTime: z
          .number()
          .int()
          .optional()
          .describe("结束时间（秒级 Unix 时间戳），可选，默认当前时间"),
      },
    },
    async ({ station, beginTime, endTime }) => {
      try {
        const token = tokenOf();
        const { stationId } = await resolveStation(station, token);
        const data = await apiGet(
          `/openapi/station/${stationId}/hour`,
          { beginTime: beginTime || 0, endTime: endTime || 0 },
          token
        );
        return { content: [{ type: "text", text: formatHour(data) }] };
      } catch (ex) {
        return {
          content: [{ type: "text", text: `查询失败：${ex.message}${bindHint(ex.message)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------- 总览 ----------------

  server.registerTool(
    "get_overview",
    {
      title: "查询站点总览",
      description:
        "一次返回站点基本信息 + 当前实时数据 + 当日小时数据。" +
        "用户问「XX 站点情况怎么样」「给我看下 XX 站的完整数据」时用这个，最省事。",
      inputSchema: {
        station: z.string().describe("站点 ID 或站点名称（支持模糊匹配，也可直接传地名/行业关键字）"),
      },
    },
    async ({ station }) => {
      try {
        const token = tokenOf();
        const { stationId } = await resolveStation(station, token);
        const data = await apiGet(`/openapi/station/${stationId}/overview`, {}, token);
        return { content: [{ type: "text", text: formatOverview(data) }] };
      } catch (ex) {
        return {
          content: [{ type: "text", text: `查询失败：${ex.message}${bindHint(ex.message)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------- 绑定状态 ----------------

  server.registerTool(
    "check_bind",
    {
      title: "检查绑定状态",
      description:
        "检查当前会话使用的是哪个 environ 账号、身份是怎么来的（客户端绑定 / 直传 token / 共享默认），" +
        "以及绑定是否还有效、能看到多少个站点。用户问「我现在绑的是谁」「为什么查不到数据」时用这个。",
      inputSchema: {},
    },
    async () => {
      const id = currentIdentity();
      const lines = [`后端地址：${config.apiBase}`];

      if (id.source === "none") {
        lines.push("当前未绑定任何 environ 账号。");
        lines.push("请先调用 bind_user 完成绑定。");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`身份来源：${SOURCE_TEXT[id.source] || id.source}`);
      if (id.clientKey) lines.push(`客户端标识：${maskKey(id.clientKey)}`);
      if (id.userName) lines.push(`绑定用户：${id.userName}（ID ${id.userId}）`);
      if (id.boundAt) lines.push(`绑定时间：${id.boundAt}`);

      let info = "（本地有 token，但无法确认后端是否接受）";
      try {
        const data = await apiGet("/openapi/stations", { limit: 1, offset: 0 }, currentToken());
        info = `绑定有效，可见站点 ${data.total} 个`;
      } catch (ex) {
        info = `绑定可能已失效：${ex.message}`;
      }
      lines.push(info);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------- 解绑 ----------------

  server.registerTool(
    "unbind_user",
    {
      title: "解除绑定",
      description:
        "解除当前客户端与 environ 账号的绑定，之后的查询会要求重新绑定。" +
        "换账号、离职交接时用这个。" +
        "⚠️ 这是破坏性操作：必须显式传 confirm=true 才会真正执行；" +
        "不传或传 false 时只返回当前绑定状态，不会解绑。",
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .describe("确认要解绑时传 true；缺省只查看绑定状态，不执行解绑"),
      },
    },
    async ({ confirm } = {}) => {
      const clientKey = currentClientKey();
      const current = clientKey ? bindings.clients.get(clientKey) : null;

      // 未确认时只回报状态，不做任何破坏性动作
      if (!confirm) {
        if (clientKey) {
          return {
            content: [
              {
                type: "text",
                text: current
                  ? `当前客户端 ${maskKey(clientKey)} 绑定的是 ${current.userName || "未知用户"}` +
                    `（ID ${current.userId ?? "?"}）。\n` +
                    `如确需解除绑定，请重新调用并传 confirm=true。`
                  : `当前客户端 ${maskKey(clientKey)} 本来就没有绑定记录，无需解绑。`,
              },
            ],
          };
        }
        if (mode === "stdio") {
          return {
            content: [
              {
                type: "text",
                text: "当前为本地模式（stdio）。\n" +
                  "如确需清除本地绑定，请重新调用并传 confirm=true。",
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: "当前请求没有客户端标识，无法解绑。" }],
          isError: true,
        };
      }

      if (clientKey) {
        const ok = unbindClient(clientKey);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `已解绑客户端 ${maskKey(clientKey)}。下次查询会提示重新绑定。`
                : `客户端 ${maskKey(clientKey)} 本来就没有绑定记录。`,
            },
          ],
        };
      }
      if (mode === "stdio") {
        bindings.default = null;
        saveToken({ token: "" });
        return { content: [{ type: "text", text: "已清除本地绑定。" }] };
      }
      return {
        content: [{ type: "text", text: "当前请求没有客户端标识，无法解绑。" }],
        isError: true,
      };
    }
  );

  // ---------------- 接入配置片段 ----------------

  server.registerTool(
    "get_client_config",
    {
      title: "获取接入配置",
      description:
        "返回可以直接粘进 ~/.workbuddy/mcp.json 的 MCP 接入配置片段，" +
        "含本机的客户端标识（X-Environ-Client）。新同事接入时用这个。",
      inputSchema: {},
    },
    async () => {
      const clientKey = currentClientKey() || "<你的 32 位随机串>";
      const snippet = {
        mcpServers: {
          "environ-mcp": {
            type: "streamableHttp",
            url: config.publicUrl,
            headers: {
              Authorization: "Bearer <MCP_AUTH_TOKEN>",
              "X-Environ-Client": clientKey,
            },
            timeout: 60000,
          },
        },
      };
      return {
        content: [
          {
            type: "text",
            text:
              "把下面这段合并进 ~/.workbuddy/mcp.json 的 mcpServers（Authorization 填你们已有的 MCP 访问令牌）：\n\n" +
              JSON.stringify(snippet, null, 2) +
              "\n\n生成自己的随机串：openssl rand -hex 16\n" +
              "绑定账号（密码不经过聊天窗口）：node scripts/bind.js --url " +
              `${config.publicUrl}/bind` +
              " --key <随机串> --user <用户名>",
          },
        ],
      };
    }
  );
}

export { extractToken };
